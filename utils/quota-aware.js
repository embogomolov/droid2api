import { randomUUID } from 'node:crypto';
import { getLimitState, WINDOWS, LIMIT_CACHE_MS } from './factory-limits.js';
import { normalizeWindowSync, GROUPS } from './window-settings.js';

const HOUR = 3_600_000;
const PERIOD = { fiveHour: 5 * HOUR, weekly: 168 * HOUR, monthly: 720 * HOUR };
const AGE = 7 * 24 * HOUR, LAG = 2 * LIMIT_CACHE_MS;
const EPOCH = randomUUID();
const finite = Number.isFinite;
const median = values => { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? sorted[Math.floor(sorted.length/2)] : null; };
const open = t => Math.max(0, (t?.started || 0) - (t?.completed || 0) - (t?.rejected || 0) - (t?.uncertain || 0));
const total = (ledger, field) => Object.values(ledger).reduce((n,t) => n + (t[field] || 0), 0);

// Coarse request shape, not token pricing. Never store content or stringify a large history.
export function quotaProfile(model = '', body = {}) {
  let chars = 0, visits = 0; const stack = [body];
  while (stack.length && visits++ < 100_000) {
    const value = stack.pop();
    if (typeof value === 'string') chars += value.length;
    else if (value && typeof value === 'object') for (const item of Object.values(value)) stack.push(item);
  }
  const effort = body.reasoning?.effort || body.thinking?.type || 'auto';
  return `${String(model).slice(0,100)}:${Math.min(16,Math.max(0,Math.floor(Math.log2(Math.max(1,chars/16384)))))}:${String(effort).slice(0,24)}`;
}

function stateFor(key, group) {
  if (key.quota_balance?.version !== 2) {
    const old = key.quota_balance;
    key.quota_balance = { version: 2 };
    for (const name of ['standard','core']) if (old?.[name]) key.quota_balance[name] = {
      credit: finite(old[name].credit) ? old[name].credit : 0, assigned: old[name].assigned || 0
    };
    // V1 per-assignment prices and percentage ratios were not trustworthy calibration.
  }
  const s = key.quota_balance[group] ||= { credit: 0, assigned: 0 };
  s.ledger ||= {}; s.windows ||= {}; s.samples ||= [];
  if (s.epoch !== EPOCH) {
    for (const t of Object.values(s.ledger)) t.uncertain = (t.uncertain || 0) + open(t);
    for (const w of Object.values(s.windows)) w.anchor = null;
    s.samples = []; s.epoch = EPOCH;
  }
  return s;
}

function ledgerFor(s, profile) {
  // A bounded profile ledger. Overflow remains observable but cannot train a mixed-model price.
  if (!s.ledger[profile] && Object.keys(s.ledger).length >= 128) profile = 'unclassified';
  return s.ledger[profile] ||= { started: 0, completed: 0, rejected: 0, uncertain: 0 };
}

// Independent interval calibration for each account/window. A 1-point jump or one response
// cannot produce a price. The two telemetry intervals around cohort boundaries stay uncertain.
export function observeQuota(key) {
  const snapshot = key.billing_limits;
  if (!finite(snapshot?.fetchedAt)) return;
  for (const group of ['standard','core']) {
    const windows = snapshot.limits?.[group]; if (!windows) continue;
    const s = stateFor(key,group), at = snapshot.fetchedAt;
    if (s.samples.at(-1)?.at >= at) continue;
    const current = { at, ledger: structuredClone(s.ledger), windows: structuredClone(windows) };
    const settled = s.samples.findLast(sample => sample.at <= at-LAG);
    for (const name of WINDOWS) {
      const value = windows[name]; if (!finite(value?.usedPercent)) continue;
      const w = s.windows[name] ||= { observations: [], externalAt: 0 };
      const previous = w.last, a = w.anchor;
      const changed = previous && (previous.end !== value.windowEnd || value.usedPercent < previous.used);
      if (changed) w.anchor = null;
      // A correction within the same window undermines its old price evidence too.
      if (previous && previous.end === value.windowEnd && value.usedPercent < previous.used) w.externalAt = at;
      if (!previous || changed || value.usedPercent > previous.used) w.signalAt = at;
      // Usage while no proxy work was possible is explicitly not attributed to a model.
      if (previous && previous.end === value.windowEnd && value.usedPercent > previous.used &&
          settled && total(current.ledger,'started') === total(settled.ledger,'started') &&
          Object.values(settled.ledger).every(t => !open(t))) {
        w.externalAt = at; w.anchor = null;
      }
      if (a && !changed && w.anchor && settled && Date.parse(value.windowEnd) > at) {
        const profiles = Object.keys(current.ledger).filter(p => {
          const t = current.ledger[p], b = a.early[p];
          return t.started > (b?.started || 0) || open(b) > 0;
        });
        const mixed = profiles.length > 1 || profiles[0] === 'unclassified';
        const uncertain = total(current.ledger,'uncertain') > total(a.early,'uncertain');
        const used = value.usedPercent - a.used;
        if (mixed || uncertain || at-a.at > AGE) w.anchor = null;
        else if (profiles.length === 1 && used > 2) {
          const p = profiles[0], lo = a.ledger[p], early = a.early[p], hi = current.ledger[p], mature = settled.ledger[p];
          const definite = (mature?.completed || 0) - (lo?.completed || 0) - open(lo);
          const possible = hi.started - (early?.started || 0) + open(early);
          if (definite >= 8 && possible >= definite && at-a.at >= 2*LAG) {
            // Waiting for completions to settle must not make unchanged usage look newer.
            w.observations.push({ profile:p, at:w.signalAt, low:(used-2)/possible, high:(used+2)/definite,
              quality:(definite/possible)*(1-2/used), completed:definite });
            w.observations = w.observations.filter(o => at-o.at <= AGE).slice(-32);
            w.anchor = null;
          }
        }
      }
      if (!w.anchor && settled) w.anchor = { at, end:value.windowEnd, used:value.usedPercent,
        ledger:structuredClone(current.ledger), early:structuredClone(settled.ledger) };
      w.last = { at, end:value.windowEnd, used:value.usedPercent };
    }
    s.samples.push(current); s.samples = s.samples.slice(-64);
  }
}

function estimate(w, profile, now) {
  const observations = (w?.observations || []).filter(o => o.profile === profile && now-o.at < AGE && o.at > (w.externalAt || 0));
  if (observations.length < 3) return { confidence:0, intervals:observations.length };
  const recent = observations.slice(-8);
  const low = median(recent.map(o=>o.low)), high = median(recent.map(o=>o.high));
  const prices = recent.map(o=>Math.sqrt(o.low*o.high));
  const spread = Math.max(...prices)/Math.min(...prices);
  const confidence = Math.min(0.75, median(recent.map(o=>o.quality))) *
    Math.max(0,1-(now-recent.at(-1).at)/AGE) / Math.max(1,spread);
  return { cost:Math.sqrt(low*high), low, high, confidence, intervals:observations.length, at:recent.at(-1).at };
}

function commonReset(keys, settings, group, now) {
  const cfg=normalizeWindowSync(settings);
  if (!cfg.groups[group].enabled) return { ids:new Set(), end:0 };
  const ids = new Set(cfg.groups[group].keyIds), members = keys.filter(k=>ids.has(k.id)&&!k.excluded);
  let end = now;
  const groups=cfg.startTogether?GROUPS.filter(g=>cfg.groups[g].enabled):[group];
  for (const pool of groups) for (const key of keys.filter(k=>!k.excluded&&cfg.groups[pool].keyIds.includes(k.id))) {
    const windows = getLimitState(key,pool,now).windows;
    for (const name of WINDOWS) {
      const w = windows?.[name];
      if (name === 'fiveHour' || w?.usedPercent >= 100) end = Math.max(end,Date.parse(w?.windowEnd)||now);
    }
    end = Math.max(end,key.cooldowns?.[pool]?.until||now);
  }
  return { ids:new Set(members.map(k=>k.id)), end };
}

export class QuotaAware {
  constructor({ keys, sync=()=>null, nextStart=at=>at, save=()=>{}, now=Date.now }) {
    this.keys=keys; this.sync=sync; this.nextStart=nextStart; this.save=save; this.now=now;
    this.pending=new Map(); this.lastPlan={};
  }

  // ponytail: online relative-share planning, not a future workload optimizer. Exact
  // deadlines cannot imply exact request capacity without upstream billing attribution.
  plan(keys,group,profile='unclassified') {
    const now=this.now(), barrier=commonReset(this.keys(),this.sync(),group,now), busy=new Map();
    if (barrier.ids.size) barrier.end=this.nextStart(barrier.end,group);
    for (const p of this.pending.values()) if (p.group===group) busy.set(p.key.id,(busy.get(p.key.id)||0)+1);
    const rows=keys.map(key=>{
      observeQuota(key);
      const s=stateFor(key,group), limits=getLimitState(key,group,now);
      const budgets=WINDOWS.map(name=>{
        const w=limits.windows?.[name];
        const known=finite(w?.usedPercent), fresh=known&&!limits.stale&&!key.limits_error;
        let end=Date.parse(w?.windowEnd);
        const started=finite(end), awaiting=known&&w.usedPercent===0&&!started;
        if (awaiting) end=now+PERIOD[name];
        if (name==='fiveHour'&&barrier.ids.has(key.id)&&finite(end)) end=Math.max(end,barrier.end);
        const remaining=known?Math.max(0,100-w.usedPercent):null;
        const learning=estimate(s.windows[name],profile,now);
        // Percent/hour only compared WITHIN the same window. Unknown timing falls back
        // to that window's full duration; it never becomes an immediate reset advantage.
        const hours=(fresh&&finite(end)?Math.max(LIMIT_CACHE_MS,end-now):PERIOD[name])/HOUR;
        return { window:name, remaining, resetAt:finite(end)?end:null, fresh, hours, ...learning };
      });
      return { key,s,budgets,inFlight:busy.get(key.id)||0 };
    });
    for (let i=0;i<WINDOWS.length;i++) {
      const budgets=rows.map(r=>r.budgets[i]);
      const reference=median(budgets.filter(b=>b.fresh&&b.confidence>0).map(b=>b.cost));
      for (const b of budgets) {
        // Relative, confidence-weighted price correction: dimensionless even when some
        // accounts/windows have no estimate. No peer borrowing masquerades as measurement.
        b.correction=reference&&b.cost&&b.fresh?Math.exp(b.confidence*Math.log(reference/b.cost)):1;
        b.rate=b.remaining===null?null:b.remaining/b.hours*b.correction;
      }
      const positive=budgets.filter(b=>b.fresh&&b.rate>0).map(b=>b.rate);
      const fallback=positive.length?Math.min(...positive):1;
      for (const b of budgets) {
        if (b.rate===null) b.rate=fallback;
        else if (!b.fresh) b.rate=Math.min(b.rate,fallback);
      }
      const sum=budgets.reduce((n,b)=>n+b.rate,0);
      for (const b of budgets) b.relative=sum>0?b.rate/sum:0;
    }
    for (const r of rows) {
      r.limiting=r.budgets.reduce((a,b)=>!a||b.relative<a.relative?b:a,null);
      r.weight=r.limiting.relative;
      r.mode=r.budgets.some(b=>!b.fresh)?'partial':r.budgets.some(b=>b.confidence>0)?'measured':'adaptive';
    }
    // Prepaid exhausted accounts are used only when no included allowance is available.
    if (rows.length&&!rows.some(r=>r.weight>0)) for (const r of rows) r.weight=1;
    const sum=rows.reduce((n,r)=>n+r.weight,0);
    for (const r of rows) r.share=r.weight/sum;
    return rows;
  }

  select(keys,group,track=false,profile='unclassified') {
    const rows=this.plan(keys,group,profile);
    if (!rows.length) throw new Error('Quota aware has no eligible accounts');
    // Preserve service credits across temporary cooldowns and membership edits. An account
    // that has been absent for a whole five-hour cycle does not receive a catch-up burst.
    for (const r of rows) {
      if (finite(r.s.lastScheduled)&&this.now()-r.s.lastScheduled>PERIOD.fiveHour) r.s.credit=0;
      r.s.lastScheduled=this.now();
    }
    const center=rows.reduce((sum,r)=>sum+r.s.credit,0);
    for (const r of rows) r.s.credit-=center*r.share;
    const chosen=rows.filter(r=>r.share>0).reduce((a,b)=>!a||b.s.credit+b.share-b.inFlight>a.s.credit+a.share-a.inFlight?b:a,null);
    for (const r of rows) r.s.credit+=r.share;
    chosen.s.credit--; chosen.s.assigned++;
    this.lastPlan[group]={at:this.now(),selected:chosen.key.id,accounts:rows.map(r=>({
      id:r.key.id,share:r.share,mode:r.mode,inFlight:r.inFlight,limitingWindow:r.limiting.window,
      resetAt:r.limiting.resetAt,remaining:r.limiting.remaining,
      windows:r.budgets.map(b=>({window:b.window,confidence:b.confidence,intervals:b.intervals,fresh:b.fresh,resetAt:b.resetAt}))
    }))};
    let reservation;
    if (track) {
      const token=Symbol(), p={key:chosen.key,group,sent:false,completed:false}; this.pending.set(token,p);
      const ledger=ledgerFor(chosen.s,profile);
      reservation={
        sent:()=>{if (!p.sent&&this.pending.has(token)){p.sent=true;ledger.started++;this.save();}},
        complete:()=>{if (p.sent&&!p.completed&&this.pending.has(token)){p.completed=true;ledger.completed++;this.save();}},
        release:(rejected=false)=>{
          if (!this.pending.delete(token)) return;
          if (!p.sent||rejected) {
            chosen.s.assigned--;
            // Refund the original reservation. Centering on the next choice reconciles
            // any participants that disappeared meanwhile; no global credit reset is needed.
            for (const r of rows) r.s.credit-=r.share;
            chosen.s.credit++;
          }
          if (p.sent&&!p.completed) ledger[rejected?'rejected':'uncertain']++;
          this.save();
        }
      };
    }
    return {key:chosen.key,reservation,decision:this.lastPlan[group]};
  }
}
