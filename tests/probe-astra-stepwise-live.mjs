// One inference per invocation. Review the saved limits before invoking next stage.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { fetchBillingLimits, getLimitState } from '../utils/factory-limits.js';
import { getOpenAIHeaders } from '../transformers/request-openai.js';
import { getSystemPrompt } from '../config.js';

assert.equal(process.argv[2], '--live');
const stage = Number(process.argv[3]);
assert.ok(Number.isInteger(stage) && stage >= 0 && stage <= 4);
const file = new URL('../work/astra-stepwise-verification.json', import.meta.url);
const keys = JSON.parse(readFileSync(new URL('../data/key_pool.json', import.meta.url))).keys;
const report = existsSync(file) ? JSON.parse(readFileSync(file)) : { model: 'gpt-6-astra', nonce: randomUUID(), keyId: keys[1].id, stages: [], maxIncrease: 2 };
assert.equal(report.stages.length, stage, 'Run exactly the next stage; no automatic replay');
assert.ok(!report.stopped, report.stopped);
const key = keys.find(k => k.id === report.keyId); assert.ok(key);
const save = () => writeFileSync(file, JSON.stringify(report, null, 2));
const snapshot = async () => {
  const raw = await fetchBillingLimits(key.key);
  const state = getLimitState({ billing_limits: raw });
  assert.ok(state.known, 'Unknown quota: do not continue');
  return { at: new Date().toISOString(), available: state.available, windows: state.windows, raw: raw.limits.standard };
};
const current = { stage, before: await snapshot() };
assert.ok(current.before.available, 'Account has no available quota');
report.baseline ??= current.before;
assert.ok(current.before.windows.fiveHour.usedPercent - report.baseline.windows.fiveHour.usedPercent < report.maxIncrease, 'Test quota budget reached');
// Preserve the exact previous user-message prefix as context grows.
const rows = (start, count) => Array.from({ length: count }, (_, i) => `Entry ${start + i}: alpha beta gamma delta epsilon.`).join('\n');
const first = { role: 'user', content: [{ type: 'input_text', text: `Unique test ${report.nonce}\n` + rows(0, 1536) + '\nReply OK.' }] };
const input = [first];
if (stage >= 2) input.push({ role: 'user', content: [{ type: 'input_text', text: rows(1536, 1536) + '\nReply OK.' }] });
if (stage >= 3) input.push({ role: 'user', content: [{ type: 'input_text', text: rows(3072, 3072) + '\nReply OK.' }] });
const body = { model: report.model, instructions: getSystemPrompt() + '\nThis is a context/caching probe. Reply exactly OK.', input,
  reasoning: { effort: 'low' }, max_output_tokens: 128, stream: false, store: false, prompt_cache_key: report.nonce };
current.inputBytes = Buffer.byteLength(JSON.stringify(body));
report.stages.push(current); save();
console.log(JSON.stringify({ stage, before: current.before, inputBytes: current.inputBytes }));
try {
  let physical = 0;
  const response = await fetchFactoryWebSocket('wss://api.factory.ai/api/llm/o/v1/responses/ws', {
    headers: getOpenAIHeaders(`Bearer ${key.key}`, { 'x-session-id': report.nonce }), body,
    signal: AbortSignal.timeout(90_000),
    onUsage: usage => { current.physicalRequests = ++physical; current.transport = usage; save(); }
  });
  const data = await response.json();
  current.status = response.status; current.model = data.model; current.usage = data.usage;
  current.text = (data.output || []).flatMap(i => i.content || []).map(i => i.text || '').join('');
  current.responseStatus = data.status;
  if (!response.ok) current.error = data;
  assert.equal(response.status, 200); assert.equal(data.model, report.model);
  assert.equal(physical, 1); assert.equal(current.transport.phase, 'generation');
  assert.equal(data.status, 'completed'); assert.equal(current.text.trim(), 'OK');
} catch (error) { report.stopped = error.message; process.exitCode = 1; }
finally {
  try {
    current.afterImmediate = await snapshot(); save();
    await delay(12_000);
    current.afterDelayed = await snapshot();
    current.increase = current.afterDelayed.windows.fiveHour.usedPercent - current.before.windows.fiveHour.usedPercent;
    current.totalIncrease = current.afterDelayed.windows.fiveHour.usedPercent - report.baseline.windows.fiveHour.usedPercent;
    if (current.totalIncrease >= report.maxIncrease) report.stopped = 'Five-hour test budget reached; no further inference';
    if (current.before.windows.fiveHour.windowEnd && current.afterDelayed.windows.fiveHour.windowEnd !== current.before.windows.fiveHour.windowEnd) report.stopped = 'Quota window changed; measurements not comparable';
    if (!current.afterDelayed.available) report.stopped = 'Account unavailable';
  } catch (error) { report.stopped = 'Cannot verify post-request limits: ' + error.message; process.exitCode = 1; }
  save(); console.log(JSON.stringify({ result: current, stopped: report.stopped || null, report: file.pathname }));
}
