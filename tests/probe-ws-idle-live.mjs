import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { resetConnection } from '../utils/factory-sessions.js';
import { getOpenAIHeaders } from '../transformers/request-openai.js';
import { getSystemPrompt } from '../config.js';
assert.equal(process.argv[2], '--live');
const key = JSON.parse(readFileSync(new URL('../data/key_pool.json', import.meta.url))).keys[1];
const session = {}, reports = [], result = { reports, startedAt: new Date().toISOString(), pongs: 0 };
const body = { model: 'gpt-5.6-luna', instructions: getSystemPrompt(), input: [{ role: 'user', content: 'Reply OK.' }],
  reasoning: { effort: 'none' }, max_output_tokens: 16, stream: false, store: false, prompt_cache_key: randomUUID() };
const headers = getOpenAIHeaders(`Bearer ${key.key}`, { 'x-session-id': randomUUID() });
let heartbeat;
async function call(request) {
  const response = await fetchFactoryWebSocket('wss://api.factory.ai/api/llm/o/v1/responses/ws', {
    headers, body: request, session, signal: AbortSignal.timeout(30_000), onUsage: report => { reports.push(report); console.log(JSON.stringify(report)); }
  });
  const data = await response.json(); assert.equal(response.status, 200); return data;
}
try {
  const first = await call(body);
  const socket = session.socket;
  socket.on('close', (code, reason) => { result.close = { code, reason: reason.toString(), time: new Date().toISOString() }; console.log(JSON.stringify(result.close)); });
  socket.on('pong', () => { result.pongs++; console.log('pong ' + result.pongs); });
  heartbeat = setInterval(() => { if (socket.readyState === 1) socket.ping(); }, 10_000);
  await delay(40_000);
  assert.equal(socket.readyState, 1, 'Upstream closed despite transport ping; do not replay');
  const second = await call({ ...body, input: [...body.input, ...first.output, { role: 'user', content: 'Reply STILL_OK.' }] });
  assert.equal(session.socket, socket); assert.equal(reports.at(-1).contextMode, 'delta');
  result.text = second.output.flatMap(i => i.content || []).map(i => i.text || '').join('');
  assert.match(result.text, /STILL_OK/); result.passed = true;
} catch (error) { result.failure = error.message; process.exitCode = 1; }
finally {
  clearInterval(heartbeat); resetConnection(session);
  writeFileSync(new URL('../work/ws-idle-live-report.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
