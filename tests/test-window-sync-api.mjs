// Actual admin routes and persistence in the runner's temporary empty-key checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import fetch from 'node-fetch';
import { once } from 'node:events';
import pool, { KeyPoolManager } from '../auth.js';
import router from '../api/admin-routes.js';
import { getWindowSync, DEFAULT_WINDOW_SYNC } from '../utils/window-sync.js';
import { getConfig, saveConfig } from '../config.js';
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
 const initial = await call('GET', '/window-sync'); assert.equal(initial.status, 200); assert.equal(initial.body.data.settings.groups.standard.enabled, false);
 assert.equal(initial.body.data.settings.groups.standard.workingHours.enabled, false);
 assert.equal(JSON.stringify(initial.body).includes('fake-a'), false, 'Admin status must not expose credentials');
 // Existing single-pool settings migrate into their real usage pool without enabling the other.
 saveConfig({...getConfig(),window_sync:{enabled:true,keyIds:['b'],modelId:'kimi-k3',workingHours:{enabled:false,start:'09:00',end:'18:00'}}});
 const migrated=(await call('GET','/window-sync')).body.data.settings;
 assert.equal(migrated.groups.core.enabled,false);assert.equal(migrated.groups.standard.enabled,false);
 assert.equal((await call('PUT','/window-sync',migrated)).status,200);
 assert.equal(scheduler.manages(pool.keys[1], 'kimi-k3'),false);assert.equal(scheduler.manages(pool.keys[1],'claude-haiku-4-5-20251001'),false);
 assert.equal((await call('PUT','/config',{window_sync:migrated})).status,400,'Generic editor cannot bypass validation');
 const cfg = structuredClone(DEFAULT_WINDOW_SYNC);Object.assign(cfg.groups.standard,{enabled:true,keyIds:['a','b']});
 assert.equal((await call('PUT', '/window-sync', { ...cfg, groups:{...cfg.groups,standard:{...cfg.groups.standard,keyIds:['unknown']}} })).status, 400);
 assert.equal((await call('PUT', '/window-sync', cfg)).status, 200);
 assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url))).window_sync, cfg);
 const routing = (await call('GET', '/keys')).body.data.keys[0].routing;
 assert.ok(routing.standard.blocked, 'UI status uses the scheduler routing barrier');
 assert.equal(routing.core.blocked, routing.standard.blocked, 'Core models still consume Standard until fallback');
 assert.equal((await pool.testKey('a')).skipped, true, 'Manual tests cannot bypass barrier');
 await assert.rejects(pool.getNextKey({ model: cfg.groups.standard.modelId }), error => error.status === 503 && error.retryAfter === 5);
 assert.equal((await call('PATCH', '/keys/a/exclusion', { excluded: true })).status, 200);
 assert.equal((await call('GET', '/window-sync')).body.data.keys.find(k => k.id === 'a').excluded, true);
 const bad = await call('PATCH', '/keys/a/exclusion', { excluded: 'false' }); assert.equal(bad.status, 400);

 assert.equal((await call('POST','/keys/a/window-action',{group:'core',kind:'start'},false)).status,401);
 assert.equal((await call('POST','/keys/a/window-action',{group:'bogus',kind:'start'})).status,400);
 assert.equal((await call('POST','/keys/a/window-action',{group:'core',kind:'start'})).status,400);
 delete pool.keys[1].limits_error;
 const now=Date.now();pool.keys[1].billing_limits={fetchedAt:now,overagePreference:'droidCore',limits:Object.fromEntries(['standard','core'].map(g=>[g,Object.fromEntries(['fiveHour','weekly','monthly'].map(n=>[n,{usedPercent:1,windowEnd:new Date(now+3600000).toISOString()}]))]))};
 assert.equal((await call('POST','/keys/b/window-action',{group:'core',kind:'start'})).status,400);
 assert.equal((await call('POST','/keys/b/window-action',{group:'core',kind:'test'})).status,200);
 assert.equal((await call('POST','/keys/b/window-action',{group:'core',kind:'test'})).status,200);
 assert.equal((await call('GET','/keys')).body.data.keys.find(k=>k.id==='b').routing.core.action.label,'Testing…');
 fs.writeFileSync(scheduler.file, '{broken journal');
 pool.keys = [];
 assert.equal((await call('PUT', '/window-sync', { ...cfg, groups:{...cfg.groups,standard:{...cfg.groups.standard,enabled:false,modelId:'removed-model'}} })).status, 200, 'Always allow disabling after account/model removal');
 assert.equal(getConfig().window_sync.groups.standard.enabled, false);
 // The live settings endpoint activates the new policy; persisted credit survives a manager restart.
 pool.keys = ['a','b'].map(id => ({ id, key: 'fake-'+id, status: 'active', last_test_result: 'success',
   billing_limits: { fetchedAt: Date.now(), limits: { standard: Object.fromEntries(['fiveHour','weekly','monthly'].map(n => [n,{usedPercent:10,windowEnd:new Date(Date.now()+3_600_000).toISOString()}])) } } }));
 pool.refreshBillingLimits = async () => {};
 assert.equal((await call('PUT', '/config', {key_pool:{algorithm:'quota-aware',multiTier:{enabled:false}}})).status, 200);
 for(let i=0;i<3;i++)await pool.getNextKey({model:cfg.groups.standard.modelId});
 await pool.saveKeyPoolImmediately();
 const restored = new KeyPoolManager(); restored.refreshBillingLimits = async () => {}; restored.saveKeyPool = async () => {};
 assert.equal(restored.config.algorithm, 'quota-aware');
 assert.deepEqual(restored.keys.map(k=>k.quota_balance),pool.keys.map(k=>k.quota_balance));
 assert.equal((await restored.getNextKey({model:cfg.groups.standard.modelId})).keyId,(await pool.getNextKey({model:cfg.groups.standard.modelId})).keyId);
 const displayed=(await call('GET','/keys')).body.data.keys;
 assert.equal(displayed[0].routing.standard.quota.mode,'adaptive');
 assert.equal('quota_balance' in displayed[0],false,'Keep raw calibration out of the dashboard response');
 const before=pool.keys[0].quota_balance.standard.assigned;
 process.env.CLUSTER_MODE='true';
 await assert.rejects(pool.getNextKey({model:cfg.groups.standard.modelId}), /single-process/);
 assert.equal(pool.keys[0].quota_balance.standard.assigned,before);
 delete process.env.CLUSTER_MODE;
 assert.equal((await call('PUT','/keys/a',{key:'fk-replacement-test'})).status,200);
 assert.equal(pool.keys[0].quota_balance,undefined);
 assert.equal(pool.keys[0].billing_limits,undefined);
 assert.equal(pool.keys[0].last_test_result,'pending','A replacement credential needs its own test and calibration');
 console.log('PASS: authenticated API, strict input, saved settings, key exclusions, routing/test barrier and emergency disable');
} finally { await scheduler.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); destroyPool(); await writers.destroyAll(); }
