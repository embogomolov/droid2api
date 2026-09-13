// Explicit opt-in only. Small synthetic requests; never loads conversation history.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { resetConnection } from '../utils/factory-sessions.js';
import { fetchBillingLimits, getLimitState } from '../utils/factory-limits.js';
import { getOpenAIHeaders } from '../transformers/request-openai.js';
import { getSystemPrompt } from '../config.js';

assert.equal(process.argv[2], '--live', 'Requires explicit --live authorization');
const mode = process.argv[3] || 'cache';
assert.ok(['cache', 'session', 'proxy'].includes(mode));
const MODEL = 'gpt-5.6-luna';
const outputDir = mkdtempSync(join(tmpdir(), 'factory-luna-live-'));
const keys = JSON.parse(readFileSync(new URL('../data/key_pool.json', import.meta.url))).keys.slice(0, 2);
assert.equal(keys.length, 2);
const report = { model: MODEL, mode, startedAt: new Date().toISOString(), calls: [] };
const nonce = randomUUID();
const payload = `Unique experiment ${nonce}\n` + Array.from({ length: 220 }, (_, i) => `Entry ${i}: alpha beta gamma delta epsilon.`).join('\n');
const base = { model: MODEL, instructions: getSystemPrompt() + '\nFor this transport test, reply exactly OK unless the last user asks for a marker.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: payload + '\nReply OK.' }] }],
  reasoning: { effort: 'none' }, max_output_tokens: 32, stream: false, store: false, prompt_cache_key: nonce };
const sessions = [];
let sent = 0;
const save = () => writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
const snapshot = async () => {
  const values = [];
  for (const key of keys) {
    const billing_limits = await fetchBillingLimits(key.key);
    const state = getLimitState({ billing_limits });
    values.push({ keyId: key.id, limits: billing_limits.limits, available: state.available });
  }
  return values;
};
async function call(label, account, body, session) {
  assert.equal(body.model, MODEL);
  assert.ok(++sent <= 8, 'Hard cap: eight physical test calls per invocation');
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 30_000, 'Small payload only');
  const row = { label, account: account + 1, requestedModel: body.model };
  report.calls.push(row);
  const headers = getOpenAIHeaders(`Bearer ${keys[account].key}`, { 'x-session-id': nonce });
  const response = await fetchFactoryWebSocket('wss://api.factory.ai/api/llm/o/v1/responses/ws', {
    headers, body, session, signal: AbortSignal.timeout(45_000),
    onUsage: usage => { row.transport = usage; save(); }
  });
  row.status = response.status;
  const data = await response.json();
  if (!response.ok) { row.error = data; save(); throw new Error(`Luna probe ${label}: HTTP ${response.status}`); }
  row.returnedModel = data.model;
  row.text = (data.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
  row.usage = data.usage; row.responseStatus = data.status;
  assert.equal(data.model, MODEL, 'Do not silently substitute a different model');
  save(); console.log(JSON.stringify(row));
  return data;
}
try {
  report.before = await snapshot(); save();
  console.log(JSON.stringify({ model: MODEL, before: report.before }));
  assert.ok(report.before.every(s => s.available), 'Both accounts must have quota');
  if (mode === 'cache') {
    await call('A-cold', 0, base);
    await call('A-repeat', 0, base);
    await call('B-same-prefix-and-cache-key', 1, base);
    await call('B-repeat', 1, base);
  } else if (mode === 'session') {
    const session = {}; sessions.push(session);
    const first = await call('session-start', 0, base, session);
    const socket = session.socket;
    const next = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply marker LUNA_DELTA.' }] };
    const continued = { ...base, input: [...base.input, ...first.output, next] };
    const second = await call('session-delta', 0, continued, session);
    assert.equal(session.socket, socket, 'Same live connection');
    assert.equal(report.calls.at(-1).transport.contextMode, 'delta');
    assert.match(second.output.flatMap(x => x.content || []).map(x => x.text || '').join(''), /LUNA_DELTA/);
    const edited = { ...base, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply marker LUNA_EDIT.' }] }] };
    await call('edited-history', 0, edited, session);
    assert.equal(report.calls.at(-1).transport.contextMode, 'full');
    await call('account-change-full-context', 1, continued, session);
    assert.equal(report.calls.at(-1).transport.contextMode, 'full');
    resetConnection(session);
    await call('reconnect-full-context', 1, continued, session);
    assert.equal(report.calls.at(-1).transport.contextMode, 'full');
    const warm = await call('explicit-warmup', 1, { ...base, input: [{ role: 'user', content: 'Remember marker LUNA_WARM.' }], generate: false }, session);
    assert.deepEqual(warm.output, []);
    await call('warmup-continuation', 1, { ...base, input: [{ role: 'user', content: 'Reply with the remembered marker.' }], previous_response_id: warm.id }, session);
  } else {
    const { parse } = await import('dotenv');
    const env = parse(readFileSync(new URL('../.env', import.meta.url)));
    const stats = async () => {
      const response = await fetch('http://127.0.0.1:3000/admin/stats/full', { headers: { 'x-admin-key': env.ADMIN_ACCESS_KEY } });
      assert.equal(response.status, 200);
      return (await response.json()).data.factory_transport || { total: {}, by_key: {} };
    };
    report.proxyBefore = await stats();
    const proxyCall = async (label, body) => {
      assert.equal(body.model, MODEL);
      assert.ok(++sent <= 2);
      const response = await fetch('http://127.0.0.1:3000/v1/responses', {
        method: 'POST', headers: { authorization: `Bearer ${env.API_ACCESS_KEY}`, 'content-type': 'application/json', 'thread-id': nonce },
        body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(45_000)
      });
      const text = await response.text();
      assert.equal(response.status, 200, text.slice(0, 400));
      const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } });
      const data = events.find(e => e?.type === 'response.completed')?.response;
      assert.ok(data, 'SSE must complete'); assert.equal(data.model, MODEL);
      const row = { label, account: 'proxy pool', returnedModel: data.model, usage: data.usage,
        outputTypes: data.output.map(i => i.type), text: data.output.flatMap(i => i.content || []).map(i => i.text || '').join('') };
      report.calls.push(row); save(); console.log(JSON.stringify(row)); return data;
    };
    const withTools = { ...base, max_output_tokens: 96,
      instructions: getSystemPrompt() + '\nCall lookup once with no arguments. After receiving its result, reply with that marker only.',
      tools: [{ type: 'function', name: 'lookup', description: 'Gets the test marker', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true }], tool_choice: 'auto' };
    const first = await proxyCall('proxy-tool-call', withTools);
    const tool = first.output.find(i => i.type === 'function_call'); assert.ok(tool);
    const second = await proxyCall('proxy-tool-result-delta', { ...withTools, input: [...base.input, ...first.output,
      { type: 'function_call_output', call_id: tool.call_id, output: 'LUNA_PROXY_OK' }] });
    assert.match(second.output.flatMap(i => i.content || []).map(i => i.text || '').join(''), /LUNA_PROXY_OK/);
    report.proxyAfter = await stats();
    const before = report.proxyBefore.total, after = report.proxyAfter.total;
    assert.equal((after.requests || 0) - (before.requests || 0), 2);
    assert.equal((after.delta_requests || 0) - (before.delta_requests || 0), 1);
    assert.equal((after.warmups || 0) - (before.warmups || 0), 0);
    const usedKeys = Object.keys(report.proxyAfter.by_key).filter(id =>
      report.proxyAfter.by_key[id].requests > (report.proxyBefore.by_key[id]?.requests || 0));
    assert.equal(usedKeys.length, 1, 'Both proxy requests stay on the same account');
    report.proxyCheck = { requests: 2, deltaRequests: 1, warmups: 0, keyId: usedKeys[0] };
    console.log(JSON.stringify(report.proxyCheck));
  }
} catch (error) {
  report.failure = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const session of sessions) resetConnection(session);
  report.after = await snapshot().catch(error => ({ error: error.message }));
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ after: report.after, report: join(outputDir, 'report.json') }));
}
