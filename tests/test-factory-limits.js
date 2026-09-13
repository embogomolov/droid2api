// Offline integration test; never sends requests or credentials to Factory.
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fetch, { Response } from 'node-fetch';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pool, { KeyPoolManager } from '../auth.js';
import router from '../routes.js';
import { getConfig } from '../config.js';
import { getLimitState, fetchBillingLimits, retryAfterTime } from '../utils/factory-limits.js';
import { checkedSSE } from '../utils/factory-upstream.js';
import fetchWithPool, { destroyPool } from '../utils/http-client.js';

const cfg = getConfig(), savedConfig = structuredClone(cfg);
const savedPool = { ...pool };
const oldFixedKey = process.env.FACTORY_API_KEY;
delete process.env.FACTORY_API_KEY;
let scenario = 'ok', calls = [], refreshes = 0, saved = 0, disconnected = false;
const now = Date.now();
const windows = (percent = 0, end = now + 60_000) => Object.fromEntries(
  ['fiveHour', 'weekly', 'monthly'].map(name => [name, { usedPercent: percent, windowEnd: new Date(end).toISOString() }]));
const key = id => ({ id, key: `fake-${id}`, status: 'active', last_test_result: 'success',
  billing_limits: { fetchedAt: now, limits: { standard: windows(), core: windows() } } });
const reset = () => {
  pool.keys = [key('a'), key('b')]; pool.stats = {}; pool.poolGroups = [];
  pool.config = { ...savedPool.config, algorithm: 'round-robin', multiTier: { enabled: false } };
  pool.saveKeyPool = async () => { saved++; };
  pool.saveKeyPoolImmediately = pool.saveKeyPool;
  pool.refreshBillingLimits = async () => { refreshes++; };
  calls = []; scenario = 'ok';
};
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const id = req.headers.authorization?.replace('Bearer fake-', '');
  calls.push({ id, path: req.url, body, provider: req.headers['x-api-provider'] });
  if (scenario === 'disconnect') { req.socket.destroy(); return; }
  if (scenario === 'wait') { res.once('close', () => { disconnected = true; }); return; }
  const status = scenario.startsWith('all-') ? Number(scenario.slice(4))
    : scenario.startsWith('first-') && id === 'a' ? Number(scenario.slice(6)) : 200;
  if (status !== 200) {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: { message: `simulated ${status}` } })); return;
  }
  const result = { id: 'resp_test', status: 'completed', model: body.model, instructions: body.instructions,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    if (scenario === 'idle') return;
    if (scenario === 'broken') { res.end(); return; }
    if (scenario === 'failed-event') { res.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'); return; }
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`);
  } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
});
const app = express(); app.use(express.json()); app.use(router);
let server;
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  for (const endpoint of cfg.endpoint) endpoint.base_url = `http://127.0.0.1:${upstream.address().port}/${endpoint.name}`;
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const call = (path = '/v1/responses', extra = {}, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-astra', input: 'OK', ...extra }), ...options
  });
  reset();
  for (const name of ['fiveHour', 'weekly', 'monthly']) {
    pool.keys[0].billing_limits.limits.standard = windows();
    pool.keys[0].billing_limits.limits.standard[name].usedPercent = 100;
    assert.equal((await pool.getNextKey({ model: 'gpt-6-astra' })).keyId, 'b');
  }
  pool.keys[1].billing_limits.limits.standard = windows(100);
  await assert.rejects(pool.getNextKey({ model: 'gpt-6-astra' }), e => e.status === 429 && e.retryAfter > 0);
  pool.keys[0].billing_limits.limits.standard = windows(100, now - 1);
  assert.equal((await pool.getNextKey({ model: 'gpt-6-astra' })).keyId, 'a');
  const effective = getLimitState(pool.keys[0]);
  assert.equal(effective.windows.fiveHour.usedPercent, 0);
  assert.equal(effective.windows.fiveHour.windowEnd, null);
  assert.equal(effective.windows.fiveHour.awaitingStart, true);
  assert.equal(effective.stale, false);
  assert.equal(pool.keys[0].billing_limits.limits.standard.fiveHour.usedPercent, 100, 'raw measurement remains intact');
  pool.keys[0].billing_limits.limits.standard.weekly = windows(49).weekly;
  assert.equal(getLimitState(pool.keys[0]).windows.weekly.usedPercent, 49, 'unexpired periods are unchanged');

  assert.ok(['a', 'b'].includes((await pool.getNextKey({ model: 'kimi-k2.6' })).keyId));
  reset(); delete pool.keys[0].billing_limits;
  assert.equal((await pool.getNextKey()).keyId, 'a', 'missing telemetry is not zero quota');
  assert.equal(getLimitState(pool.keys[0]).known, false);
  const prepaid = key('prepaid'); prepaid.billing_limits.limits.standard = windows(100);
  assert.equal(getLimitState(prepaid).available, false);
  prepaid.billing_limits.extraUsageEnabled = true;
  assert.equal(getLimitState(prepaid).available, true);
  prepaid.cooldowns = { standard: { status: 429, until: now + 60_000 } };
  assert.equal(getLimitState(prepaid).available, false, 'Retry-After still applies to prepaid usage');
  for (const algorithm of ['quota-aware', 'max-remaining', 'weighted-usage']) {
    reset(); pool.config.algorithm = algorithm;
    pool.keys[0].billing_limits.limits.standard = windows(100);
    pool.loadTokenUsageData = () => ({ b: { standard: { remaining: 0, totalAllowance: 1, orgTotalTokensUsed: 999999999 } } });
    assert.equal((await pool.getNextKey()).keyId, 'b', 'legacy counters must not reject a usable account');
  }
  reset();
  pool.poolGroups = [{ id: 'primary', priority: 0 }, { id: 'backup', priority: 1 }];
  pool.config.multiTier.enabled = true; pool.keys[0].poolGroup = 'primary'; pool.keys[1].poolGroup = 'backup';
  pool.keys[0].billing_limits.limits.standard = windows(100);
  assert.equal((await pool.getNextKey()).keyId, 'b');
  assert.equal(retryAfterTime('2', now), now + 2000);
  assert.equal(retryAfterTime(new Date(now + 10_000).toUTCString(), now), Math.floor((now + 10_000) / 1000) * 1000);
  assert.equal(retryAfterTime('garbage', now), null);
  const measured = await fetchBillingLimits('fake', { fetchImpl: async () => new Response(JSON.stringify({
    limits: { standard: windows(12), core: windows(1) }, secret: 'do not persist'
  })) });
  assert.equal(measured.limits.standard.weekly.usedPercent, 12); assert.equal(measured.secret, undefined);
  await assert.rejects(fetchBillingLimits('fake', { fetchImpl: async () => new Response('{}') }));

  // Real route and pool selection, only the upstream is simulated.
  for (const path of ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens']) {
    for (const status of [401, 402, 429]) {
      reset(); scenario = `first-${status}`;
      const extra = path.startsWith('/v1/messages') ? { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'OK' }] }
        : path.includes('chat') ? { messages: [{ role: 'user', content: 'OK' }] } : {};
      const response = await call(path, extra);
      assert.equal(response.status, 200, `${path} ${status}`); await response.text();
      assert.deepEqual(calls.map(c => c.id), ['a', 'b']);
      assert.equal(pool.keys[0].status, status === 401 ? 'disabled' : 'active');
      if (status === 429 || status === 402) {
        assert.ok(pool.keys[0].cooldowns.standard.until > Date.now());
        pool.keys[0].cooldowns.standard.until = Date.now() - 1; pool.stats = {};
        assert.equal((await pool.getNextKey()).keyId, 'a', 'account returns automatically');
      }
    }
  }
  for (const status of [400, 403, 413, 422, 429, 500]) {
    reset(); scenario = `all-${status}`;
    const response = await call();
    assert.equal(response.status, status); assert.match(await response.text(), new RegExp(String(status)));
    assert.equal(calls.length, status === 429 ? 2 : 1);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal(pool.keys[0].status, 'active');
  }
  reset();
  cfg.models = [...cfg.models.filter(m => m.id !== 'kimi-k3'), { id: 'kimi-k3', type: 'common', api_provider: 'fireworks' }];
  pool.keys[0].billing_limits.limits.standard = windows(100);
  const kimi = await call('/v1/chat/completions', { model: 'kimi-k3', messages: [{ role: 'user', content: 'OK' }], reasoning_effort: 'high', reasoning_history: 'preserved', max_tokens: 65536 });
  assert.equal(kimi.status, 200); await kimi.text();
  assert.equal(calls[0].id, 'a', 'Kimi uses available Core quota despite exhausted Standard quota');
  assert.equal(calls[0].provider, 'fireworks');
  assert.equal(calls[0].body.model, 'kimi-k3');
  assert.equal(calls[0].body.reasoning_history, 'preserved');
  assert.equal(calls[0].body.max_tokens, 65536);
  reset(); scenario = 'all-429';
  await (await call()).text(); calls = [];
  const blocked = await call(); assert.equal(blocked.status, 429); await blocked.text();
  assert.equal(calls.length, 0, 'known cooldown avoids needless requests');
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 120000 ? 40 : ms, ...args);
  try {
    reset(); scenario = 'wait';
    const timedOut = await call(); assert.equal(timedOut.status, 504);
    const timeoutData = await timedOut.json();
    assert.equal(timeoutData.error.detail, 'upstream_response_timeout');
    assert.equal(timeoutData.error.request_id, timedOut.headers.get('x-proxy-request-id'));
    assert.equal(calls.length, 1, 'timeout after dispatch must not replay');
    reset(); scenario = 'idle';
    await assert.rejects(async () => { const r = await call('/v1/responses', { stream: true }); await r.text(); });
    assert.equal(calls.length, 1, 'stream idle timeout must not replay');
  } finally { globalThis.setTimeout = realTimeout; }
  reset(); scenario = 'first-503';
  const ambiguous = await call(); assert.equal(ambiguous.status, 503); await ambiguous.text();
  assert.equal(calls.length, 1, 'HTTP 5xx cannot prove generation was not accepted');
  reset(); scenario = 'disconnect';
  const disconnectedResponse = await call(); assert.equal(disconnectedResponse.status, 502); await disconnectedResponse.text();
  assert.equal(calls.length, 1, 'ambiguous transport failure is not replayed');
  reset(); scenario = 'broken';
  await assert.rejects(async () => { const response = await call('/v1/responses', { stream: true }); await response.text(); });
  assert.equal(calls.length, 1, 'broken streams are never replayed');
  reset(); scenario = 'failed-event';
  const failed = await call('/v1/responses', { stream: true }); assert.match(await failed.text(), /response.failed/);
  assert.equal(calls.length, 1);
  reset();
  const streamed = await call('/v1/responses', { stream: true }); assert.match(await streamed.text(), /response.completed/);
  reset(); scenario = 'wait';
  const controller = new AbortController();
  const pending = call('/v1/responses', {}, { signal: controller.signal });
  while (!calls.length) await delay(5);
  controller.abort(); await assert.rejects(pending);
  for (let i = 0; i < 50 && !disconnected; i++) await delay(10);
  assert.equal(disconnected, true, 'client cancellation aborts Factory request');

  const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"Привет"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n');
  const chunks = [];
  for await (const chunk of checkedSSE(Readable.from([...bytes].map(byte => Buffer.from([byte]))))) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  scenario = 'all-429';
  const untouched = await fetchWithPool(`http://127.0.0.1:${upstream.address().port}/openai`, { method: 'POST', body: '{}', maxRetries: 3 });
  assert.equal(untouched.status, 429); await untouched.text();
  assert.ok(saved && refreshes);
  console.log('PASS: three windows, reset/cooldown recovery, unknown data, all algorithms, pool fallback, all four routes, 401/402/403/413/429/5xx, no duplicate attempts, broken streams and cancellation');
} finally {
  Object.assign(cfg, savedConfig);
  for (const name of Object.keys(pool)) if (!(name in savedPool)) delete pool[name];
  Object.assign(pool, savedPool);
  if (oldFixedKey === undefined) delete process.env.FACTORY_API_KEY; else process.env.FACTORY_API_KEY = oldFixedKey;
  destroyPool();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
