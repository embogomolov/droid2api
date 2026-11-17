// Real scheduler with a fake clock and billing server; no paid requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WindowSync,sendWindowStart} from '../utils/window-sync.js';
import {recordQuotaRejection} from '../utils/factory-limits.js';
import {Response} from 'node-fetch';
import {DEFAULT_WINDOW_SYNC} from '../utils/window-settings.js';
import {destroyPool} from '../utils/http-client.js';
const H=3600000, directories=[];
function fixture(ids=['a','b']) {
  let now=new Date(2026,10,5,12).getTime();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'core-sync-'));directories.push(directory);
  const cfg={window_sync:structuredClone(DEFAULT_WINDOW_SYNC),models:[{id:'gpt-5.6-luna',type:'openai'},{id:'glm-5.3-flash',type:'common'}]};
  Object.assign(cfg.window_sync.groups.core,{enabled:true,keyIds:ids});
  const keys=ids.map(id=>({id,key:'fake-'+id,status:'active',last_test_result:'success',cooldowns:{standard:{kind:'quota',status:402,until:now+24*H}}}));
  const data=Object.fromEntries(keys.map(k=>[k.id,{standard:100,end:null,weekly:0,policy:'droidCore',confirm:true}]));
  const calls=[],standardCalls=[];
  const options={directory,manager:{keys},readConfig:()=>cfg,now:()=>now,
    refresh:async secret=>{
      const d=data[secret.slice(5)];if(d.error)throw new Error(d.error);
      return {fetchedAt:now-(d.stale?61000:0),overagePreference:d.policy,limits:{
        standard:Object.fromEntries(['fiveHour','weekly','monthly'].map(n=>[n,{usedPercent:n==='monthly'?d.standard:0,windowEnd:n==='monthly'?new Date(now+24*H).toISOString():null}])),
        core:{fiveHour:{usedPercent:d.end&&d.end>now?1:0,windowEnd:d.end?new Date(d.end).toISOString():null},weekly:{usedPercent:d.weekly,windowEnd:new Date(now+24*H).toISOString()},monthly:{usedPercent:0,windowEnd:null}}
      }};
    },send:async(key,model)=>{
      if(model.id===cfg.window_sync.groups.standard.modelId){standardCalls.push(key.id);return {accepted:true,status:200};}
      assert.equal(model.id,cfg.window_sync.groups.core.modelId);
      assert.ok(JSON.parse(fs.readFileSync(path.join(directory,'window_sync.json'))).groups.core.members[key.id].submittedAt,'Journal before send');
      calls.push(key.id);if(data[key.id].confirm)data[key.id].end=now+5*H;
      return {accepted:true,responseId:'test-'+key.id};
    }};
  return {cfg,keys,data,calls,standardCalls,options,advance:ms=>now+=ms,get now(){return now;},scheduler:()=>new WindowSync(options)};
}
try {
  const monthlyBody=JSON.parse(fs.readFileSync(new URL('./fixtures/factory-monthly-standard-limit.json',import.meta.url)));
  for(const phase of ['waiting','starting']){
    const f=fixture(['a','b','c']);f.keys.forEach(k=>delete k.cooldowns);
    Object.assign(f.cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b','c']});
    const refresh=f.options.refresh,standardEnd=f.now+H;
    f.options.refresh=async secret=>{
      const snapshot=await refresh(secret);
      snapshot.limits.standard.fiveHour={usedPercent:25,windowEnd:new Date(standardEnd).toISOString()};
      return snapshot;
    };
    let s=f.scheduler();await s.tick();
    if(phase==='starting'){
      const state=s.load(),g=state.groups.core;
      Object.assign(g,{phase,cycleId:'previous-cycle',cycleKeyIds:['a','b','c'],partners:['core']});
      for(const m of Object.values(g.members))Object.assign(m,{attempts:1,submittedAt:f.now-60000,acceptedAt:f.now-60000,nextAttemptAt:0});
      s.save(state);
    }
    const refusal=await sendWindowStart(f.keys[0],f.cfg.models[0],new AbortController().signal,
      async()=>new Response(JSON.stringify(monthlyBody),{status:402}));
    assert.deepEqual(refusal.rejectionBody,monthlyBody,'Start requests retain the same error body as ordinary requests');
    for(const k of f.keys.slice(0,2))recordQuotaRejection(k,refusal.status,refusal.retryAfter,f.cfg.models[0].id,refusal.rejectionBody,f.now);
    f.advance(30000);await s.tick();assert.equal(f.calls.length,0,'Two refusals cannot release a three-account group');
    recordQuotaRejection(f.keys[2],402,null,'claude-opus-5-5',monthlyBody,f.now);
    const saved=JSON.parse(JSON.stringify(f.keys));f.keys.splice(0,f.keys.length,...saved);
    s=f.scheduler();f.advance(30000);await s.tick();
    assert.deepEqual([...f.calls].sort(),['a','b','c'],phase+': all included Core windows start after the last Standard refusal');
    assert.ok(s.routingBlock(f.keys[0],'kimi-k3.1-pro'),'Successful sends alone do not release the group');
    f.advance(2001);s=f.scheduler();await s.tick();
    assert.equal(s.load().groups.core.phase,'active');
    assert.ok(f.keys.every(k=>s.routingBlock(k,'kimi-k3.1-pro')===null));
    assert.equal(f.calls.length,3,'Restart confirms windows without replaying completed starts');
  }
  const unconfirmed=fixture();unconfirmed.keys.forEach(k=>delete k.cooldowns);
  await unconfirmed.scheduler().tick();assert.equal(unconfirmed.calls.length,0,'100% cannot start Core without a Factory rejection');
  assert.equal(unconfirmed.standardCalls.length,2,'Scheduler checks Standard itself');
  assert.equal(unconfirmed.scheduler().routingBlock(unconfirmed.keys[0],'glm-5.3-flash'),null,'Unconfirmed Standard stays usable');
  const off=fixture();off.cfg.window_sync.groups.core.enabled=false;
  await off.scheduler().tick();assert.equal(off.calls.length,0);
  off.keys[0].billing_limits=await off.options.refresh('fake-a');
  assert.equal(off.scheduler().routingBlock(off.keys[0],'glm-5.3-flash'),null);

  const f=fixture();let s=f.scheduler();f.data.b.standard=99;delete f.keys[1].cooldowns.standard;
  await s.tick();assert.equal(f.calls.length,0);
  assert.equal(s.load().groups.core.blockedKeyId,'b');
  assert.equal(s.load().groups.core.blockReason,'Standard exhaustion has not been confirmed by Factory');
  assert.ok(s.routingBlock(f.keys[0],'glm-5.3-flash'));
  assert.equal(s.routingBlock(f.keys[1],'glm-5.3-flash'),null,'Available Standard remains usable');
  assert.equal(s.routingBlock(f.keys[0],'gpt-5.6-luna'),null,'Core settings do not control Standard models');
  assert.equal(s.accountAction(f.keys[0],'core').disabled,true,'Test cannot start an unsynchronized Core window');
  assert.throws(()=>s.requestAction('a','core','test'),/synchronized Core/);
  f.data.b.standard=100;f.keys[1].cooldowns.standard={kind:'quota',status:402,until:f.now+24*H};f.data.b.confirm=false;f.advance(30000);await s.tick();
  assert.deepEqual(f.calls,['a','b']);assert.equal(s.load().groups.core.phase,'starting');
  f.advance(2000);s=f.scheduler();await s.tick();
  assert.ok(s.load().groups.core.members.a.confirmedEnd);
  assert.equal(s.load().groups.core.members.b.confirmedEnd,null,'HTTP 200 is not a Core window');
  assert.ok(s.routingBlock(f.keys[0],'glm-5.3-flash'),'Confirmed member waits for its peer');
  assert.equal(s.accountAction(f.keys[0],'core').disabled,true);
  f.data.a.standard=0;delete f.keys[0].cooldowns.standard;f.advance(30000);await s.tick();
  assert.deepEqual(f.calls,['a','b'],'Standard returning pauses every new Core probe');
  assert.equal(s.load().groups.core.phase,'starting','Pool change must not drop a member and complete the cycle');
  assert.equal(s.routingBlock(f.keys[0],'glm-5.3-flash'),null,'Standard traffic resumes independently');
  f.data.a.standard=100;f.keys[0].cooldowns.standard={kind:'quota',status:402,until:f.now+24*H};f.data.b.confirm=true;f.advance(2000);await s.tick();
  assert.deepEqual(f.calls,['a','b','b'],'Only unconfirmed window retries after restart');
  f.advance(2000);await s.tick();assert.equal(s.load().groups.core.phase,'active');
  assert.equal(s.routingBlock(f.keys[0],'glm-5.3-flash'),null);
  assert.equal(s.load().groups.core.blockReason,null);
  f.advance(f.data.a.end-f.now-30000);
  for(const k of f.keys)k.billing_limits=await f.options.refresh(k.key);
  assert.equal(s.routingBlock(f.keys[0],'glm-5.3-flash'),'Window ending');
  const finish=s.trackRequest(f.keys[0]);f.advance(70000);await s.tick();
  assert.equal(f.calls.length,3,'Next cycle drains existing requests');
  finish();f.advance(30000);await s.tick();assert.equal(f.calls.length,5);

  for(const problem of ['policy','weekly','error','stale','cooldown','untested']) {
    const f=fixture(),s=f.scheduler();
    if(problem==='policy')f.data.b.policy='none';
    if(problem==='weekly'){f.data.b.weekly=100;f.keys[1].cooldowns.core={kind:'quota',status:402,until:f.now+24*H};}
    if(problem==='error')f.data.b.error='Telemetry unavailable';
    if(problem==='stale')f.data.b.stale=true;
    if(problem==='cooldown'){f.data.b.standard=0;f.keys[1].cooldowns={standard:{until:f.now+H,status:429}};}
    if(problem==='untested')f.keys[1].last_test_result='pending';
    await s.tick();assert.equal(f.calls.length,0,problem+' must hold the entire group');
    assert.equal(s.load().groups.core.blockedKeyId,'b');
    f.keys[1].excluded=true;await s.tick();assert.deepEqual(f.calls,['a'],'Explicit exclusion releases the remaining group');
  }
  const unknown=fixture();await unknown.scheduler().tick();
  delete unknown.keys[0].billing_limits.limits.standard.weekly;
  assert.equal(unknown.scheduler().routingBlock(unknown.keys[0],'glm-5.3-flash'),'Waiting for current Standard quota data');

  const hours=fixture();hours.cfg.window_sync.groups.core.workingHours={enabled:true,start:'00:00',end:'00:01'};
  await hours.scheduler().tick();assert.equal(hours.calls.length,0);
  hours.cfg.window_sync.groups.core.workingHours.enabled=false;await hours.scheduler().tick();assert.equal(hours.calls.length,2);
  hours.cfg.window_sync.groups.core.enabled=false;
  assert.equal(hours.scheduler().routingBlock(hours.keys[0],'glm-5.3-flash'),null,'Disable releases even a partially started cycle');
  hours.advance(30000);await hours.scheduler().tick();assert.equal(hours.calls.length,2);
  hours.cfg.window_sync.groups.core.enabled=true;await hours.scheduler().tick();
  assert.equal(hours.scheduler().load().groups.core.phase,'active');assert.equal(hours.calls.length,2,'Re-enable confirms without replay');

  const removed=fixture();removed.data.b.confirm=false;await removed.scheduler().tick();
  removed.keys.splice(1,1);removed.cfg.window_sync.groups.core.keyIds=['a'];
  removed.advance(2000);await removed.scheduler().tick();assert.equal(removed.scheduler().load().groups.core.phase,'active');
  const replaced=fixture();replaced.cfg.window_sync.groups.core.keyIds=['a'];replaced.data.a.confirm=false;
  await replaced.scheduler().tick();replaced.cfg.window_sync.groups.core.keyIds=['b'];await replaced.scheduler().tick();
  assert.deepEqual(replaced.calls,['a','b'],'Replacing the entire partial group must not leave an empty stuck cycle');

  const changed=fixture();changed.data.b.confirm=false;await changed.scheduler().tick();
  changed.cfg.models.push({id:'kimi-k3.1-pro',type:'common'});changed.cfg.window_sync.groups.core.modelId='kimi-k3.1-pro';
  changed.data.b.confirm=true;changed.advance(30000);await changed.scheduler().tick();
  assert.deepEqual(changed.calls,['a','b','b'],'Model changes preserve confirmed participants');
  const disabled=fixture(),read=disabled.options.refresh;
  disabled.options.refresh=async secret=>{const value=await read(secret);disabled.cfg.window_sync.groups.core.enabled=false;return value;};
  await disabled.scheduler().tick();assert.equal(disabled.calls.length,0,'Disable during telemetry prevents dispatch');
  const independent=fixture();independent.data.b.standard=0;delete independent.keys[1].cooldowns.standard;
  Object.assign(independent.cfg.window_sync.groups.standard,{enabled:true,keyIds:['b']});
  independent.options.send=async(key,model)=>{independent.calls.push([key.id,model.id]);return {accepted:true};};
  await independent.scheduler().tick();
  assert.deepEqual(independent.calls,[['b','gpt-5.6-luna']],'Waiting Core group cannot hold an independently ready Standard group');

  const race=fixture(),refresh=race.options.refresh;
  const reset=race.now+1;race.keys.forEach(k=>k.cooldowns.standard.until=reset);
  race.options.refresh=async secret=>{
    const snapshot=await refresh(secret);
    snapshot.limits.standard.monthly.windowEnd=new Date(reset).toISOString();
    return snapshot;
  };
  race.options.send=async key=>{race.calls.push(key.id);race.advance(2);return {accepted:true};};
  await race.scheduler().tick();assert.deepEqual(race.calls,['a'],'Recheck Standard at dispatch, including reset between sends');
  race.advance(2000);await race.scheduler().tick();
  assert.equal(race.scheduler().load().groups.core.members.a.confirmedEnd,null,'No Core telemetry means no confirmation');

  const legacy=fixture(),old=legacy.scheduler().load();old.version=2;
  old.groups.core={phase:'starting',cycleKeyIds:['a'],members:{a:{attempts:10,confirmedEnd:legacy.now+5*H}}};
  old.groups.standard.members.keep={confirmedEnd:legacy.now+H};legacy.scheduler().save(old);
  assert.deepEqual(legacy.scheduler().load().groups.core.members,{},'Discard obsolete experimental Core cycles');
  assert.ok(legacy.scheduler().load().groups.standard.members.keep,'Preserve Standard recovery');
  console.log('PASS: independent Core enable, Standard fallback, confirmation/restart, drain, exclusions, settings changes and legacy recovery');
} finally {destroyPool();for(const dir of directories)fs.rmSync(dir,{recursive:true,force:true});}
