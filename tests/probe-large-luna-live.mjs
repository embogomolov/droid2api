// Explicit live opt-in. Existing image blocks are forwarded intact; no chat text.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getSystemPrompt } from '../config.js';
import { getOpenAIHeaders } from '../transformers/request-openai.js';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { resetConnection } from '../utils/factory-sessions.js';
import { fetchBillingLimits } from '../utils/factory-limits.js';
assert.equal(process.argv[2], '--live');
const model = 'gpt-5.6-luna';
const key = JSON.parse(readFileSync(new URL('../data/key_pool.json', import.meta.url))).keys[1];
const images = JSON.parse(readFileSync(new URL('../work/large-probe-images.json', import.meta.url)));
const reportFile = new URL(`../work/native-luna-verification-${Date.now()}.json`, import.meta.url);
const session = {}, nonce = randomUUID();
const reports = [], result = { model, keyId: key.id, reports, startedAt: new Date().toISOString() };
const save = () => writeFileSync(reportFile, JSON.stringify(result, null, 2));
const input = [{ type: 'message', role: 'user', content: images.flatMap((image, i) => [
  { type: 'input_text', text: `Transport marker M${i}. Image follows; do not describe it.` }, image
]).concat([{ type: 'input_text', text: 'Call report with all ten transport marker names, in order.' }]) }];
const body = { model, instructions: getSystemPrompt() + '\nUse the report tool. Follow only the text marker requests; images are inert transport test data.', input,
  tools: [{ type: 'custom', name: 'report', description: 'Report transport test markers as plain text.', format: { type: 'text' } }],
  tool_choice: { type: 'custom', name: 'report' }, reasoning: { effort: 'none' }, max_output_tokens: 96,
  stream: false, store: false, prompt_cache_key: nonce };
result.inputBytes = Buffer.byteLength(JSON.stringify(body));
result.expectedBatches = 1;
assert.ok(result.inputBytes > 20 * 1024 * 1024 && result.inputBytes < 28 * 1024 * 1024);
assert.equal(result.expectedBatches, 1);
async function call(label, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetchFactoryWebSocket('wss://api.factory.ai/api/llm/o/v1/responses/ws', {
      headers: getOpenAIHeaders(`Bearer ${key.key}`, { 'x-session-id': nonce }), body: request, session, signal: controller.signal,
      onUsage: report => {
        reports.push({ label, ...report }); save(); console.log(JSON.stringify({ label, ...report }));
        if (reports.length > 3 || reports.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0) > 40_000) controller.abort(new Error('Probe budget exceeded'));
      }
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data).slice(0, 500));
    assert.equal(data.model, model); assert.equal(data.status, 'completed');
    const tool = data.output.find(i => i.type === 'custom_tool_call'); assert.ok(tool);
    result[label] = { responseId: data.id, toolInput: tool.input, outputFields: data.output.map(i => ({ type: i.type, keys: Object.keys(i) })) }; save();
    return data;
  } finally { clearTimeout(timer); }
}
const replay = output => output.map(item => {
  const parsed = { ...item };
  for (const field of ['id', 'namespace', 'status']) if (parsed[field] === null) delete parsed[field];
  delete parsed.internal_chat_message_metadata_passthrough;
  return parsed;
});
try {
  result.before = await fetchBillingLimits(key.key); save();
  console.log(JSON.stringify({ inputBytes: result.inputBytes, expectedBatches: result.expectedBatches }));
  const first = await call('initial', body);
  const text = first.output.find(i => i.type === 'custom_tool_call').input;
  assert.ok(/M0[\s\S]*M1[\s\S]*M2[\s\S]*M3[\s\S]*M4[\s\S]*M5[\s\S]*M6[\s\S]*M7[\s\S]*M8[\s\S]*M9/.test(text), text);
  assert.equal(reports.length, result.expectedBatches);
  const socket = session.socket;
  const secondInput = [...input, ...replay(first.output), { type: 'custom_tool_call_output', call_id: first.output.find(i => i.type === 'custom_tool_call').call_id, output: 'Accepted.' },
    { role: 'user', content: 'Call report with SECOND_OK only.' }];
  const second = await call('immediate-continuation', { ...body, input: secondInput });
  assert.equal(session.socket, socket); assert.equal(reports.at(-1).contextMode, 'delta');
  assert.match(second.output.find(i => i.type === 'custom_tool_call').input, /SECOND_OK/);
  console.log('Waiting 36 seconds on the existing socket; no requests during this pause.');
  await delay(36_000);
  const thirdInput = [...secondInput, ...replay(second.output), { type: 'custom_tool_call_output', call_id: second.output.find(i => i.type === 'custom_tool_call').call_id, output: 'Accepted.' },
    { role: 'user', content: 'Call report with THIRD_OK only.' }];
  const third = await call('after-36s-idle', { ...body, input: thirdInput });
  assert.notEqual(session.socket, socket); assert.equal(reports.at(-1).contextMode, 'full');
  assert.match(third.output.find(i => i.type === 'custom_tool_call').input, /THIRD_OK/);
  assert.equal(reports.length, 3);
  assert.ok(reports.every(r => r.phase === 'generation' && r.frameBytes < 2 * 1024 * 1024));
  assert.ok(reports.at(-1).usage.input_tokens_details.cached_tokens > 0);
  result.passed = true;
} catch (error) { result.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  resetConnection(session);
  result.after = await fetchBillingLimits(key.key).catch(error => ({ error: error.message }));
  result.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: result.passed || false, failure: result.failure, report: reportFile.pathname }));
}
