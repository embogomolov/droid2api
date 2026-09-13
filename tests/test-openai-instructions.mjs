// Offline: real Responses router and Chat Completions adapter, loopback upstream.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import fetch from 'node-fetch';

process.env.DROID2API_STATS_FILE = join(mkdtempSync(join(tmpdir(), 'openai-instructions-')), 'stats.json');
process.env.FACTORY_API_KEY = 'fixture-only';
const { getConfig } = await import('../config.js');
const { prepareOpenAIInstructions, prepareOpenAIInput, transformToOpenAI } = await import('../transformers/request-openai.js');
const { default: router } = await import('../routes.js');
const { default: pool } = await import('../auth.js');
const { destroyPool } = await import('../utils/http-client.js');
pool.keys = [];
pool.saveKeyPool = pool.saveKeyPoolImmediately = async () => {};
const cfg = getConfig();
const prefix = 'You are Droid, an AI software engineering agent built by Factory.\n\n';
const legacy = 'You are Codex, a coding agent based on GPT-5.';
const remainder = '\n\nKeep every instruction, whitespace, and quotation: ' + legacy;
cfg.system_prompt = prefix;
assert.equal(prepareOpenAIInstructions(legacy + remainder), prefix + remainder);
for (const text of ['', 'You are Codex, an agent based on GPT-6.', 'Quoted: ' + legacy, ' ' + legacy]) {
  assert.equal(prepareOpenAIInstructions(text), prefix + text);
}
cfg.system_prompt = '';
assert.equal(prepareOpenAIInstructions(legacy + remainder), legacy + remainder);
cfg.system_prompt = prefix;
const chat = { model: 'fixture-openai', messages: [
  { role: 'system', content: legacy + remainder }, { role: 'user', content: legacy }
] };
const chatBefore = structuredClone(chat);
const converted = transformToOpenAI(chat);
assert.equal(converted.instructions, prefix + remainder);
assert.equal(converted.input[0].content[0].text, legacy);
assert.deepEqual(chat, chatBefore);
const nativeInput = [
  { type: 'additional_tools', role: 'developer', tools: [] },
  { type: 'message', role: 'developer', content: [{ type: 'input_text', text: legacy + remainder }] },
  { role: 'user', content: legacy },
  { type: 'function_call_output', call_id: 'fixture', output: legacy },
  { role: 'developer', content: [{ type: 'input_text', text: legacy }] }
];
const nativeBefore = structuredClone(nativeInput);
const nativeExpected = structuredClone(nativeInput);
nativeExpected[1].content[0].text = remainder;
assert.deepEqual(prepareOpenAIInput(nativeInput), nativeExpected);
assert.deepEqual(nativeInput, nativeBefore);
assert.deepEqual(prepareOpenAIInput(nativeInput.slice(2)), nativeInput.slice(2));

let received;
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  received = JSON.parse(raw);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_fixture', status: 'completed', output: [] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
cfg.endpoint.find(e => e.name === 'openai').base_url = `http://127.0.0.1:${upstream.address().port}/responses`;
cfg.models.push({ id: 'fixture-openai', type: 'openai', reasoning: 'auto' });
const app = express(); app.use(express.json()); app.use(router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const request = { model: 'fixture-openai', instructions: legacy + remainder, stream: false,
    input: [{ role: 'user', content: legacy }, { type: 'function_call_output', call_id: 'fixture', output: legacy }],
    tools: [{ type: 'function', name: 'fixture', description: legacy, parameters: { type: 'object' } }],
    reasoning: { effort: 'low' } };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
  });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(received, { ...request, instructions: prefix + remainder });
  const nativeRequest = { ...request, input: nativeInput };
  delete nativeRequest.instructions;
  const nativeResponse = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nativeRequest)
  });
  assert.equal(nativeResponse.status, 200, await nativeResponse.text());
  assert.deepEqual(received, { ...nativeRequest, instructions: prefix, input: nativeExpected });
  console.log('PASS: legacy system identity adaptation, exact remainder, untouched history/tools, both OpenAI entry points');
} finally {
  server.closeAllConnections(); server.close();
  upstream.closeAllConnections(); upstream.close(); destroyPool();
}
