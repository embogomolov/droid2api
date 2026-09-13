// Actual admin routes and persistence in the runner's temporary empty-key checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import fetch from 'node-fetch';
import { once } from 'node:events';
import pool from '../auth.js';
import router from '../api/admin-routes.js';
import { getWindowSync, DEFAULT_WINDOW_SYNC } from '../utils/window-sync.js';
import { getConfig } from '../config.js';
import writers from '../utils/async-file-writer.js';
import { destroyPool } from '../utils/http-client.js';
process.env.ADMIN_ACCESS_KEY = 'isolated-sync-test';
pool.keys = ['a','b'].map(id => ({ id, key: `fake-${id}`, status: 'active', last_test_result: 'success' }));
const scheduler = getWindowSync(pool); await scheduler.stop(); // Never start background probes in this API check.
const app = express(); app.use(express.json()); app.use('/admin', router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const call = async (method, path, body, auth = true) => {
 const r = await fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { 'x-admin-key': 'isolated-sync-test' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
 return { status: r.status, body: await r.json() };
};
try {
 assert.equal((await call('GET', '/window-sync', null, false)).status, 401);
 const initial = await call('GET', '/window-sync'); assert.equal(initial.status, 200); assert.equal(initial.body.data.settings.enabled, false);
 assert.equal(initial.body.data.settings.workingHours.enabled, false);
 assert.equal(JSON.stringify(initial.body).includes('fake-a'), false, 'Admin status must not expose credentials');
 const cfg = { ...structuredClone(DEFAULT_WINDOW_SYNC), enabled: true, keyIds: ['a','b'] };
 assert.equal((await call('PUT', '/window-sync', { ...cfg, keyIds: ['unknown'] })).status, 400);
 assert.equal((await call('PUT', '/window-sync', cfg)).status, 200);
 assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url))).window_sync, cfg);
 const routing = (await call('GET', '/keys')).body.data.keys[0].routing;
 assert.ok(routing.standard.blocked, 'UI status uses the scheduler routing barrier');
 assert.equal(routing.core.blocked, null, 'Standard synchronization does not block Core');
 assert.equal((await pool.testKey('a')).skipped, true, 'Manual tests cannot bypass barrier');
 await assert.rejects(pool.getNextKey({ model: cfg.modelId }), error => error.status === 503 && error.retryAfter === 5);
 assert.equal((await call('PATCH', '/keys/a/exclusion', { excluded: true })).status, 200);
 assert.equal((await call('GET', '/window-sync')).body.data.keys.find(k => k.id === 'a').excluded, true);
 const bad = await call('PATCH', '/keys/a/exclusion', { excluded: 'false' }); assert.equal(bad.status, 400);
 fs.writeFileSync(scheduler.file, '{broken journal');
 pool.keys = [];
 assert.equal((await call('PUT', '/window-sync', { ...cfg, enabled: false, modelId: 'removed-model' })).status, 200, 'Always allow disabling after account/model removal');
 assert.equal(getConfig().window_sync.enabled, false);
 console.log('PASS: authenticated API, strict input, saved settings, key exclusions, routing/test barrier and emergency disable');
} finally { await scheduler.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); destroyPool(); await writers.destroyAll(); }
