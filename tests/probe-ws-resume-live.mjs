import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { getOpenAIHeaders } from '../transformers/request-openai.js';
import { getSystemPrompt } from '../config.js';
assert.equal(process.argv[2], '--live');
const key = JSON.parse(readFileSync(new URL('../data/key_pool.json', import.meta.url))).keys[1];
const marker = 'RESUME_' + randomUUID().slice(0, 8), nonce = randomUUID(), reports = [];
const base = { model: 'gpt-5.6-luna', instructions: getSystemPrompt(), reasoning: { effort: 'none' }, max_output_tokens: 24, stream: false, store: false, prompt_cache_key: nonce };
const headers = getOpenAIHeaders(`Bearer ${key.key}`, { 'x-session-id': nonce });
const result = { reports };
async function call(body) {
  const response = await fetchFactoryWebSocket('wss://api.factory.ai/api/llm/o/v1/responses/ws', {
    headers, body, signal: AbortSignal.timeout(30_000), onUsage: usage => { reports.push(usage); console.log(JSON.stringify(usage)); }
  });
  const data = await response.json();
  if (!response.ok) { result.errorResponse = data; throw new Error('Resume HTTP ' + response.status); }
  return data;
}
try {
  const first = await call({ ...base, input: `Remember marker ${marker}. Reply OK.` });
  // No session object: the transport has CLOSED the first WebSocket.
  const second = await call({ ...base, previous_response_id: first.id, input: 'Reply with the marker from the previous user message.' });
  const text = second.output.flatMap(i => i.content || []).map(i => i.text || '').join('');
  assert.equal(text.trim(), marker); result.passed = true;
} catch (error) { result.failure = error.message; process.exitCode = 1; }
finally { writeFileSync(new URL('../work/ws-resume-live-report.json', import.meta.url), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
