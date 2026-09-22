import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowSync, DEFAULT_WINDOW_SYNC } from '../utils/window-sync.js';
import { destroyPool } from '../utils/http-client.js';

const H=3600000, directories=[];
async function fixture() {
  let now=Date.now();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'manual-window-'));directories.push(directory);
  const keys=['a','b'].map(id=>({id,key:'fake-'+id,status:'active',last_test_result:'success'}));
  const cfg={window_sync:structuredClone(DEFAULT_WINDOW_SYNC),models:[{id:'gpt-5.6-luna',type:'openai'},{id:'glm-5.3-flash',type:'common',api_provider:'fireworks'}]};
  const ends={a:{},b:{}}, calls=[];
  const options={directory,manager:{keys},readConfig:()=>cfg,now:()=>now,
    refresh:async secret=>({fetchedAt:now,limits:Object.fromEntries(['standard','core'].map(g=>[g,Object.fromEntries(['fiveHour','weekly','monthly'].map(n=>[n,{usedPercent:n==='fiveHour'?(ends[secret.slice(5)][g]>now?1:0):1,windowEnd:n==='fiveHour'?(ends[secret.slice(5)][g]?new Date(ends[secret.slice(5)][g]).toISOString():null):new Date(now+24*H).toISOString()}]))]))}),
    send:async(k,m)=>{const g='standard';calls.push(g+':'+k.id);ends[k.id][g]=now+5*H;return {accepted:true,responseId:'fake'};}};
  const fresh=async()=>{for(const k of keys)k.billing_limits=await options.refresh(k.key);};await fresh();
  const scheduler=async()=>{const s=new WindowSync(options);await s.stop();return s;};
  return {cfg,keys,ends,calls,options,fresh,scheduler,advance:n=>now+=n,now:()=>now};
}
try {
  const f=await fixture(), s=await f.scheduler();
  Object.assign(f.cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b']});
  assert.equal(s.accountAction(f.keys[0],'standard').label,'Start now');
  s.requestAction('a','standard','start');s.requestAction('a','standard','start');
  assert.equal(s.accountAction(f.keys[0],'standard').label,'Starting…');
  await s.tick();assert.deepEqual(f.calls,['standard:a']);
  f.advance(2001);const restored=await f.scheduler();await restored.tick();
  assert.equal(restored.load().manual.standard.a.phase,'done');assert.deepEqual(f.calls,['standard:a']);
  assert.equal(restored.accountAction(f.keys[0],'standard').label,'Test');
  assert.equal(restored.accountAction(f.keys[0],'standard').disabled,false);
  assert.equal(restored.accountAction(f.keys[0],'core').label,'Test');
  assert.equal(f.cfg.window_sync.groups.standard.enabled,true);
  f.advance(5*H);await restored.tick();assert.deepEqual(f.calls,['standard:a','standard:a','standard:b']);

  const lag=await fixture(), l=await lag.scheduler();
  lag.options.send=async()=>{lag.calls.push('sent');return {accepted:true};};
  // Construct after overriding the transport.
  const ls=await lag.scheduler();ls.requestAction('a','standard','start');await ls.tick();
  lag.advance(31000);await (await lag.scheduler()).tick();assert.equal(lag.calls.length,1);
  assert.equal(ls.load().manual.standard.a.phase,'starting','Accepted requests only poll telemetry');

  const ambiguous=await fixture(), original=ambiguous.options.send;
  ambiguous.options.send=async(...args)=>{await original(...args);return {accepted:false,ambiguous:true};};
  const a=await ambiguous.scheduler();a.requestAction('a','standard','start');await a.tick();
  ambiguous.advance(31000);await (await ambiguous.scheduler()).tick();assert.equal(ambiguous.calls.length,1);

  const test=await fixture();test.ends.a.standard=test.now()+H;await test.fresh();const t=await test.scheduler();
  Object.assign(test.cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b']});
  assert.equal(t.accountAction(test.keys[0],'standard').disabled,false,'Test is allowed in an active synchronized window');
  assert.equal(t.accountAction(test.keys[1],'core').disabled,true,'Core test cannot open a synchronized Standard window early');
  t.requestAction('a','standard','test');await t.tick();assert.deepEqual(test.calls,['standard:a']);
  test.advance(31000);await (await test.scheduler()).tick();assert.equal(test.calls.length,1);
  await test.fresh();t.requestAction('a','standard','test');const journal=t.load();journal.manual.standard.a.submittedAt=test.now();t.save(journal);
  await (await test.scheduler()).tick();assert.equal(test.calls.length,1,'Unknown test result must not replay');

  const expired=await fixture();expired.ends.a.standard=expired.now()+H;await expired.fresh();
  Object.assign(expired.cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b']});
  const ex=await expired.scheduler();ex.requestAction('a','standard','test');expired.advance(H+1);
  await ex.runManual(ex.load(),new AbortController().signal);
  assert.equal(expired.calls.length,0,'A queued test cannot open the next window after the current one expires');
  assert.equal(ex.load().manual.standard.a.phase,'failed');

  const guards=await fixture(), g=await guards.scheduler();
  guards.keys[0].excluded=true;assert.throws(()=>g.requestAction('a','standard','start'),/Enable usage/);
  guards.keys[0].excluded=false;delete guards.keys[0].billing_limits;assert.throws(()=>g.requestAction('a','standard','start'),/Refresh limits/);
  assert.throws(()=>g.requestAction('a','wrong','start'),/pool/);
  await guards.fresh();guards.keys[0].billing_limits.limits.standard.weekly.usedPercent=100;
  assert.throws(()=>g.requestAction('a','standard','start'),/limit/);

  const concurrent=await fixture();Object.assign(concurrent.cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b']});
  const c=await concurrent.scheduler(), refresh=concurrent.options.refresh;let queued=false;
  c.refresh=async(...args)=>{if(!queued){queued=true;c.requestAction('a','standard','start');}return refresh(...args);};
  await c.tick();assert.equal(concurrent.calls.length,0,'Enqueue during readiness prevents automatic dispatch');
  await c.tick();assert.deepEqual(concurrent.calls,['standard:a']);
  console.log('PASS: pool-specific manual start/test, duplicate clicks, restart, telemetry lag, ambiguous outcome, sync handoff, guards and concurrent enqueue');
} finally { destroyPool();for(const directory of directories)fs.rmSync(directory,{recursive:true,force:true}); }
