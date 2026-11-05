import fetch from 'node-fetch';
import { fetchFactoryJSON } from './factory-telemetry.js';

export const LIMIT_CACHE_MS = 60_000;
export const WINDOWS = ['fiveHour', 'weekly', 'monthly'];

export function limitGroup(model = '') {
  // Model eligibility, NOT the account's currently consumed allowance.
  return /^(glm-|kimi-|minimax-|deepseek-)/i.test(model) ? 'core' : 'standard';
}

export function getRequestQuota(key, model = '', now = Date.now()) {
  const standard = getLimitState(key, 'standard', now);
  const exhausted = quotaExhausted(key, 'standard', now);
  const fallback = key.billing_limits?.overagePreference;
  const core = limitGroup(model) === 'core';
  const group = core && exhausted && fallback === 'droidCore' ? 'core' : 'standard';
  const state = group === 'core' ? getLimitState(key, group, now) : standard;
  const policyKnown = !core || !exhausted || ['droidCore', 'extraUsage', 'none'].includes(fallback);
  // A displayed limit and HTTP 200 do not prove the billed pool. In particular, do
  // not train Core prices until Factory reports an actual Core window.
  const attributionKnown = policyKnown && standard.known && !standard.stale && state.known && !state.stale &&
    !key.limits_error && !state.extraUsage && (group !== 'core' || Date.parse(state.windows?.fiveHour?.windowEnd) > now) &&
    !(core && group==='standard' && Object.values(standard.windows||{}).some(w=>w.usedPercent>=100));
  const modelCooldown=key.model_cooldowns?.[model];
  if(modelCooldown?.until>now)return {...state,group,attributionKnown:false,available:false,retryAt:Math.max(state.retryAt||0,modelCooldown.until),reason:`Upstream HTTP ${modelCooldown.status}; retrying this model later`};
  return { ...state, group, attributionKnown,
    reason: !policyKnown ? 'Refresh Factory fallback settings before using Core allowance' : state.reason };
}

export function quotaExhausted(key, group, now = Date.now()) {
  return key.cooldowns?.[group]?.kind==='quota' && key.cooldowns[group].until>now;
}

// Percentages are rounded telemetry. Only a rejected generation establishes a limit.
export function classifyFactoryRejection(status, body, model) {
  const error=body?.error&&typeof body.error==='object'?body.error:body;
  // Factory's observed monthly-limit response has detail text but no machine-readable code.
  if(status===402 && error?.status===402 && error.displayToUser===true && typeof error.detail==='string' &&
    /^You've reached your monthly standard usage limit \(resets in [^\r\n)]+\)\.(?:\s|$)/.test(error.detail))
    return {kind:'quota',group:'standard',window:'monthly'};
  const values=[error?.reason,error?.code,error?.type].filter(v=>typeof v==='string').map(v=>v.toLowerCase());
  const quota=[402,429].includes(status)&&values.some(v=>['useroverquota','quota_exceeded','insufficient_quota','account_quota_exceeded','usage_limit_exceeded','token_limit_exceeded','billing_hard_limit_reached'].includes(v));
  const explicit=error?.quotaGroup??error?.pool;
  const group=quota?(['standard','core'].includes(explicit)?explicit:limitGroup(model)==='standard'?'standard':null):null;
  return {kind:quota?'quota':status===429?'rate_limit':'rejected',group};
}

export function recordQuotaRejection(key, status, retryAfter, model, body, now=Date.now()) {
  const result=classifyFactoryRejection(status,body,model);
  if(result.kind!=='quota'&&status!==429)return result;
  let until=retryAfterTime(retryAfter,now);
  if(result.window){
    const reset=Date.parse(key.billing_limits?.limits?.[result.group]?.[result.window]?.windowEnd);
    if(reset>now)until=Math.max(until||0,reset);
  }else if(!until&&result.kind==='quota'&&result.group){
    const ends=Object.values(getLimitState(key,result.group,now).windows||{})
      .filter(w=>w.usedPercent>=100&&Date.parse(w.windowEnd)>now).map(w=>Date.parse(w.windowEnd));
    // The response did not identify a window. Recheck at the FIRST possible reset.
    if(ends.length)until=Math.min(...ends);
  }
  until ||= now+LIMIT_CACHE_MS;
  const store=result.group?(key.cooldowns ||= {}):(key.model_cooldowns ||= {});
  const previous=store[result.group||model];
  if(previous?.kind===result.kind)until=Math.max(until,previous.until||0);
  store[result.group||model]={status,kind:result.kind,until,observedAt:now,model,...(result.window?{window:result.window}:{})};
  return result;
}

export function rejectionDiagnostic(key, model, status, retryAfter, body) {
  const raw=typeof body==='string'?body:JSON.stringify(body);
  let redacted=(raw||'').replace(/fk-[\w-]+/g,'[key hidden]').replace(/Bearer\s+[^\s"'\\]+/gi,'Bearer [hidden]');
  if(key?.key)redacted=redacted.split(key.key).join('[key hidden]');
  return {source:'factory',accountId:key?.id||null,accountName:key?.notes||null,keySuffix:key?.key?.length>9?key.key.slice(-9):null,
    model,status,retryAfter:retryAfter??null,body:redacted.slice(0,8192),bodyTruncated:redacted.length>8192};
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
  const cooldown = key.cooldowns?.[group];
  if (cooldown?.until > now) {
    until = Math.max(until, cooldown.until);
    reason = cooldown.kind==='quota'?'Factory usage limit reached':`Upstream HTTP ${cooldown.status}; waiting before retry`;
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
  if (!response.ok) throw Object.assign(new Error(`Limits API returned HTTP ${response.status}`), { status: response.status, retryAt: retryAfterTime(response.headers.get('retry-after')) });
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
  if (!Object.values(limits).some(windows => Object.keys(windows).length)) throw new Error('Limits API returned no usable usage windows');
  return { limits, fetchedAt: Date.now(),
    overagePreference: ['droidCore', 'extraUsage'].includes(data.overagePreference) ? data.overagePreference : data.overagePreference == null ? 'none' : 'unknown',
    // Respect an already-enabled prepaid account setting; never enable paid usage here.
    extraUsageEnabled: data.overagePreference === 'extraUsage' && data.extraUsageAllowed === true && data.extraUsageBalanceCents > 0 };
}
