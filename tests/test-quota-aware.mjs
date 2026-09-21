// Deterministic replay of quota telemetry and actual transport completion. No network/accounts.
import assert from 'node:assert/strict';
import { QuotaAware, observeQuota, quotaProfile } from '../utils/quota-aware.js';
import { getLimitState } from '../utils/factory-limits.js';

const HOUR=3_600_000, start=Date.parse('2026-09-21T08:00:00Z');
let now=start;
const names=['fiveHour','weekly','monthly'];
const key=(id,used=[0,0,0],ends=[5,168,720])=>({id,status:'active',last_test_result:'success',billing_limits:{fetchedAt:now,limits:{standard:Object.fromEntries(names.map((name,i)=>[name,{usedPercent:used[i],windowEnd:new Date(start+ends[i]*HOUR).toISOString()}]))}}});
const make=(keys,settings={})=>new QuotaAware({keys:()=>keys,sync:()=>settings,now:()=>now});
const refresh=k=>{k.billing_limits.fetchedAt=now;observeQuota(k);};
const ready=keys=>keys.filter(k=>!k.excluded&&k.status==='active'&&getLimitState(k,'standard',now).available);
const completed=(q,k,profile='model-a:0:auto')=>{const r=q.select([k],'standard',true,profile).reservation;r.sent();r.complete();r.release();};
const advance=(q,k,{count=6,cost=[0.25,0.1,0],profile='model-a:0:auto',round=false}={})=>{
  now+=60_000;
  for(let n=0;n<count;n++)completed(q,k,profile);
  k.actual ||= names.map(name=>k.billing_limits.limits.standard[name].usedPercent);
  names.forEach((name,i)=>{k.actual[i]+=cost[i]*count;k.billing_limits.limits.standard[name].usedPercent=round?Math.floor(k.actual[i]):k.actual[i];});
  refresh(k);
};
const evidence=(q,k,profile='model-a:0:auto')=>q.plan([k],'standard',profile)[0].budgets;

// Reset times influence allocation from the first request, without any monthly learning.
let keys=[key('near',[0,0,50],[5,168,24]),key('far',[0,0,20],[5,168,480])],q=make(keys);
let rows=q.plan(keys,'standard');assert.ok(rows[0].share>rows[1].share);assert.equal(rows[0].mode,'adaptive');
const counts={near:0,far:0};for(let i=0;i<200;i++)counts[q.select(keys,'standard').key.id]++;
assert.ok(counts.near>counts.far&&counts.far>0);
assert.ok(Math.abs(counts.near/200-rows[0].share)<0.01);

// A restart preserves service credit; migration discards only the old unreliable estimator.
q.select(keys,'standard');const restoredKeys=structuredClone(keys),restored=make(restoredKeys);
assert.deepEqual(Array.from({length:11},()=>q.select(keys,'standard').key.id),Array.from({length:11},()=>restored.select(restoredKeys,'standard').key.id));
const legacy=key('legacy');legacy.quota_balance={version:1,standard:{assigned:17,credit:0.3,cost:99,ratios:{monthly:{five:2,other:1}}}};
observeQuota(legacy);assert.equal(legacy.quota_balance.version,2);assert.equal(legacy.quota_balance.standard.assigned,17);assert.equal(legacy.quota_balance.standard.cost,undefined);

// Partial windows and unknown accounts do not switch off healthy peers' reset calculation.
const unknown={id:'unknown'};rows=make([...keys,unknown]).plan([...keys,unknown],'standard');
assert.ok(rows[0].share>rows[1].share);assert.equal(rows[2].mode,'partial');
delete keys[1].billing_limits.limits.standard.monthly;
rows=q.plan(keys,'standard');assert.equal(rows[0].mode,'adaptive');assert.equal(rows[1].mode,'partial');
assert.ok(rows.every(r=>Number.isFinite(r.share)));
const prepaid=key('prepaid',[100,100,100]);prepaid.billing_limits.extraUsageEnabled=true;
const free=key('free'),freeFirst=make([prepaid,free]);
assert.equal(freeFirst.select([prepaid,free],'standard').key.id,'free');
assert.equal(freeFirst.select([prepaid],'standard').key.id,'prepaid');

// Three independent, sufficiently large settled intervals are needed; zero monthly deltas
// do not block five-hour or weekly evidence. Rounded telemetry is deliberately noisy.
now=start;const learned=key('learned');q=make([learned]);refresh(learned);
for(let minute=0;minute<40;minute++)advance(q,learned,{round:true});
let e=evidence(q,learned);
assert.ok(e[0].confidence>0&&e[1].confidence>0);assert.equal(e[2].confidence,0);
assert.equal(q.plan([learned],'standard','model-a:0:auto')[0].mode,'measured');
const cold=key('cold');rows=make([learned,cold]).plan([learned,cold],'standard','model-a:0:auto');
assert.equal(rows[0].mode,'measured');assert.equal(rows[1].mode,'adaptive');
assert.equal(evidence(q,learned,'model-b:0:auto')[0].confidence,0,'Different model cannot inherit a price');
assert.equal(evidence(q,learned,'model-a:5:auto')[0].confidence,0,'Different context band cannot inherit a price');
assert.notEqual(quotaProfile('a',{input:'x'}),quotaProfile('a',{input:'x'.repeat(200_000)}));
// Simulate a persisted ledger from another process. Keep prices and fair-service credit,
// but never resurrect the interrupted request or its measurement interval as completed.
const saved=structuredClone(learned),savedState=saved.quota_balance.standard;
savedState.epoch='previous-process';savedState.ledger['model-a:0:auto'].started++;
const savedObservations=structuredClone(savedState.windows.fiveHour.observations);
const restarted=make([saved]);restarted.plan([saved],'standard','model-a:0:auto');
assert.equal(savedState.ledger['model-a:0:auto'].uncertain,1);
assert.equal(restarted.pending.size,0);assert.equal(savedState.windows.fiveHour.anchor,null);
assert.deepEqual(savedState.windows.fiveHour.observations,savedObservations);

// Zero deltas do not refresh the age of an old price. Expiry is per-window and per-profile.
const lastSpend=now;
for(let i=0;i<5;i++)advance(q,learned,{count:0});
assert.ok(evidence(q,learned)[0].at<=lastSpend,'Settling may accept the tail interval, but cannot renew its usage timestamp');
const oldAt=evidence(q,learned)[0].at;
for(let i=0;i<5;i++)advance(q,learned,{count:0});
assert.equal(evidence(q,learned)[0].at,oldAt);
now+=8*24*HOUR;refresh(learned);assert.equal(evidence(q,learned)[0].confidence,0);

// One or two requests, even an enormous jump, cannot train a confident price.
now=start;const sparse=key('sparse');q=make([sparse]);refresh(sparse);
for(let i=0;i<12;i++)advance(q,sparse,{count:i===3?2:0,cost:[5,2,1]});
assert.ok(evidence(q,sparse).every(w=>w.confidence===0));

// Started is not completed. Missing/ambiguous outcomes are never success samples.
now=start;const long=key('long');q=make([long]);refresh(long);const pending=[];
for(let i=0;i<12;i++){
  now+=60_000;const r=q.select([long],'standard',true,'model-a:0:auto').reservation;r.sent();pending.push(r);
  long.billing_limits.limits.standard.fiveHour.usedPercent++;refresh(long);
}
assert.ok(evidence(q,long).every(w=>w.confidence===0));
pending.forEach(r=>r.release());assert.equal(long.quota_balance.standard.ledger['model-a:0:auto'].uncertain,12);
assert.equal(q.pending.size,0);
const rejected=q.select([long],'standard',true,'model-a:0:auto').reservation;rejected.sent();rejected.release(true);rejected.release(true);
assert.equal(long.quota_balance.standard.ledger['model-a:0:auto'].rejected,1);

// Simultaneous model mixes are not assigned a fictitious price for either model.
now=start;const mixed=key('mixed');q=make([mixed]);refresh(mixed);
for(let i=0;i<35;i++){completed(q,mixed,'model-b:0:auto');advance(q,mixed);}
assert.ok(evidence(q,mixed).every(w=>w.confidence===0));
assert.ok(evidence(q,mixed,'model-b:0:auto').every(w=>w.confidence===0));

// External spend after the lag allowance invalidates attribution, but remaining quota is used.
now=start;const external=key('external');q=make([external]);refresh(external);
for(let i=0;i<35;i++)advance(q,external);
assert.ok(evidence(q,external)[0].confidence>0);
for(let i=0;i<3;i++)advance(q,external,{count:0});
now+=60_000;external.billing_limits.limits.standard.fiveHour.usedPercent+=5;refresh(external);
assert.equal(evidence(q,external)[0].confidence,0);

// Resets never become negative consumption; another window's evidence stays independent.
const observations=structuredClone(external.quota_balance.standard.windows.weekly.observations);
now+=60_000;external.billing_limits.limits.standard.fiveHour={usedPercent:0,windowEnd:new Date(now+5*HOUR).toISOString()};refresh(external);
assert.deepEqual(external.quota_balance.standard.windows.weekly.observations,observations);
now+=60_000;external.billing_limits.limits.standard.weekly.usedPercent--;
refresh(external);assert.equal(evidence(q,external)[1].confidence,0,'A telemetry correction invalidates affected prices');

// An old near-reset snapshot must not gain priority from an unverified deadline.
now=start;const stale=key('stale',[1,1,1],[5,168,0.02]),fresh=key('fresh',[1,1,1]);
now+=90_000;refresh(fresh);rows=make([stale,fresh]).plan([stale,fresh],'standard');
assert.equal(rows[0].mode,'partial');assert.ok(rows[0].share<=rows[1].share);

// Group changes apply on the next choice. A weekly-blocked member postpones the collective
// boundary until removed, without turning removal from sync into an account exclusion.
now=start;keys=[key('a'),key('b'),key('blocked',[0,100,0],[5,48,720])];
const settings={enabled:true,keyIds:['a','b','blocked'],modelId:'claude-haiku-4-5'};q=make(keys,settings);
assert.equal(q.plan(ready(keys),'standard')[0].budgets[0].resetAt,start+48*HOUR);
settings.keyIds=['a','b'];assert.equal(q.plan(ready(keys),'standard')[0].budgets[0].resetAt,start+5*HOUR);
settings.keyIds.push('blocked');keys[2].excluded=true;
assert.equal(q.plan(ready(keys),'standard')[0].budgets[0].resetAt,start+5*HOUR);
keys[2].excluded=false;keys[2].billing_limits.limits.standard.weekly.usedPercent=10;
settings.keyIds=['a','b'];assert.ok(ready(keys).includes(keys[2]));
q.nextStart=at=>at+HOUR;assert.equal(q.plan(ready(keys),'standard')[0].budgets[0].resetAt,start+6*HOUR);
settings.enabled=false;assert.equal(q.plan(ready(keys),'standard')[0].budgets[0].resetAt,start+5*HOUR);

// Concurrent reservations distribute requests before telemetry catches up; dynamic membership
// and refunds keep finite, normalized weights without destroying every account's credit.
const a=q.select(keys,'standard',true),b=q.select(keys,'standard',true);assert.notEqual(a.key.id,b.key.id);
keys[1].excluded=true;q.select(ready(keys),'standard');a.reservation.release();b.reservation.release();
assert.equal(q.pending.size,0);rows=q.plan(ready(keys),'standard');
assert.ok(Math.abs(rows.reduce((n,r)=>n+r.share,0)-1)<1e-12);

// Controlled before-reset replay, without any calibration: dates already improve quota use.
function replay(adaptive){
  now=start;const accounts=[key('near',[10,2,98],[5,168,1]),key('far',[10,2,10],[5,168,720])],scheduler=make(accounts),assigned={near:0,far:0};
  for(let i=0;i<59;i++){
    now+=60_000;accounts.forEach(refresh);
    const selected=adaptive?scheduler.select(accounts,'standard').key:accounts.reduce((a,b)=>Math.max(...names.map(n=>a.billing_limits.limits.standard[n].usedPercent))<Math.max(...names.map(n=>b.billing_limits.limits.standard[n].usedPercent))?a:b);
    assigned[selected.id]++;[0.2,0.04,0.02].forEach((cost,j)=>selected.billing_limits.limits.standard[names[j]].usedPercent+=cost);
  }return assigned;
}
const adaptive=replay(true),maximum=replay(false);assert.ok(adaptive.near>maximum.near&&adaptive.far>0);
console.log('Before-reset replay:',JSON.stringify({quotaAware:adaptive,maxRemaining:maximum}));

// Several real-length cycles, with independently expiring weekly/monthly windows and
// both staggered and common five-hour boundaries. No account is selected at exhaustion.
for(const synchronized of [false,true]) {
  now=start;const accounts=[key('a',[0,99,90],[5,2,8]),key('b',[0,40,20],[synchronized?5:3,80,400]),key('c',[0,20,50],[synchronized?5:4,120,36])];
  const scheduler=make(accounts,synchronized?{enabled:true,keyIds:accounts.map(k=>k.id),modelId:'claude-haiku-4-5'}:{});
  const counts={a:0,b:0,c:0};let resets=0;
  for(let minute=0;minute<900;minute++) {
    now=start+minute*60_000;
    for(const account of accounts) {
      for(const [i,name] of names.entries()) {
        const w=account.billing_limits.limits.standard[name];
        if(Date.parse(w.windowEnd)<=now) {w.usedPercent=0;w.windowEnd=new Date(now+[5,168,720][i]*HOUR).toISOString();resets++;}
      }
      refresh(account);
    }
    const candidates=ready(accounts);
    if(!candidates.length)continue;
    const {key:selected,reservation}=scheduler.select(candidates,'standard',true,'model-a:0:auto');
    assert.ok(names.every(n=>selected.billing_limits.limits.standard[n].usedPercent<100));
    reservation.sent();reservation.complete();reservation.release();counts[selected.id]++;
    [0.7,0.07,0.02].forEach((cost,i)=>selected.billing_limits.limits.standard[names[i]].usedPercent+=cost);
  }
  assert.ok(resets>=7);assert.ok(Object.values(counts).every(n=>n>100));
  console.log(synchronized?'Synchronized replay:':'Staggered replay:',JSON.stringify(counts));
}
console.log('PASS: independent windows, cold/partial data, rounded/rare/unfinished/mixed/external work, aging, reset deadlines, persistence, synchronized membership and concurrent refunds');
