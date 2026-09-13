import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fetchBillingLimits, limitGroup, retryAfterTime, WINDOWS } from './factory-limits.js';
import { getEndpointByType } from '../config.js';
import { prepareDirectAnthropic, getAnthropicHeaders } from '../transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from '../transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from '../transformers/request-common.js';
import fetchWithPool from './http-client.js';
import { logInfo, logWarn } from '../logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_WINDOW_SYNC = { enabled: false, keyIds: [], modelId: 'claude-haiku-4-5-20251001', workingHours: { enabled: false, start: '09:00', end: '18:00' } };
const freshState = () => ({ version: 1, phase: 'waiting', members: {}, nextCheckAt: 0 });
const backoff = attempt => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

export function validateWindowSync(value, keys, models) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') fail('enabled must be a boolean');
  if (!Array.isArray(value.keyIds) || value.keyIds.some(id => typeof id !== 'string' || (value.enabled && !keys.some(k => k.id === id)))) fail('Select existing key IDs');
  if (new Set(value.keyIds).size !== value.keyIds.length) fail('Duplicate key IDs');
  if (value.enabled && !value.keyIds.some(id => !keys.find(k => k.id === id).excluded)) fail('Select at least one included key');
  const model = models.find(m => m.id === value.modelId);
  if (value.enabled && (!model || !['anthropic', 'openai', 'common'].includes(model.type))) fail('Select a configured probe model');
  const hours = value.workingHours;
  if (!hours || typeof hours.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.end)) fail('Working hours require enabled, start and end (HH:MM)');
  if (hours.enabled && hours.start === hours.end) fail('Working-hours start and end must differ');
  return { enabled: value.enabled, keyIds: [...value.keyIds], modelId: model?.id || (typeof value.modelId === 'string' && value.modelId) || DEFAULT_WINDOW_SYNC.modelId, workingHours: { enabled: hours.enabled, start: hours.start, end: hours.end } };
}

export function withinWorkingHours(hours, now) {
  if (!hours.enabled) return true;
  const date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
  const number = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
  const start = number(hours.start), end = number(hours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// One short physical request; the scheduler owns retries and verifies the window first.
export async function sendWindowStart(key, model, signal, fetchImpl = fetchWithPool) {
  const request = { model: model.id, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 32, stream: false };
  const auth = `Bearer ${key.key}`;
  let body, headers;
  if (model.type === 'anthropic') {
    body = prepareDirectAnthropic(request); delete body.thinking;
    headers = getAnthropicHeaders(auth, {}, false, model.id);
  } else if (model.type === 'openai') {
    body = transformToOpenAI(request); body.reasoning = { effort: 'low' };
    headers = getOpenAIHeaders(auth);
  } else {
    body = transformToCommon(request);
    headers = getCommonHeaders(auth, {}, model.api_provider);
  }
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 15_000);
  let response;
  try {
    response = await fetchImpl(getEndpointByType(model.type).base_url, { method: 'POST', headers, body: JSON.stringify(body), retry: false,
      signal: AbortSignal.any([signal, timeout.signal]), redirect: 'error' });
    const retryAt = retryAfterTime(response.headers.get('retry-after'));
    if (!response.ok) { response.body?.destroy(); return { accepted: false, status: response.status, retryAt, error: `HTTP ${response.status}` }; }
    const data = await response.json();
    if (!data.id || data.error || data.status === 'failed') return { accepted: false, error: 'No successful generation confirmed', ambiguous: true };
    return { accepted: true, status: response.status, responseId: data.id };
  } catch (error) {
    return { accepted: false, ambiguous: true, error: timeout.signal.aborted ? 'Probe timed out; checking the window before retry' : error.code || error.name };
  } finally { clearTimeout(timer); response?.body?.destroy(); }
}

export class WindowSync {
  constructor({ manager, directory = path.join(root, 'data'), readConfig = () => JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8')), refresh = fetchBillingLimits, send = sendWindowStart, now = Date.now } = {}) {
    this.manager = manager; this.directory = directory; this.readConfig = readConfig; this.refresh = refresh; this.send = send; this.now = now;
    this.file = path.join(directory, 'window_sync.json'); this.lock = path.join(directory, 'window_sync.lock');
  }
  settings() { const saved = this.readConfig().window_sync; return { ...DEFAULT_WINDOW_SYNC, ...saved, workingHours: { ...DEFAULT_WINDOW_SYNC.workingHours, ...saved?.workingHours } }; }
  load() {
    if (!fs.existsSync(this.file)) return freshState();
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (state.version !== 1 || !state.members || typeof state.members !== 'object') throw new Error('Invalid saved window-sync state; refusing to guess previous attempts');
    return state;
  }
  save(state) {
    if (this.lockToken && !this.ownsLock()) throw new Error('Window-sync ownership changed; stopping this attempt');
    state.updatedAt = this.now();
    if (this.lockToken) { const stamp = new Date(); fs.utimesSync(this.lock, stamp, stamp); }
    const temporary = `${this.file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(state, null, 2)); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  manages(key) { const cfg = this.settings(); return cfg.enabled && !key.excluded && cfg.keyIds.includes(key.id); }
  routingBlock(key, model) {
    const cfg = this.settings();
    if (!cfg.enabled || key.excluded || !cfg.keyIds.includes(key.id) || limitGroup(model) !== limitGroup(cfg.modelId)) return null;
    const state = this.load();
    if (state.phase === 'starting') return 'Synchronized window start is awaiting all selected accounts';
    const member = state.members[key.id];
    const end = Math.max(Date.parse(key.billing_limits?.limits?.[limitGroup(model)]?.fiveHour?.windowEnd) || 0, member?.confirmedEnd || 0, Date.parse(member?.windowEnd) || 0);
    return end > this.now() ? null : 'Waiting for the selected group to start its next five-hour windows';
  }
  snapshot() {
    const settings = this.settings(), state = this.load();
    return { settings, state, running: Boolean(this.timer || this.running), error: this.error || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      keys: this.manager.keys.map(key => ({ id: key.id, status: key.status, excluded: key.excluded === true, tested: key.last_test_result === 'success' })),
      models: this.readConfig().models.filter(m => ['anthropic', 'openai', 'common'].includes(m.type)).map(m => ({ id: m.id, name: m.name || m.id, group: limitGroup(m.id) })) };
  }
  ownsLock() {
    try { return JSON.parse(fs.readFileSync(this.lock, 'utf8')).token === this.lockToken; }
    catch { return false; }
  }
  acquire() {
    fs.mkdirSync(this.directory, { recursive: true });
    const token = randomUUID();
    try {
      const fd = fs.openSync(this.lock, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      this.lockToken = token; return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(this.lock);
        let owner; try { owner = JSON.parse(fs.readFileSync(this.lock, 'utf8')); } catch {}
        let dead = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        }
        // Each network phase is bounded below this lease. Expiry also recovers a reused PID after reboot.
        if (dead || Date.now() - stat.mtimeMs > 120_000) {
          fs.unlinkSync(this.lock); return this.acquire();
        }
      } catch (e) { if (e.code === 'ENOENT') return this.acquire(); throw e; }
      return false;
    }
  }
  start() { this.stopped = false; this.wake(); }
  wake() {
    clearTimeout(this.timer);
    if (this.stopped || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick().then(() => { this.failures = 0; }).catch(error => { this.failures = (this.failures || 0) + 1; this.error = error.message; logWarn(`Window sync: ${error.message}`); }).finally(() => {
        this.running = null;
        if (!this.stopped) this.timer = setTimeout(() => this.wake(), this.failures ? backoff(this.failures) : 1000);
      });
    }, 0);
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; this.controller?.abort(); await this.running; }
  async tick() {
    if (!this.settings().enabled) return;
    if (!this.acquire()) return;
    this.controller = new AbortController();
    try { await this.run(this.controller.signal); this.error = null; }
    finally { this.controller = null; if (this.ownsLock()) fs.unlinkSync(this.lock); this.lockToken = null; }
  }
  async run(signal) {
    const cfg = this.settings();
    if (!cfg.enabled) return;
    const state = this.load(), now = this.now();
    const signature = JSON.stringify([cfg, this.manager.keys.map(k => [k.id, k.excluded, k.status, k.last_test_result])]);
    if (state.selection !== signature) { state.selection = signature; state.nextCheckAt = 0; }
    if (state.nextCheckAt > now) return;
    const model = this.readConfig().models.find(m => m.id === cfg.modelId);
    if (!model) throw new Error('Configured synchronization model is missing');
    const group = limitGroup(model.id);
    if (state.modelId && state.modelId !== cfg.modelId) {
      // Window ownership belongs to its usage pool; retain pending attempts on model changes within that pool.
      if (limitGroup(state.modelId) !== group) { Object.assign(state, freshState()); delete state.cycleId; }
    }
    state.modelId = cfg.modelId;
    const keys = cfg.keyIds.map(id => this.manager.keys.find(k => k.id === id)).filter(key => key && !key.excluded);
    const missing = cfg.keyIds.filter(id => !this.manager.keys.some(k => k.id === id));
    if (!keys.length || missing.length) { state.message = missing.length ? 'Selected key was removed; update the selection' : 'No included keys selected'; state.nextCheckAt = now + 5000; this.save(state); return; }
    if (state.phase === 'active' && keys.every(key => (state.members[key.id]?.confirmedEnd || 0) > now)) {
      state.nextCheckAt = Math.min(...keys.map(key => state.members[key.id].confirmedEnd)); this.save(state); return;
    }
    if (state.phase === 'active') state.phase = 'waiting';
    await Promise.all(keys.map(async key => {
      const member = state.members[key.id] ||= {};
      if (member.refreshAfter > now) return;
      try {
        const snapshot = await this.refresh(key.key, { signal });
        const windows = snapshot.limits?.[group];
        if (!WINDOWS.every(name => windows?.[name] && Number.isFinite(windows[name].usedPercent))) throw new Error('Incomplete usage windows');
        member.observedAt = this.now(); member.windowEnd = windows.fiveHour.windowEnd;
        member.usedPercent = windows.fiveHour.usedPercent; member.refreshError = null; member.refreshFailures = 0; member.refreshAfter = 0;
        const end = Date.parse(member.windowEnd);
        member.ready = (Number.isFinite(end) && end <= this.now()) || (!member.windowEnd && member.usedPercent === 0);
        member.quotaReady = ['weekly', 'monthly'].every(name => windows[name].usedPercent < 100 || Date.parse(windows[name].windowEnd) <= this.now());
        const cooldown = key.cooldowns?.[group]?.until || 0;
        member.quotaReady &&= cooldown <= this.now();
        key.billing_limits = snapshot; delete key.limits_error;
        // A changed future boundary proves a new window, including an ambiguous request before restart.
        if (state.phase === 'starting' && member.attempts && end > this.now() && end !== member.baselineEnd) member.confirmedEnd = end;
      } catch (error) {
        member.refreshError = error.message; member.ready = false;
        member.refreshAfter = Math.max(this.now() + backoff(member.refreshFailures = (member.refreshFailures || 0) + 1), error.retryAt || 0);
      }
    }));
    state.nextCheckAt = this.now() + 2000;
    const settingsNow = this.settings();
    if (!settingsNow.enabled || settingsNow.modelId !== cfg.modelId || JSON.stringify(settingsNow.keyIds) !== JSON.stringify(cfg.keyIds)) { this.save(state); return; }
    const enabled = keys.every(key => !key.excluded && key.status === 'active' && key.last_test_result === 'success');
    if (!enabled) { state.message = 'Waiting for selected keys to be enabled and tested (excluded keys are omitted)'; this.save(state); return; }
    if (state.phase === 'starting' && keys.every(key => state.members[key.id].ready && !state.members[key.id].refreshError) && keys.some(key => { const m = state.members[key.id]; return m.confirmedEnd && m.confirmedEnd <= now || m.acceptedAt && m.acceptedAt + 5 * 60 * 60 * 1000 <= now; })) state.phase = 'waiting';
    if (state.phase !== 'starting') {
      const allReady = keys.every(key => { const m = state.members[key.id]; return m.ready && m.quotaReady && !m.refreshError && m.observedAt >= now; });
      if (!allReady) { state.phase = 'waiting'; state.message = 'Waiting for all five-hour windows and remaining weekly/monthly quota';
        const due = keys.flatMap(key => { const m = state.members[key.id]; return [Date.parse(m.windowEnd), m.refreshAfter]; }).filter(time => time > this.now());
        state.nextCheckAt = Math.min(this.now() + 30_000, ...due); this.save(state); return; }
      if (!withinWorkingHours(cfg.workingHours, this.now())) { state.phase = 'waiting'; state.message = 'Waiting for configured working hours'; state.nextCheckAt = this.now() + 30_000; this.save(state); return; }
      state.cycleId = randomUUID(); state.phase = 'starting'; state.message = 'Starting the selected group';
      for (const key of keys) {
        const old = state.members[key.id];
        state.members[key.id] = { ...old, baselineEnd: Date.parse(old.windowEnd) || null, attempts: 0, submittedAt: null, acceptedAt: null, confirmedEnd: null, nextAttemptAt: 0, error: null };
      }
      this.save(state);
    }
    const complete = () => keys.every(key => state.members[key.id].confirmedEnd > this.now());
    if (!complete()) { // Working hours gate new cycles; finish an already-started group without postponing stragglers.
      await Promise.all(keys.map(async key => {
        const member = state.members[key.id], current = this.now();
        if (member.confirmedEnd > current || member.acceptedAt || member.refreshError || member.observedAt < now || !member.quotaReady || !member.ready || member.nextAttemptAt > current) return;
        const latest = this.settings();
        if (key.excluded || !latest.enabled || latest.modelId !== cfg.modelId || !latest.keyIds.includes(key.id) || signal.aborted) return;
        // Journal before dispatch. On restart an interrupted attempt must be verified, not blindly replayed.
        member.attempts++; member.submittedAt = current; member.nextAttemptAt = current + 30_000; member.error = 'Request sent; awaiting confirmation';
        this.save(state);
        let result;
        try { result = await this.send(key, model, signal); }
        catch (error) { result = { ambiguous: true, error: error.code || error.name }; }
        member.error = result.error || null; member.httpStatus = result.status || null;
        if (result.accepted) { member.acceptedAt = this.now(); member.responseId = result.responseId; }
        else member.nextAttemptAt = Math.max(this.now() + (result.ambiguous ? 30_000 : backoff(member.attempts)), result.retryAt || 0);
        this.save(state);
        logInfo(`Window sync ${state.cycleId}: ${key.id} ${result.accepted ? 'accepted; verifying window' : 'retry pending'}`);
      }));
      // Fresh verification happens on the next tick, before any subsequent probe.
    }
    if (complete()) {
      state.phase = 'active'; state.completedAt = this.now(); state.message = 'All selected windows confirmed';
      const ends = keys.map(key => state.members[key.id].confirmedEnd);
      state.spreadMs = Math.max(...ends) - Math.min(...ends); state.nextCheckAt = Math.min(...ends);
    } else if (keys.some(key => state.members[key.id].acceptedAt)) state.message = 'Accepted probes await Factory window confirmation; successful requests are not replayed';
    this.save(state);
  }
}

export function getWindowSync(manager) { return manager.windowSync ||= new WindowSync({ manager }); }
