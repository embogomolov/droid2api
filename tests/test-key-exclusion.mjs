// Run through run-network-checks.mjs: empty pool and external network blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pool, { KeyPoolManager } from '../auth.js';
import { destroyPool } from '../utils/http-client.js';
import writers from '../utils/async-file-writer.js';
const make = id => ({ id, key: `fake-${id}`, status: 'active', last_test_result: 'success' });
pool.keys = [make('a'), make('b')]; pool.stats = {}; pool.poolGroups = [];
pool.config.multiTier = { enabled: false };
pool.refreshBillingLimits = async () => {};
try {
  await pool.setKeyExclusion('a', true);
  assert.equal(JSON.parse(fs.readFileSync(pool.keyPoolPath)).keys[0].excluded, true);
  const restored = new KeyPoolManager(); restored.loadKeyPool();
  assert.equal(restored.keys.find(k => k.id === 'a').excluded, true);
  for (const algorithm of ['round-robin','random','least-used','weighted-score','least-token-used','max-remaining','weighted-usage','quota-aware','time-window']) {
    pool.config.algorithm = algorithm;
    assert.equal((await pool.getNextKey()).keyId, 'b', algorithm);
  }
  assert.equal((await pool.testKey('a')).skipped, true);
  pool.toggleKeyStatus('a', 'active');
  assert.equal(pool.keys[0].excluded, true);
  const test = pool.testKey; const tested = [];
  pool.testKey = async id => { tested.push(id); return { success: true }; };
  await pool.testAllKeys(); assert.deepEqual(tested, ['b']);
  pool.testKey = test;
  pool.deleteBannedKeys(); assert.equal(pool.keys.length, 2, 'Excluded keys must not be deleted');
  const save = pool.saveKeyPoolImmediately;
  pool.saveKeyPoolImmediately = async () => { throw new Error('disk full'); };
  await assert.rejects(pool.setKeyExclusion('a', false), /disk full/);
  assert.equal(pool.keys[0].excluded, true);
  pool.saveKeyPoolImmediately = save;
  await assert.rejects(pool.setKeyExclusion('a', 'false'), /boolean/);
  await pool.setKeyExclusion('a', false);
  assert.equal(pool.keys[0].excluded, false);
  console.log('PASS: persistent exclusions, every selection policy, tests, deletion and failed-save rollback');
} finally { destroyPool(); await writers.destroyAll(); }
