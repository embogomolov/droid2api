// Deterministic clock + simulated Factory; no paid calls or real pool access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Response } from 'node-fetch';
import { WindowSync, DEFAULT_WINDOW_SYNC, validateWindowSync, withinWorkingHours, sendWindowStart } from '../utils/window-sync.js';
import { destroyPool } from '../utils/http-client.js';
const FIVE_HOURS = 5 * 60 * 60 * 1000;
function fixture() {
  let time = Date.parse('2026-09-10T08:00:00Z');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'window-sync-test-'));
  const keys = ['a','b','c'].map(id => ({ id, key: `fake-${id}`, status: 'active', last_test_result: 'success' }));
  let cfg = { window_sync: { ...structuredClone(DEFAULT_WINDOW_SYNC), enabled: true, keyIds: ['a','b'] }, models: [{ id: DEFAULT_WINDOW_SYNC.modelId, type: 'anthropic' }] };
  const windows = Object.fromEntries(keys.map(k => [k.key, { end: null, weekly: 10, monthly: 20 }]));
  const calls = [], reads = [];
  const options = { manager: { keys }, directory, now: () => time, readConfig: () => cfg,
    refresh: async secret => {
      reads.push(secret); const w = windows[secret];
      if (w.error) throw w.error;
      const groups = Object.fromEntries(['fiveHour','weekly','monthly'].map(n => [n, { usedPercent: n === 'fiveHour' ? (w.end ? 50 : 0) : w[n], windowEnd: n === 'fiveHour' ? w.end : new Date(time + FIVE_HOURS * 10).toISOString() }]));
      if (w.incomplete) delete groups.monthly;
      return { fetchedAt: time, limits: { standard: groups, core: groups } };
    },
    send: async (key, model) => { assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'window_sync.json'))).members[key.id].attempts, 1, 'Persist before dispatch'); calls.push(key.id); windows[key.key].end = new Date(time + FIVE_HOURS).toISOString(); return { accepted: true, responseId: `fake-${key.id}` }; } };
  return { options, keys, windows, calls, reads, get cfg() { return cfg; }, get time() { return time; }, advance: ms => { time += ms; }, scheduler: () => new WindowSync(options) };
}
try {
  const f = fixture(), s = f.scheduler();
  f.cfg.window_sync.keyIds.push('c'); f.keys[2].excluded = true;
  f.windows['fake-b'].end = new Date(f.time + 10_000).toISOString();
  await s.tick(); assert.equal(f.calls.length, 0);
  assert.ok(s.routingBlock(f.keys[0], f.cfg.window_sync.modelId));
  assert.equal(s.routingBlock(f.keys[1], f.cfg.window_sync.modelId), null, 'Old active window remains usable');
  assert.equal(s.routingBlock(f.keys[0], 'kimi-k3'), null, 'Other usage pool is independent');
  f.advance(10_001); await s.tick(); assert.deepEqual(f.calls, ['a','b']);
  assert.equal(s.load().phase, 'starting');
  assert.ok(s.routingBlock(f.keys[0], f.cfg.window_sync.modelId), 'Accepted account waits for full group');
  f.advance(2001); const restarted = f.scheduler(); await restarted.tick();
  assert.equal(restarted.load().phase, 'active'); assert.equal(restarted.load().spreadMs, 0);
  assert.deepEqual(f.calls, ['a','b'], 'Restart verifies without replay');
  assert.equal(restarted.routingBlock(f.keys[0], f.cfg.window_sync.modelId), null);
  f.advance(FIVE_HOURS); await restarted.tick(); assert.equal(f.calls.length, 4, 'Next full cycle starts automatically');

  const lost = fixture(); lost.cfg.window_sync.keyIds = ['a'];
  lost.options.send = async key => { lost.calls.push(key.id); lost.windows[key.key].end = new Date(lost.time + FIVE_HOURS).toISOString(); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
  await lost.scheduler().tick(); lost.advance(2001); await lost.scheduler().tick();
  assert.equal(lost.calls.length, 1, 'Lost response confirmed from usage; never replayed');

  const retry = fixture(); retry.cfg.window_sync.keyIds = ['a'];
  retry.windows['fake-a'].error = Object.assign(new Error('429 telemetry'), { retryAt: retry.time + 60_000 });
  const r = retry.scheduler(); await r.tick(); retry.advance(30_001); await r.tick();
  assert.equal(retry.reads.length, 1, 'Telemetry Retry-After respected'); assert.equal(retry.calls.length, 0);
  delete retry.windows['fake-a'].error; retry.advance(30_000); await r.tick(); assert.equal(retry.calls.length, 1);

  const denied = fixture(); denied.cfg.window_sync.keyIds = ['a'];
  let sends = 0;
  denied.options.send = async () => { sends++; return { status: 429, error: '429', retryAt: denied.time + 60_000 }; };
  const d = denied.scheduler(); await d.tick(); denied.advance(30_001); await d.tick(); assert.equal(sends, 1);
  denied.advance(30_001); await denied.scheduler().tick(); assert.equal(sends, 2, 'Persistent retry resumes after deadline');

  for (let i = 0; i < 4; i++) { denied.advance(60_001); await denied.scheduler().tick(); }
  assert.equal(sends, 6, 'Retries continue beyond a finite three-attempt budget');
  const accepted = fixture(); accepted.cfg.window_sync.keyIds = ['a'];
  const acceptedScheduler = accepted.scheduler(); await acceptedScheduler.tick();
  accepted.windows['fake-a'].error = new Error('Telemetry offline');
  for (let i = 0; i < 5; i++) { accepted.advance(60_001); await accepted.scheduler().tick(); }
  assert.equal(accepted.calls.length, 1, 'Accepted generation is never replayed while verification retries');
  delete accepted.windows['fake-a'].error; accepted.advance(60_001); await accepted.scheduler().tick();
  assert.equal(accepted.scheduler().load().phase, 'active');
  const stopping = fixture(); let began;
  const beganPromise = new Promise(resolve => { began = resolve; });
  stopping.options.send = async (key, model, signal) => { began(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ambiguous: true, error: 'cancelled' }), { once: true })); };
  const stoppingScheduler = stopping.scheduler(); stoppingScheduler.start(); await beganPromise; await stoppingScheduler.stop();
  assert.equal(fs.existsSync(stoppingScheduler.lock), false); assert.equal(stoppingScheduler.load().phase, 'starting');

  const stale = fixture(); stale.windows['fake-a'].incomplete = true;
  await stale.scheduler().tick(); assert.equal(stale.calls.length, 0, 'Partial telemetry cannot start a group');
  const exhausted = fixture(); exhausted.windows['fake-a'].weekly = 100;
  await exhausted.scheduler().tick(); assert.equal(exhausted.calls.length, 0, 'No prepaid probe when weekly exhausted');
  const disabled = fixture(); disabled.keys[1].status = 'disabled';
  await disabled.scheduler().tick(); assert.equal(disabled.calls.length, 0, 'Do not silently shrink disabled membership');
  disabled.keys[1].excluded = true; await disabled.scheduler().tick(); assert.deepEqual(disabled.calls, ['a']);

  const abandoned = fixture(), recovered = abandoned.scheduler();
  fs.writeFileSync(recovered.lock, JSON.stringify({ pid: process.pid, token: 'old-process' }));
  fs.utimesSync(recovered.lock, new Date(Date.now() - 180_000), new Date(Date.now() - 180_000));
  await recovered.tick(); assert.equal(abandoned.calls.length, 2, 'Recover stale lock even when a PID is reused');
  const fenced = fixture(), oldOwner = fenced.scheduler(); assert.equal(oldOwner.acquire(), true);
  fs.writeFileSync(oldOwner.lock, JSON.stringify({ pid: process.pid, token: 'new-owner' }));
  assert.throws(() => oldOwner.save(oldOwner.load()), /ownership changed/);
  fs.unlinkSync(oldOwner.lock);

  const disk = fixture(), broken = disk.scheduler(); broken.save = () => { throw new Error('disk full'); };
  await assert.rejects(broken.tick(), /disk full/); assert.equal(disk.calls.length, 0, 'No probe without durable journal');
  const parallel = fixture(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  parallel.options.send = async key => { parallel.calls.push(key.id); entered(); await new Promise(resolve => { if (!release) release = []; release.push(resolve); }); return { accepted: true }; };
  const pending = parallel.scheduler().tick(); await started;
  await parallel.scheduler().tick(); assert.equal(parallel.calls.length, 2, 'Only one process owner dispatches the group');
  release.forEach(fn => fn()); await pending;

  assert.equal(DEFAULT_WINDOW_SYNC.enabled, false); assert.equal(DEFAULT_WINDOW_SYNC.workingHours.enabled, false);
  const hours = { enabled: true, start: '22:00', end: '06:00' };
  assert.equal(withinWorkingHours(hours, new Date(2026,8,10,23).getTime()), true);
  assert.equal(withinWorkingHours(hours, new Date(2026,8,10,12).getTime()), false);
  const scheduled = fixture(); scheduled.cfg.window_sync.workingHours = { enabled: true, start: '00:00', end: '00:01' };
  await scheduled.scheduler().tick(); assert.equal(scheduled.calls.length, 0);
  scheduled.cfg.window_sync.workingHours.enabled = false; await scheduled.scheduler().tick(); assert.equal(scheduled.calls.length, 2);
  assert.throws(() => validateWindowSync({ ...f.cfg.window_sync, enabled: 'true' }, f.keys, f.cfg.models), /boolean/);
  assert.throws(() => validateWindowSync({ ...f.cfg.window_sync, keyIds: ['missing'] }, f.keys, f.cfg.models), /existing/);
  assert.throws(() => validateWindowSync({ ...f.cfg.window_sync, keyIds: ['a','a'] }, f.keys, f.cfg.models), /Duplicate/);

  for (const model of [{ id: 'claude-haiku-4-5-20251001', type: 'anthropic' }, { id: 'gpt-5.6-luna', type: 'openai' }, { id: 'kimi-k3', type: 'common', api_provider: 'fireworks' }]) {
    let request;
    const result = await sendWindowStart(f.keys[0], model, new AbortController().signal, async (url, options) => {
      request = options; return new Response('{"id":"simulated"}', { status: 200 });
    });
    assert.equal(result.accepted, true); assert.equal(request.retry, false);
    const body = JSON.parse(request.body); assert.equal(body.max_tokens || body.max_output_tokens, 32); assert.equal(body.stream, false);
    if (model.type === 'common') assert.equal(request.headers['x-api-provider'], 'fireworks');
    if (model.type === 'anthropic') assert.equal(body.thinking, undefined);
  }
  console.log('PASS: group barrier, exclusions, repeats, durable retry, restart, ambiguous acceptance, clocks, lock, incomplete telemetry, quota guards and bounded wire requests');
} finally { destroyPool(); }
