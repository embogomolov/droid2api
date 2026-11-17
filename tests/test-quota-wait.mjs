// Run in an isolated empty-key checkout. All model and billing calls stay local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { KeyPoolManager } from '../auth.js';
import { WindowSync, DEFAULT_WINDOW_SYNC } from '../utils/window-sync.js';
import { requestWithFailover } from '../utils/factory-upstream.js';
import { logCollectorMiddleware, getLogBuffer, clearLogBuffer } from '../middleware/log-collector.js';
import { destroyPool } from '../utils/http-client.js';

delete process.env.FACTORY_API_KEY;
const realNow = Date.now;
let now = realNow(), calls = [], rejectQuota = false;
Date.now = () => now;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-wait-'));
const manager = Object.create(KeyPoolManager.prototype);
manager.config = { algorithm: 'round-robin', waitForQuota: true };
manager.stats = { last_rotation_index: 0 };
manager.saveKeyPool = manager.saveKeyPoolImmediately = async () => {};
manager.observeBillingLimits = () => {};
manager.keys = ['a', 'b', 'excluded'].map(id => ({ id, key: `fake-${id}`,
  status: 'active', last_test_result: 'success', excluded: id === 'excluded' }));
const cfg = { window_sync: structuredClone(DEFAULT_WINDOW_SYNC), models: [{ id: 'gpt-5.6-luna', type: 'openai' }] };
Object.assign(cfg.window_sync.groups.standard, { enabled: true, keyIds: ['a', 'b', 'excluded'] });
const fiveHours = 18_000_000;
const ends = { a: now + fiveHours, b: now + fiveHours + 30_000, excluded: now + fiveHours };
const used = { a: 100, b: 100, excluded: 0 }, starts = [];
manager.keys.filter(k=>!k.excluded).forEach(k=>k.cooldowns={standard:{kind:'quota',status:402,until:ends[k.id]}});
const snapshot = id => ({ fetchedAt: now, overagePreference: 'none', limits: { standard:
  Object.fromEntries(['fiveHour', 'weekly', 'monthly'].map(name => [name, {
    usedPercent: name === 'fiveHour' ? (ends[id] > now ? used[id] : 0) : 1,
    windowEnd: name === 'fiveHour' ? (ends[id] > now ? new Date(ends[id]).toISOString() : null) : new Date(now + fiveHours * 100).toISOString()
  }])) } });
manager.refreshBillingLimits = async key => { key.billing_limits = snapshot(key.id); };
manager.windowSync = new WindowSync({ manager, directory, readConfig: () => cfg, now: () => now,
  refresh: async secret => snapshot(secret.slice(5)),
  send: async key => { starts.push(key.id); ends[key.id] = now + fiveHours; used[key.id] = 1; return { accepted: true }; } });
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  calls.push({ account: req.headers.authorization, body: JSON.parse(raw) });
  if (rejectQuota) { used.a = used.b = 100; res.writeHead(429, { 'retry-after': '1' }).end('{"error":"quota"}'); }
  else res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"type":"message_stop"}\n\n');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const app = express(); app.use(express.json(), logCollectorMiddleware);
app.post('/v1/messages', async (req, res) => {
  try {
    const result = await requestWithFailover(req, res, authorization => ({
      url: `http://127.0.0.1:${upstream.address().port}/messages`,
      headers: { authorization, 'content-type': 'application/json' }, body: req.body
    }), manager);
    if (result) res.status(result.response.status).type('application/json').send(await result.response.text());
  } catch (error) { res.status(500).json({ error: error.message }); }
});
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const payload = { model: 'gpt-5.6-luna', stream: true, messages: [{ role: 'user', content: 'fixture' }] };
const send = signal => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal
});
const until = async predicate => {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(20); }
  assert.fail('Condition did not become true');
};
const waiting = () => getLogBuffer().some(row => row.summary?.outcome === 'Waiting for quota');
try {
  clearLogBuffer();
  let headers = false;
  const pending = send().then(r => { headers = true; return r; });
  await until(waiting);
  assert.equal(headers, false); assert.equal(calls.length, 0);
  assert.equal(manager.windowSync.requests.size, 0, 'Pending requests must not block synchronized starts');
  now += fiveHours + 1;
  await manager.windowSync.tick(); await delay(1100);
  assert.equal(starts.length, 0); assert.equal(headers, false, 'One reset cannot bypass the other group member');
  now += 30_001;
  await manager.windowSync.tick();
  assert.deepEqual(starts.sort(), ['a', 'b']);
  assert.equal(manager.windowSync.load().groups.standard.phase, 'starting');
  await delay(1100); assert.equal(headers, false, 'Accepted starts must still be confirmed');
  now += 2001; await manager.windowSync.tick();
  assert.equal(manager.windowSync.load().groups.standard.phase, 'active');
  const response = await pending; assert.equal(response.status, 200); await response.text();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, payload);
  await until(() => getLogBuffer()[0]?.summary?.outcome === 'Completed');
  assert.equal(getLogBuffer().length, 1, 'Waiting row updates rather than duplicating events');

  // Real upstream rejection enters the same wait, without consuming client retries.
  cfg.window_sync.groups.standard.enabled = false;
  clearLogBuffer(); rejectQuota = true; calls = [];
  const rejected = send(); await until(waiting);
  assert.equal(calls.length, 2);
  rejectQuota = false; used.a = 1; now += 60_001;
  assert.equal((await rejected).status, 200); assert.equal(calls.length, 3);

  // Turning the option off releases an existing wait with the usual quota error.
  used.a = used.b = 100; clearLogBuffer();
  manager.keys.filter(k=>!k.excluded).forEach(k=>k.cooldowns={standard:{kind:'quota',status:402,until:ends[k.id]}});
  const disabled = send(); await until(waiting);
  manager.config.waitForQuota = false;
  assert.equal((await disabled).status, 429);
  assert.equal((await send()).status, 429);

  // Removing/excluding the remaining accounts must not let an old waiter dispatch.
  manager.config.waitForQuota = true; clearLogBuffer(); calls = [];
  const excluded = send(); await until(waiting);
  manager.keys.forEach(key => { key.excluded = true; });
  assert.equal((await excluded).status, 503); assert.equal(calls.length, 0);
  manager.keys[0].excluded = false;

  clearLogBuffer(); const controller = new AbortController();
  const cancelled = send(controller.signal).catch(error => error);
  await until(waiting); controller.abort();
  assert.equal((await cancelled).name, 'AbortError');
  await until(() => getLogBuffer()[0]?.summary?.outcome === 'Disconnected');
  used.a = 1; await delay(1100); assert.equal(calls.length, 0);
  assert.equal(manager.windowSync.requests.get('a')?.count || 0, 0);
  console.log('PASS: five-hour reset, full group confirmation, excluded account, unchanged payload, upstream 429, live disable, cancellation and pending UI');
} finally {
  Date.now = realNow;
  server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close();
  await manager.windowSync.stop(); destroyPool(); fs.rmSync(directory, { recursive: true, force: true });
}
