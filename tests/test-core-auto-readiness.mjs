// Real scheduler and durable quota records, simulated time and upstream only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {KeyPoolManager} from '../auth.js';
import {WindowSync} from '../utils/window-sync.js';
import {DEFAULT_WINDOW_SYNC,validateWindowSync} from '../utils/window-settings.js';
import {destroyPool} from '../utils/http-client.js';
const realNow=Date.now,H=3600000,dirs=[];
const refusal=JSON.parse(fs.readFileSync(new URL('./fixtures/factory-monthly-standard-limit.json',import.meta.url)));
function fixture(){
  let now=Date.parse('2026-11-05T15:00:00Z');Date.now=()=>now;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'auto-core-'));dirs.push(directory);
  const cfg={window_sync:structuredClone(DEFAULT_WINDOW_SYNC),models:[{id:'gpt-5.6-luna',type:'openai'},{id:'glm-5.3-flash',type:'common'}]};
  for(const g of ['standard','core'])Object.assign(cfg.window_sync.groups[g],{enabled:true,keyIds:['a','b','c']});
  const manager=Object.create(KeyPoolManager.prototype);
  Object.assign(manager,{keys:['a','b','c'].map(id=>({id,key:'fake-'+id,status:'active',last_test_result:'success'})),stats:{},poolGroups:[],config:{},keyPoolPath:path.join(directory,'keys.json')});
  manager.observeBillingLimits=()=>{};
  const data=Object.fromEntries(manager.keys.map(k=>[k.id,{standard:100,standardEnd:now+H,coreEnd:null,result:'quota',policy:'droidCore'}]));
  const snapshot=k=>{
    const d=data[k.id];if(d.error)throw Error('Telemetry unavailable');
    const w=(used,end)=>({usedPercent:used,windowEnd:end?new Date(end).toISOString():null});
    return {fetchedAt:now-(d.stale?61000:0),overagePreference:d.policy,limits:{
      standard:{fiveHour:w(d.standardEnd?25:0,d.standardEnd),weekly:w(55,now+8*H),monthly:w(d.standard,now+24*H)},
      core:{fiveHour:w(d.coreEnd>now?1:0,d.coreEnd),weekly:w(0,null),monthly:w(0,null)}
    }};
  };
  const refresh=async secret=>snapshot(manager.keys.find(k=>k.key===secret));
  manager.refreshBillingLimits=async k=>{k.billing_limits=snapshot(k);};
  const calls=[];
  const options={directory,manager,readConfig:()=>cfg,now:()=>now,refresh,send:async(key,model)=>{
    calls.push([key.id,model.id]);
    const member=JSON.parse(fs.readFileSync(path.join(directory,'window_sync.json'))).groups.core.members[key.id];
    if(model.id==='gpt-5.6-luna'){
      assert.ok(member.standardCheck.nextAttemptAt>now,'Persist the retry deadline before dispatch');
      if(data[key.id].result==='quota')return {status:402,rejectionBody:refusal,error:'HTTP 402'};
      if(data[key.id].result==='rate')return {status:429,retryAfter:'120',retryAt:now+120000,rejectionBody:{error:{type:'rate_limit_error'}}};
      if(data[key.id].result==='unknown')return {status:402,rejectionBody:{error:{detail:'No active subscription'}}};
      if(data[key.id].result==='ambiguous')return {ambiguous:true,error:'ECONNRESET'};
      return {status:200,accepted:true,responseId:'standard-ok'};
    }
    assert.ok(member.submittedAt);data[key.id].coreEnd=now+5*H;
    return {status:200,accepted:true,responseId:'core-'+key.id};
  }};
  const scheduler=()=>new WindowSync(options);
  return {manager,data,cfg,calls,options,directory,scheduler,advance:ms=>now+=ms,get now(){return now;}};
}
try{
  for(const phase of ['waiting','starting']){
    const f=fixture();let s=f.scheduler();
    if(phase==='starting'){
      const state=s.load();Object.assign(state.groups.core,{phase,cycleId:'old-cycle',cycleKeyIds:['a','b','c'],partners:['core']});
      for(const k of f.manager.keys)state.groups.core.members[k.id]={attempts:1,baselineEnd:null,submittedAt:f.now-60000,acceptedAt:null};
      s.save(state);
    }
    await s.tick();assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c[1]==='gpt-5.6-luna'));
    const persisted=JSON.parse(fs.readFileSync(f.manager.keyPoolPath));
    assert.ok(persisted.keys.every(k=>k.cooldowns.standard.kind==='quota'&&k.cooldowns.standard.window==='monthly'));
    f.manager.loadKeyPool();s=f.scheduler();f.advance(2001);await s.tick();
    assert.equal(f.calls.length,6);assert.ok(f.calls.slice(3).every(c=>c[1]==='glm-5.3-flash'));
    assert.ok(s.routingBlock(f.manager.keys[0],'kimi-k3.1-pro'));
    f.advance(2001);s=f.scheduler();await s.tick();
    assert.equal(s.load().groups.core.phase,'active',JSON.stringify(s.load().groups.core));assert.equal(f.calls.length,6);
    assert.ok(f.manager.keys.every(k=>s.routingBlock(k,'kimi-k3.1-pro')===null));
    f.advance(61000);await f.scheduler().tick();assert.equal(f.calls.length,6,'Active windows do not trigger readiness probes');
  }
  for(const outcome of ['accepted','unknown','ambiguous','rate']){
    const f=fixture();for(const d of Object.values(f.data))d.result=outcome;
    await f.scheduler().tick();assert.equal(f.calls.length,3);
    await f.scheduler().tick();f.advance(30001);await f.scheduler().tick();assert.equal(f.calls.length,3,'No early retry after restart: '+outcome);
    f.advance(outcome==='rate'?90001:30001);await f.scheduler().tick();assert.equal(f.calls.length,6);
    assert.ok(f.calls.every(c=>c[1]==='gpt-5.6-luna'));assert.ok(f.manager.keys.every(k=>!k.cooldowns?.standard),'Only a recognized refusal releases Core');
  }
  for(const guard of ['off','hours','under100','policy','stale','telemetry','core-active','inflight','closing','manual']){
    const f=fixture(),s=f.scheduler();
    if(guard==='off')f.cfg.window_sync.groups.core.enabled=false;
    if(guard==='hours')f.cfg.window_sync.groups.core.workingHours={enabled:true,start:'00:00',end:'00:01'};
    for(const d of Object.values(f.data)){
      if(guard==='under100')d.standard=99;
      if(guard==='policy')d.policy='none';
      if(guard==='stale')d.stale=true;
      if(guard==='telemetry')d.error=true;
      if(guard==='core-active')d.coreEnd=f.now+H;
      if(guard==='closing')d.standardEnd=f.now+20000;
    }
    const finish=guard==='inflight'?s.trackRequest(f.manager.keys[0]):()=>{};
    if(guard==='manual'){
      const state=s.load();state.manual={standard:{a:{kind:'test',phase:'queued',nextAttemptAt:f.now+H}},core:{}};s.save(state);
    }
    await s.tick();assert.equal(f.calls.length,guard==='manual'?2:0,guard);
    if(guard==='manual')assert.ok(f.calls.every(c=>c[0]!=='a'),'Do not duplicate a queued manual request');
    finish();
  }
  const barrier=fixture();barrier.data.a.standardEnd=null;
  // Fresh telemetry for an unused Standard window must show zero.
  const read=barrier.options.refresh;
  barrier.options.refresh=async secret=>{const value=await read(secret);if(secret==='fake-a')value.limits.standard.fiveHour.usedPercent=0;return value;};
  await barrier.scheduler().tick();assert.ok(barrier.calls.every(c=>c[0]!=='a'),'Never open one Standard window outside its synchronized start');
  assert.equal(barrier.calls.length,2);
  const excluded=fixture();excluded.manager.keys[2].excluded=true;
  await excluded.scheduler().tick();excluded.advance(2001);await excluded.scheduler().tick();
  assert.equal(excluded.calls.length,4);assert.ok(excluded.calls.every(c=>c[0]!=='c'));
  const coreOnly=fixture();coreOnly.cfg.window_sync.groups.standard.enabled=false;
  for(const d of Object.values(coreOnly.data))d.standardEnd=null;
  await coreOnly.scheduler().tick();coreOnly.advance(2001);await coreOnly.scheduler().tick();
  assert.equal(coreOnly.calls.length,6,'Core readiness checks do not require enabling Standard synchronization');
  const disabled=fixture(),send=disabled.options.send;
  disabled.options.send=async(...args)=>{disabled.cfg.window_sync.groups.core.enabled=false;return send(...args);};
  await disabled.scheduler().tick();assert.equal(disabled.calls.length,1,'Disabling during a check prevents the remaining sends');
  disabled.advance(61000);await disabled.scheduler().tick();assert.equal(disabled.calls.length,1);
  const concurrent=fixture();let release,began;
  const started=new Promise(r=>began=r),pending=new Promise(r=>release=r),physical=concurrent.options.send;
  concurrent.options.send=async(...args)=>{began();await pending;return physical(...args);};
  const running=concurrent.scheduler().tick();await started;await concurrent.scheduler().tick();
  release();await running;assert.equal(concurrent.calls.length,3,'Scheduler lock prevents duplicate probes');
  const changed=fixture(),oldSend=changed.options.send;
  changed.options.send=async(key,model)=>{
    const result=await oldSend(key,model);
    if(key.id==='a')changed.manager.keys[0].key='replacement';
    return result;
  };
  await changed.scheduler().tick();
  assert.equal(changed.manager.keys[0].cooldowns,undefined,'Old credential failure must not restrict its replacement');
  const crashed=fixture(),crashScheduler=crashed.scheduler();
  crashScheduler.save=()=>{throw new Error('Disk write failed');};
  await assert.rejects(crashScheduler.tick(),/Disk write failed/);
  assert.equal(crashed.calls.length,0,'Never send a check without its persisted retry deadline');
  const invalid=fixture();invalid.cfg.window_sync.groups.standard.enabled=false;invalid.cfg.window_sync.groups.standard.modelId='missing';
  assert.throws(()=>validateWindowSync(invalid.cfg.window_sync,invalid.manager.keys,invalid.cfg.models),/Standard start/);
  invalid.cfg.window_sync.groups.core.enabled=false;
  assert.doesNotThrow(()=>validateWindowSync(invalid.cfg.window_sync,invalid.manager.keys,invalid.cfg.models),'Disabling remains possible');
  console.log('PASS: autonomous three-account Core start, old pending cycle, durable refusals, restart throttling, success/error/Retry-After, sync barriers, hours, traffic, exclusions and concurrent ticks');
}finally{Date.now=realNow;destroyPool();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
