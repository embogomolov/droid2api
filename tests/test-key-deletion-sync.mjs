// Run through run-network-checks.mjs; all keys, files and probes are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { once } from 'node:events';
import pool from '../auth.js';
import { adminAuth } from '../middleware/admin-auth.js';
import router from '../api/admin-routes.js';
import { getConfig, saveConfig } from '../config.js';
import { WindowSync, DEFAULT_WINDOW_SYNC } from '../utils/window-sync.js';
import writers from '../utils/async-file-writer.js';
import { destroyPool } from '../utils/http-client.js';

process.env.ADMIN_ACCESS_KEY = 'isolated-deletion-test';
const app = express(); app.use('/admin', adminAuth, express.json(), router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const make = (id, status = 'active') => ({ id, key: `fake-${id}`, status, last_test_result: 'success' });
let wakeups = 0;
const sent = new Set();
const scheduler = new WindowSync({ manager: pool, readConfig: getConfig,
  refresh: async key => ({ fetchedAt: Date.now(), limits: { standard: Object.fromEntries(
    ['fiveHour', 'weekly', 'monthly'].map(name => [name, {
      usedPercent: sent.has(key) ? 1 : 0,
      windowEnd: sent.has(key) ? new Date(Date.now() + 3_600_000).toISOString() : null
    }])) } }),
  send: async key => { sent.add(key.key); return { accepted: true, status: 200 }; }
});
pool.windowSync = scheduler;
scheduler.wake = () => { wakeups++; };
const setup = keys => {
  pool.keys = keys;
  const settings = structuredClone(DEFAULT_WINDOW_SYNC);
  settings.groups.standard.enabled = true;
  settings.groups.standard.keyIds = keys.map(key => key.id);
  settings.groups.core.keyIds = keys.map(key => key.id);
  saveConfig({ ...getConfig(), window_sync: settings });
};
const call = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/keys/${route}`, {
    method: 'DELETE', headers: { 'x-admin-key': process.env.ADMIN_ACCESS_KEY, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  assert.equal(response.status, 200, await response.text());
};
const checkSelection = expected => {
  const saved = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)));
  for (const group of ['standard', 'core']) assert.deepEqual(saved.window_sync.groups[group].keyIds, expected);
  assert.deepEqual(pool.keys.map(key => key.id), expected);
  assert.equal(saved.window_sync.groups.standard.enabled, expected.length > 0);
};
try {
  setup([make('expired'), make('remaining')]);
  await call('expired'); checkSelection(['remaining']); assert.equal(wakeups, 1);
  await scheduler.tick();
  assert.deepEqual([...sent], ['fake-remaining'], 'Remaining group starts without saving its selection again');
  await call('remaining'); checkSelection([]);

  setup([make('disabled', 'disabled'), make('banned', 'banned'), make('active')]);
  await call('disabled'); checkSelection(['banned', 'active']);
  await call('banned'); checkSelection(['active']);

  setup([make('first'), make('second'), make('third')]);
  await call('batch-delete', { keyIds: ['first', 'second'] }); checkSelection(['third']);
  await pool.saveKeyPoolImmediately();
  assert.deepEqual(JSON.parse(fs.readFileSync(pool.keyPoolPath)).keys.map(key => key.id), ['third']);

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (String(args[0]).includes('config.json.')) throw new Error('simulated disk failure');
    return originalWrite(...args);
  };
  try { assert.throws(() => pool.deleteKey('third'), /simulated disk failure/); }
  finally { fs.writeFileSync = originalWrite; }
  checkSelection(['third']);
  console.log('PASS: individual/bulk deletion, both selections, last member, persistence, save failure and remaining group start');
} finally {
  await scheduler.stop(); await new Promise(resolve => server.close(resolve));
  destroyPool(); await writers.destroyAll();
}
