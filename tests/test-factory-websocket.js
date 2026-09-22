// Offline: real HTTP -> proxy -> WebSocket with synthetic accounts and responses.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import pool from '../auth.js';
import { getConfig } from '../config.js';
import { factoryWebSocketUrl, fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { writeResponseChunk } from '../utils/route-common.js';
import { clearFactorySessions, getFactorySession, resetConnection, itemFingerprint, fingerprintChanges } from '../utils/factory-sessions.js';

process.env.DROID2API_STATS_FILE = join(mkdtempSync(join(tmpdir(), 'factory-offline-')), 'stats.json');
const { default: router } = await import('../routes.js');
const { getStats } = await import('../utils/request-stats.js');

const cfg = getConfig(), savedConfig = structuredClone(cfg), savedPool = { ...pool };
const fixedKey = process.env.FACTORY_API_KEY;
delete process.env.FACTORY_API_KEY;
const sockets = new Set();
let frames = [], scenario = 'ok', attempts = [], httpCalls = 0, connectionCount = 0, cutoffReached = false;
const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });
const upstream = http.createServer(async (req, res) => {
  httpCalls++;
  if (scenario !== 'http-ok') { res.writeHead(500).end('Unexpected HTTP fallback'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  const response = { id: 'http_result', model: request.model, status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 0 } };
  if (request.stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
  else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
});
upstream.on('upgrade', (req, socket, head) => {
  const id = req.headers.authorization?.replace('Bearer fake-', '');
  attempts.push(id);
  if(scenario==='window-cutoff'&&id==='a')cutoffReached=true;
  if (scenario === 'handshake-401' && id === 'a') {
    const body = '{"error":"invalid credential"}';
    socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    const connection = ++connectionCount;
    sockets.add(ws); ws.once('close', () => sockets.delete(ws));
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString()); frames.push({ id, request, connection });
      if (scenario === 'wait') return;
      if (scenario === 'drop') { ws.terminate(); return; }
      if (scenario === 'malformed') { ws.send('{bad JSON'); return; }
      if (request.generate === false) { ws.send(JSON.stringify({ type: 'response.completed', response: { id: 'warm_' + frames.length, status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 20 } } } })); return; }
      if (scenario === 'missing-context' && request.previous_response_id) {
        ws.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'previous_response_not_found' } })); return;
      }
      const status = scenario.startsWith('first-') && id === 'a' ? Number(scenario.slice(6))
        : scenario.startsWith('all-') ? Number(scenario.slice(4)) : 0;
      if (status) { ws.send(JSON.stringify({ type: 'error', status, headers: { 'retry-after': '3' }, error: { message: `simulated ${status}` } })); return; }
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } }));
      if (scenario === 'partial-close') { ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }), () => ws.close()); return; }
      if (scenario === 'accepted-error') { ws.send(JSON.stringify({ type: 'error', status: 500, error: { message: 'accepted then failed' } })); return; }
      const content = [{ type: 'output_text', text: 'OK' }];
      ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' }));
      const result = { id: 'resp_' + frames.length, model: request.model, status: scenario === 'incomplete' ? 'incomplete' : 'completed',
        usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } },
        instructions: request.instructions, output: [{ type: 'message', role: 'assistant', content }] };
      if (scenario === 'codex-output') result.output = [
        { type: 'reasoning', id: 'rs_test', status: 'completed', summary: [], encrypted_content: 'opaque-test' },
        { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.', annotations: [], logprobs: [] }] },
        { type: 'function_call', id: 'fc_test', status: 'completed', name: 'lookup', arguments: '{}', call_id: 'call_test' }
      ];
      if (scenario === 'tools') result.output = [{ type: 'function_call', name: 'lookup', call_id: 'call_test', arguments: '{"x":1}' }];
      if (scenario === 'custom-tool') result.output = [{ type: 'custom_tool_call', id: 'ctc_test', status: 'completed', namespace: null, name: 'lookup', call_id: 'call_test', input: '{}' }];
      if (scenario === 'event-difference') result.output = [{ type: 'reasoning', id: 'rs_diagnostic', summary: [], content: [],
        encrypted_content: 'terminal-private-fixture', metadata: { turn_id: 'private fixture' } }];
      result.output.forEach((item, output_index) => ws.send(JSON.stringify({ type: 'response.output_item.done', output_index,
        item: scenario === 'event-difference' ? { ...item, encrypted_content: 'stream-private-fixture' } : item })));
      ws.send(JSON.stringify({ type: `response.${result.status}`, response: result }));
    });
  });
});
let server;
const reset = (algorithm = 'round-robin') => {
  clearFactorySessions();
  pool.keys = ['a', 'b'].map(id => ({ id, key: `fake-${id}`, status: 'active', last_test_result: 'success' }));
  pool.stats = {}; pool.poolGroups = [];
  pool.config = { ...savedPool.config, algorithm, multiTier: { enabled: false } };
  pool.saveKeyPool = pool.saveKeyPoolImmediately = async () => {};
  pool.refreshBillingLimits = async () => {};
  frames = []; attempts = []; scenario = 'ok';
};
try {
  assert.equal(factoryWebSocketUrl('https://app.factory.ai/api/llm/o/v1/responses'), 'wss://api.factory.ai/api/llm/o/v1/responses/ws');
  assert.equal(factoryWebSocketUrl('https://api.eu.factory.ai/api/llm/o/v1/responses'), 'wss://api.eu.factory.ai/api/llm/o/v1/responses/ws');
  assert.equal(factoryWebSocketUrl('https://example.com/v1/responses'), null);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  cfg.endpoint.find(e => e.name === 'openai').base_url = `ws://127.0.0.1:${upstream.address().port}/responses/ws`;
  const app = express(); app.use(express.json({ limit: '50mb' })); app.use(router);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const call = (body, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', input: 'OK', ...body }), ...options,
    headers: { 'content-type': 'application/json', ...options.headers }
  });
  reset();
  const savedSync=pool.windowSync;let outstanding=0,tracked=0;
  try {
    scenario='window-cutoff';cutoffReached=false;
    pool.windowSync={routingBlock:key=>key.id==='a'&&cutoffReached?'Window ending':null,
      trackRequest:()=>{outstanding++;tracked++;let done=false;return()=>{if(!done){done=true;outstanding--;}};}};
    const guarded=await call({stream:false});assert.equal(guarded.status,200);await guarded.text();
    assert.deepEqual(frames.map(f=>f.id),['b'],'A cutoff during handshake sends no model frame to the first account');
    assert.equal(tracked,1);assert.equal(outstanding,0,'Request drain tracking ends when the response finishes');
  }finally{pool.windowSync=savedSync;}
  reset();
  const history = [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(6 * 1024 * 1024) + 'Keep this ending' }] }];
  const response = await call({ input: history, instructions: 'Custom Codex instructions', reasoning: { effort: 'high' }, stream: false,
    previous_response_id: 'resp_previous', include: ['reasoning.encrypted_content'], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, 'OK');
  const sent = frames[0].request;
  assert.equal(sent.type, 'response.create'); assert.equal(sent.stream, undefined);
  assert.equal(sent.previous_response_id, 'resp_previous');
  assert.equal(sent.reasoning.effort, 'high'); assert.equal(sent.tools[0].name, 'lookup');
  assert.deepEqual(sent.include, ['reasoning.encrypted_content']); assert.ok(sent._factory.assistantMessageId);
  assert.ok(sent.instructions.endsWith('Custom Codex instructions'));
  assert.equal(createHash('sha256').update(JSON.stringify(sent.input)).digest('hex'), createHash('sha256').update(JSON.stringify(history)).digest('hex'));
  reset();
  const pieces = Array.from({ length: 4 }, (_, index) => ({ type: 'input_text', text: String(index).repeat(3 * 1024 * 1024) }));
  const largeMessage = [{ type: 'message', id: 'user_large', role: 'user', content: pieces }];
  const batched = await call({ input: largeMessage, stream: true });
  const batchText = await batched.text(); assert.match(batchText, /response.completed/);
  assert.equal(frames.length, 1, 'native transport sends one request, never paid warm-up batches');
  assert.deepEqual(frames[0].request.input, largeMessage);
  assert.equal(frames[0].request.generate, undefined);
  assert.equal((batchText.match(/event: response.completed/g) || []).length, 1);
  reset();
  const streamed = await call({ stream: true }); const text = await streamed.text();
  assert.match(text, /event: response.created/); assert.match(text, /event: response.output_text.delta/); assert.match(text, /event: response.completed/);
  for (const mode of ['incomplete', 'tools']) {
    reset(); scenario = mode; const result = await (await call({ stream: false })).json();
    if (mode === 'incomplete') assert.equal(result.status, 'incomplete');
    else assert.equal(result.output[0].call_id, 'call_test');
  }
  for (const mode of ['handshake-401', 'first-401', 'first-402', 'first-429']) {
    reset(); scenario = mode; const r = await call({ stream: true });
    assert.equal(r.status, 200, mode); assert.match(await r.text(), /response.completed/);
    assert.deepEqual(attempts, ['a', 'b']);
    assert.equal(pool.keys[0].status, mode.includes('401') ? 'disabled' : 'active');
  }
  for (const status of [400, 403, 429]) {
    reset(); scenario = `all-${status}`; const r = await call();
    assert.equal(r.status, status); assert.equal(r.headers.get('retry-after'), '3'); await r.text();
    assert.equal(attempts.length, status === 429 ? 2 : 1);
  }
  for (const mode of ['malformed', 'drop']) {
    reset(); scenario = mode; const r = await call(); assert.equal(r.status, 502); await r.text(); assert.equal(attempts.length, 1);
  }
  reset(); scenario = 'accepted-error';
  const failed = await call(); assert.equal(failed.status, 500); await failed.text(); assert.equal(attempts.length, 1);
  reset(); scenario = 'accepted-error';
  const streamedError = await call({ stream: true }); assert.match(await streamedError.text(), /accepted then failed/); assert.equal(attempts.length, 1);
  reset(); scenario = 'partial-close';
  await assert.rejects(async () => { const r = await call({ stream: true }); await r.text(); }); assert.equal(attempts.length, 1);
  reset(); scenario = 'wait';
  const controller = new AbortController(); const pending = call({ stream: true }, { signal: controller.signal });
  while (!frames.length) await delay(5);
  controller.abort(); await assert.rejects(pending);
  for (let i = 0; i < 100 && sockets.size; i++) await delay(10);
  assert.equal(sockets.size, 0, 'cancellation and completion close all upstream sockets');
  reset();
  const parallel = await Promise.all([call({ input: 'first' }), call({ input: 'second' })]);
  await Promise.all(parallel.map(r => r.text()));
  assert.deepEqual(new Set(frames.map(f => f.id)), new Set(['a', 'b']));
  assert.deepEqual(new Set(frames.map(f => f.request.input)), new Set(['first', 'second']));
  reset();
  const task = id => ({ headers: { 'thread-id': id, 'session-id': 'shared-session' } });
  const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const initial = [user('initial')], next = user('next');
  const rotatedA = await (await call({ input: initial }, task('rotation'))).json();
  const rotatedHistory = [...initial, ...rotatedA.output, next];
  const rotatedB = await (await call({ input: rotatedHistory }, task('rotation'))).json();
  const rotatedAgain = [...rotatedHistory, ...rotatedB.output, user('third')];
  await (await call({ input: rotatedAgain }, task('rotation'))).text();
  assert.deepEqual(frames.map(f => f.id), ['a', 'b', 'a'], 'same task follows round-robin for every request');
  assert.deepEqual(frames[1].request.input, rotatedHistory);
  assert.deepEqual(frames[2].request.input, rotatedAgain);
  assert.ok(frames.every(f => f.request.previous_response_id === undefined), 'rotated accounts never inherit a socket response ID');
  assert.equal(new Set(frames.map(f => f.connection)).size, 3);
  assert.ok(frames[0].request.prompt_cache_key);
  assert.equal(new Set(frames.map(f => f.request.prompt_cache_key)).size, 1, 'account rotation preserves cache identity');
  reset('max-remaining'); // An explicit policy can select the same eligible account again.
  const first = await (await call({ input: initial }, task('continuation'))).json();
  const full = [...initial, ...first.output, next];
  await (await call({ input: full, stream: true }, task('continuation'))).text();
  assert.equal(frames[1].id, frames[0].id);
  assert.equal(frames[1].connection, frames[0].connection);
  assert.deepEqual(frames[1].request.input, [next]);
  assert.equal(frames[1].request.previous_response_id, first.id);
  await (await call({ input: initial }, task('other-task'))).text();
  assert.equal(frames[2].id, frames[0].id, 'max-remaining policy selects the same account when headroom ties');
  assert.notEqual(frames[2].connection, frames[0].connection, 'shared session header does not merge tasks');
  const edited = [user('edited history')];
  pool.config.algorithm = 'round-robin'; pool.stats.last_rotation_index = 1;
  await (await call({ input: edited }, task('continuation'))).text();
  assert.deepEqual(frames.at(-1).request.input, edited);
  assert.equal(frames.at(-1).request.previous_response_id, undefined);
  assert.equal(frames.at(-1).id, 'b', 'policy changes immediately affect existing tasks');
  reset('max-remaining'); scenario = 'codex-output';
  await (await call({ input: initial }, task('codex'))).text();
  const replay = [
    { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-test', content: null },
    { type: 'message', id: 'msg_test', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] },
    { type: 'function_call', id: 'fc_test', name: 'lookup', arguments: '{}', call_id: 'call_test' }
  ];
  const toolResult = { type: 'function_call_output', id: 'fco_test', call_id: 'call_test', output: 'done' };
  await (await call({ input: [...initial, ...replay, toolResult] }, task('codex'))).text();
  assert.deepEqual(frames[1].request.input, [toolResult], 'matches installed Codex output serialization');
  reset('max-remaining'); scenario = 'codex-output';
  await (await call({ input: initial }, task('edited-reasoning'))).text();
  const changed = structuredClone(replay); changed[0].encrypted_content = 'changed';
  await (await call({ input: [...initial, ...changed, toolResult] }, task('edited-reasoning'))).text();
  assert.equal(frames[1].request.previous_response_id, undefined, 'reasoning edits invalidate chain');
  reset('max-remaining'); scenario = 'custom-tool';
  await (await call({ input: initial }, task('custom'))).text();
  const customReplay = { type: 'custom_tool_call', id: 'ctc_test', status: 'completed', name: 'lookup', call_id: 'call_test', input: '{}' };
  const customResult = { type: 'custom_tool_call_output', call_id: 'call_test', output: 'OK' };
  await (await call({ input: [...initial, customReplay, customResult] }, task('custom'))).text();
  assert.equal(frames[1].connection, frames[0].connection, 'namespace:null omission must not discard connection');
  assert.deepEqual(frames[1].request.input, [customResult]);
  reset('max-remaining'); scenario = 'event-difference';
  const reports = [], diagnosticSession = {};
  const diagnosticCall = async (input, stream = true) => {
    const response = await fetchFactoryWebSocket(`ws://127.0.0.1:${upstream.address().port}/responses/ws`, {
      headers: { authorization: 'Bearer fake-a', 'x-session-id': 'diagnostic-fixture' }, body: { model: 'gpt-6-astra', input, stream },
      session: diagnosticSession, onUsage: report => reports.push(report)
    });
    return response.text();
  };
  try {
    await diagnosticCall(initial);
    assert.deepEqual(reports[0].streamOutputDifferences, [{ index: 0, differences: [{ path: '/encrypted_content', expected: 'string', actual: 'string' }] }]);
    const reasoningReplay = { type: 'reasoning', id: 'rs_diagnostic', summary: [], encrypted_content: 'stream-private-fixture' };
    await diagnosticCall([...initial, reasoningReplay, next]);
    assert.equal(reports[1].reuseReason, 'matched_prefix', 'stream replay uses output_item.done ciphertext and drops Factory metadata');
    assert.deepEqual(frames[1].request.input, [next]);
    assert.equal(frames[1].connection, frames[0].connection);
    resetConnection(diagnosticSession);
    await diagnosticCall(initial);
    await diagnosticCall([...initial, { ...reasoningReplay, encrypted_content: 'client-edited-private-fixture' }, next]);
    const mismatch = reports[3].historyMismatch;
    assert.equal(mismatch.region, 'previous_output');
    assert.equal(mismatch.outputIndex, 0);
    assert.deepEqual(mismatch.candidates.find(c => c.source === 'output_item_done_codex').differences, [{ path: '/encrypted_content', expected: 'string', actual: 'string' }]);
    assert.equal(frames[3].request.previous_response_id, undefined, 'actual reasoning edits still invalidate chaining');
    await diagnosticCall([]);
    assert.equal(reports[4].historyMismatch.region, 'previous_input', 'shortened history is diagnosed without crashing');
    resetConnection(diagnosticSession);
    const jsonResponse = JSON.parse(await diagnosticCall(initial, false));
    await diagnosticCall([...initial, ...jsonResponse.output, next], false);
    assert.equal(reports[6].reuseReason, 'matched_prefix', 'non-streaming callers still replay completed.output');
    const before = itemFingerprint({ content: [{ text: 'private fixture A' }] });
    const after = itemFingerprint({ content: [{ text: 'private fixture B' }] });
    assert.deepEqual(fingerprintChanges(before, after), [{ path: '/content/0/text', expected: 'string', actual: 'string' }]);
    assert.ok(!JSON.stringify(before).includes('private fixture'));
    assert.ok(!JSON.stringify(reports).includes('private fixture'));
    assert.ok(Object.keys(itemFingerprint(Array.from({ length: 1000 }, () => ({ text: 'bounded' })))).length <= 128);
  } finally { resetConnection(diagnosticSession); }
  reset('max-remaining');
  const start = await (await call({ input: initial }, task('quota'))).json();
  scenario = 'first-429';
  const migrated = await call({ input: [...initial, ...start.output, next] }, task('quota'));
  assert.equal(migrated.status, 200); await migrated.text();
  assert.deepEqual(frames.map(f => f.id), ['a', 'a', 'b']);
  assert.equal(frames[1].request.previous_response_id, start.id);
  assert.equal(frames[2].request.previous_response_id, undefined);
  assert.deepEqual(frames[2].request.input, [...initial, ...start.output, next]);
  reset('max-remaining');
  const beforeMissing = await (await call({ input: initial }, task('missing'))).json();
  scenario = 'missing-context';
  await (await call({ input: [...initial, ...beforeMissing.output, next] }, task('missing'))).text();
  assert.equal(frames.length, 3, 'one explicit context-not-found recovery');
  assert.equal(frames[2].request.previous_response_id, undefined);
  assert.equal(frames[2].id, 'a');
  reset('max-remaining');
  const stable = await (await call({ input: initial }, task('server-error'))).json();
  scenario = 'first-503';
  const serverFailure = await call({ input: [...initial, ...stable.output, next] }, task('server-error'));
  assert.equal(serverFailure.status, 503); await serverFailure.text();
  assert.equal(frames.length, 2, 'server error does not replay an ambiguous task request');
  scenario = 'ok';
  await (await call({ input: initial }, task('server-error'))).text();
  assert.equal(frames.at(-1).id, 'a');
  reset('max-remaining');
  const configured = await (await call({ input: initial, instructions: 'one' }, task('settings'))).json();
  await (await call({ input: [...initial, ...configured.output, next], instructions: 'two' }, task('settings'))).text();
  assert.equal(frames[1].request.previous_response_id, configured.id, 'native chaining accepts current settings with matching history');
  assert.ok(frames[1].request.instructions.endsWith('two'));
  assert.equal(frames[1].id, 'a');
  reset('max-remaining');
  const beforeDrop = await (await call({ input: initial }, task('drop'))).json();
  scenario = 'drop';
  assert.equal((await call({ input: [...initial, ...beforeDrop.output, next] }, task('drop'))).status, 502);
  assert.equal(frames.length, 2, 'no ambiguous replay');
  scenario = 'ok';
  await (await call({ input: initial }, task('drop'))).text();
  assert.equal(frames.at(-1).request.previous_response_id, undefined);
  assert.equal(frames.at(-1).id, 'a', 'network drop does not change the configured selection policy');
  reset('max-remaining');
  const beforeLarge = getStats().factory_transport.total;
  const largeResult = await (await call({ input: largeMessage }, task('large'))).json();
  const initialFrames = frames.length;
  await (await call({ input: [...largeMessage, ...largeResult.output, next] }, task('large'))).text();
  assert.equal(frames.length, initialFrames + 1, 'next request sends only new context');
  assert.deepEqual(frames.at(-1).request.input, [next]);
  assert.equal(new Set(frames.map(f => f.connection)).size, 1);
  const totals = getStats().factory_transport.total;
  assert.equal(totals.requests - beforeLarge.requests, frames.length);
  assert.equal(totals.warmups - beforeLarge.warmups, initialFrames - 1);
  assert.equal(totals.input_tokens - beforeLarge.input_tokens, frames.length * 100);
  assert.equal(totals.cached_input_tokens - beforeLarge.cached_input_tokens, (initialFrames - 1) * 20 + 120);
  assert.equal(totals.uncached_input_tokens - beforeLarge.uncached_input_tokens, (initialFrames - 1) * 80 + 80);
  assert.equal(totals.cache_write_tokens - beforeLarge.cache_write_tokens, 8);
  assert.equal(totals.output_tokens - beforeLarge.output_tokens, 20);
  assert.equal(totals.reasoning_tokens - beforeLarge.reasoning_tokens, 6);
  reset(); scenario = 'wait';
  const c1 = new AbortController(), c2 = new AbortController();
  const queued1 = call({ input: initial }, { ...task('queue'), signal: c1.signal });
  while (!frames.length) await delay(5);
  const queued2 = call({ input: initial }, { ...task('queue'), signal: c2.signal });
  await delay(30); assert.equal(frames.length, 1, 'same task serializes concurrent requests');
  c2.abort(); await assert.rejects(queued2);
  c1.abort(); await assert.rejects(queued1);
  await delay(30); scenario = 'ok';
  assert.equal((await call({ input: initial }, task('queue'))).status, 200, 'cancelled queue releases lock');
  reset('max-remaining');
  const noIdentity = { headers: {}, body: { model: 'gpt-6-astra', prompt_cache_key: 'shared' } };
  assert.equal(getFactorySession(noIdentity), null, 'prompt cache key is not task identity');
  const idle = await (await call({ input: initial }, task('idle'))).json();
  const idleSession = getFactorySession({ headers: task('idle').headers, body: { model: 'gpt-6-astra' } });
  resetConnection(idleSession);
  await (await call({ input: [...initial, ...idle.output, next] }, task('idle'))).text();
  assert.equal(frames[1].request.previous_response_id, undefined);
  assert.equal(frames[1].id, 'a', 'idle/reconnect rebuilds context when policy selects the same key');
  clearFactorySessions(); // Simulated transport restart: durable pool stats survive.
  pool.config.algorithm = 'round-robin';
  pool.stats.task_affinity = { [idleSession.id]: { keyId: 'a' } };
  pool.stats.last_rotation_index = 1;
  await (await call({ input: initial }, task('idle'))).text();
  assert.equal(frames.at(-1).id, 'b', 'legacy affinity cannot override rotation after transport restart');
  const slowClient = new EventEmitter(); slowClient.write = () => false;
  const blocked = writeResponseChunk(slowClient, 'data'); slowClient.emit('drain'); await blocked;
  const abandoned = writeResponseChunk(slowClient, 'data'); slowClient.emit('close'); await assert.rejects(abandoned);
  assert.equal(slowClient.listenerCount('drain'), 0);
  assert.equal(httpCalls, 0, 'no replay of ambiguous requests');
  reset(); scenario = 'drop';
  for (let i = 0; i < 2; i++) { const r = await call({ input: initial }, task('fallback')); assert.equal(r.status, 502); await r.text(); }
  assert.equal(httpCalls, 0, 'two failed turns are not replayed');
  scenario = 'http-ok';
  const fallback = await call({ input: initial, stream: true }, task('fallback'));
  assert.equal(fallback.status, 200); assert.match(await fallback.text(), /response.completed/);
  assert.equal(httpCalls, 1, 'native policy uses HTTP for subsequent turns after two WS failures');
  console.log('PASS: per-request rotation and stable cache identity, same-account delta/tool/reasoning replay, edited history, quota migration, context recovery, no ambiguous replay, large upload once, accounting, task isolation, queued cancellation and reconnect');
} finally {
  clearFactorySessions();
  for (const socket of sockets) socket.terminate();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  Object.assign(cfg, savedConfig);
  for (const name of Object.keys(pool)) if (!(name in savedPool)) delete pool[name];
  Object.assign(pool, savedPool);
  if (fixedKey === undefined) delete process.env.FACTORY_API_KEY; else process.env.FACTORY_API_KEY = fixedKey;
}
