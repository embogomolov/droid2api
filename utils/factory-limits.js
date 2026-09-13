import fetch from 'node-fetch';
import { fetchFactoryJSON } from './factory-telemetry.js';

export const LIMIT_CACHE_MS = 60_000;
export const WINDOWS = ['fiveHour', 'weekly', 'monthly'];

export function limitGroup(model = '') {
  return /^(glm-|kimi-|minimax-|deepseek-)/i.test(model) ? 'core' : 'standard';
}

// Unknown or expired measurements are never converted into a zero allowance.
export function getLimitState(key, group = 'standard', now = Date.now()) {
  const snapshot = key.billing_limits;
  const reported = snapshot?.limits?.[group];
  // Factory can keep the previous period's percentage after its reset time.
  // Present the next, not-yet-started period as zero without changing the snapshot.
  const windows = reported ? Object.fromEntries(Object.entries(reported).map(([name, window]) => {
    const end = Date.parse(window.windowEnd);
    return [name, Number.isFinite(end) && end <= now
      ? { ...window, usedPercent: 0, windowEnd: null, awaitingStart: true }
      : { ...window }];
  })) : null;
  const extraUsage = group === 'standard' && snapshot?.extraUsageEnabled === true;
  let until = 0;
  let reason = '';
  for (const name of WINDOWS) {
    const window = windows?.[name];
    if (!window || window.usedPercent < 100 || extraUsage) continue;
    const reset = Date.parse(window.windowEnd);
    if (Number.isFinite(reset) && reset <= now) continue;
    until = Math.max(until, Number.isFinite(reset) ? reset : now + LIMIT_CACHE_MS);
    reason = 'Factory usage limit reached';
  }
  const cooldown = key.cooldowns?.[group];
  if (cooldown?.until > now) {
    until = Math.max(until, cooldown.until);
    reason = `Upstream HTTP ${cooldown.status}; waiting before retry`;
  }
  return { available: until === 0, retryAt: until || null, reason,
    extraUsage,
    stale: !snapshot?.fetchedAt || now - snapshot.fetchedAt > LIMIT_CACHE_MS,
    known: WINDOWS.every(name => windows?.[name]), windows: windows || null };
}

export function retryAfterTime(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  const until = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(until) && until > now ? until : null;
}

export async function fetchBillingLimits(apiKey, { signal, fetchImpl = fetch } = {}) {
  const { response, data } = await fetchFactoryJSON('https://api.factory.ai/api/billing/limits', {
    headers: { authorization: `Bearer ${apiKey}`, 'user-agent': 'factory-cli/0.213.0', 'x-factory-client': 'cli' },
    signal, fetchImpl
  });
  if (!response.ok) throw new Error(`Limits API returned HTTP ${response.status}`);
  const limits = {};
  for (const group of ['standard', 'core']) {
    limits[group] = {};
    for (const name of WINDOWS) {
      const window = data.limits?.[group]?.[name];
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
      const reset = Date.parse(window.windowEnd);
      limits[group][name] = { usedPercent: window.usedPercent,
        windowEnd: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
    }
  }
  if (!Object.keys(limits.standard).length) throw new Error('Limits API returned no usable usage windows');
  return { limits, fetchedAt: Date.now(),
    // Respect an already-enabled prepaid account setting; never enable paid usage here.
    extraUsageEnabled: data.overagePreference === 'extraUsage' && data.extraUsageAllowed === true && data.extraUsageBalanceCents > 0 };
}
