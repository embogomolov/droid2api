// Offline regression check: node tests/test-factory-proxy-fix.js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncFileWriter, fileWriterManager } from '../utils/async-file-writer.js';
import { KeyPoolManager } from '../auth.js';
import { getConfig, getKeyPoolConfig } from '../config.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-proxy-test-'));
const cfg = getConfig();
const previous = structuredClone(cfg);
let server;
try {
  const writer = new AsyncFileWriter(path.join(directory, 'concurrent.json'), { debounceTime: 1 });
  const atomicWrite = writer._atomicWrite.bind(writer);
  let concurrent = 0;
  writer._atomicWrite = async data => {
    assert.equal(++concurrent, 1, 'writes must be serialized');
    try { await delay(20); await atomicWrite(data); }
    finally { concurrent--; }
  };
  const first = writer.writeImmediately({ value: 1 });
  const second = writer.write({ value: 2 });
  const third = writer.writeImmediately({ value: 3 });
  await Promise.race([
    Promise.all([first, second, third]),
    delay(2000, null, { ref: false }).then(() => { throw new Error('write queue stalled'); })
  ]);
  assert.equal(JSON.parse(await fs.readFile(writer.filePath)).value, 3);

  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.model, 'gpt-6-astra');
    assert.equal(data.reasoning.effort, 'low');
    assert.match(data.instructions, /^You are Droid,/);
    assert.equal(req.headers['x-api-provider'], 'openai');
    assert.equal(req.headers.authorization, 'Bearer fake-test-key');
    assert.equal(req.headers['user-agent'], 'factory-cli/0.213.0');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cfg.key_test_model = 'gpt-6-astra';
  cfg.system_prompt = 'You are Droid, an AI software engineering agent built by Factory.\n\n';
  cfg.user_agent = 'factory-cli/0.213.0';
  cfg.endpoint.find(e => e.name === 'openai').base_url = `http://127.0.0.1:${server.address().port}/responses`;
  const manager = Object.assign(Object.create(KeyPoolManager.prototype), {
    keyPoolPath: path.join(directory, 'keys.json'),
    keys: [{ id: 'test', key: 'fake-test-key', status: 'disabled', last_error: '403' }],
    stats: {}, poolGroups: [], config: getKeyPoolConfig(), refreshBillingLimits: async () => {}
  });
  const pending = Array.from({ length: 20 }, () => manager.saveKeyPool());
  assert.equal((await manager.testKey('test')).success, true);
  await Promise.all(pending);
  const saved = JSON.parse(await fs.readFile(manager.keyPoolPath));
  assert.equal(saved.keys[0].status, 'active');
  assert.equal(saved.keys[0].last_test_result, 'success');
  assert.equal(saved.keys[0].last_error, null);
  manager.keys.push({ ...manager.keys[0], id: 'second' });
  manager.stats = {};
  manager.config.algorithm = 'round-robin';
  manager.config.multiTier = { enabled: false };
  assert.equal((await manager.getNextKey()).keyId, 'test');
  const bound = await manager.getNextKey();
  manager.stats.task_affinity = { 'synthetic-task': { keyId: bound.keyId } };
  await manager.saveKeyPoolImmediately();
  manager.stats = JSON.parse(await fs.readFile(manager.keyPoolPath)).stats;
  manager.stats.last_rotation_index = bound.keyId === 'test' ? 1 : 0;
  assert.notEqual((await manager.getNextKey({ affinityId: 'synthetic-task', preferredKeyId: bound.keyId })).keyId, bound.keyId, 'old bindings cannot override rotation');
  manager.loadKeyPool();
  assert.equal(manager.stats.task_affinity, undefined, 'old bindings are removed on load');
  manager.stats = {};
  assert.equal((await manager.getNextKey()).keyId, 'test');
  assert.equal((await manager.getNextKey()).keyId, 'second');
  assert.equal((await manager.getNextKey()).keyId, 'test');
  console.log('PASS: concurrent saves, Astra test, persisted activation and rotation with missing counter');
} finally {
  Object.assign(cfg, previous);
  if (server) await new Promise(resolve => server.close(resolve));
  await fileWriterManager.destroyAll();
  await fs.rm(directory, { recursive: true });
}
