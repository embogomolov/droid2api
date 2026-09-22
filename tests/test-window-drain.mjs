// Deterministic boundary checks; no Factory requests or real account data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WindowSync} from '../utils/window-sync.js';
import {DEFAULT_WINDOW_SYNC,normalizeWindowSync,validateWindowSync} from '../utils/window-settings.js';
import {destroyPool,retryUnsentRequest} from '../utils/http-client.js';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'window-drain-'));
let now=Date.now();
const keys=['a','b'].map(id=>({id,key:'fake-'+id,status:'active',last_test_result:'success'}));
const cfg={window_sync:structuredClone(DEFAULT_WINDOW_SYNC),models:[{id:'gpt-5.6-luna',type:'openai'},{id:'glm-5.3-flash',type:'common'}]};
Object.assign(cfg.window_sync.groups.standard,{enabled:true,keyIds:['a','b']});
const ends={a:now+60000,b:now+3600000},sends=[],reads=[];
const refresh=async secret=>{
  const id=secret.slice(5);reads.push(id);
  return {fetchedAt:now,limits:{standard:Object.fromEntries(['fiveHour','weekly','monthly'].map(n=>[n,{usedPercent:n==='fiveHour'?0:1,windowEnd:new Date(n==='fiveHour'?ends[id]:now+86400000).toISOString()}]))}};
};
const scheduler=new WindowSync({directory,manager:{keys},readConfig:()=>cfg,now:()=>now,refresh,
  send:async key=>{sends.push(key.id);ends[key.id]=now+18000000;return {accepted:true};}});
try{
  await scheduler.stop();
  assert.equal(normalizeWindowSync({}).stopBeforeResetSeconds,30);
  for(const value of [-1,1.5,18000,'30',NaN])assert.throws(()=>validateWindowSync({...cfg.window_sync,stopBeforeResetSeconds:value},keys,cfg.models),/whole number/);
  assert.equal(validateWindowSync({...cfg.window_sync,stopBeforeResetSeconds:45},keys,cfg.models).stopBeforeResetSeconds,45);
  for(const key of keys)key.billing_limits=await refresh(key.key);
  now+=29999;assert.equal(scheduler.routingBlock(keys[0],'gpt-5.6-luna'),null);
  now++;assert.equal(scheduler.routingBlock(keys[0],'gpt-5.6-luna'),'Window ending');
  assert.equal(scheduler.routingBlock(keys[0],'glm-5.3-flash'),'Window ending','Core model using Standard respects the same cutoff');
  assert.equal(scheduler.routingBlock(keys[1],'gpt-5.6-luna'),null,'Another account can still work');
  for(const group of ['standard','core'])assert.equal(scheduler.accountAction(keys[0],group).disabled,true);
  cfg.window_sync.stopBeforeResetSeconds=0;assert.equal(scheduler.routingBlock(keys[0],'gpt-5.6-luna'),null);
  cfg.window_sync.stopBeforeResetSeconds=45;
  const restored=new WindowSync({directory,manager:{keys},readConfig:()=>cfg,now:()=>now});
  assert.equal(restored.routingBlock(keys[0],'gpt-5.6-luna'),'Window ending','Reloaded configuration keeps the cutoff');
  cfg.window_sync.groups.standard.keyIds=['b'];assert.equal(scheduler.routingBlock(keys[0],'gpt-5.6-luna'),null);
  cfg.window_sync.groups.standard.keyIds=['a','b'];cfg.window_sync.stopBeforeResetSeconds=30;

  // Enqueued before the cutoff, executed inside it: recheck before physical send.
  ends.a=now+31000;keys[0].billing_limits=await refresh(keys[0].key);
  scheduler.requestAction('a','standard','test');now+=1001;
  await scheduler.runManual(scheduler.load(),new AbortController().signal);
  assert.equal(sends.length,0);assert.equal(scheduler.load().manual.standard.a.error,'Window ending');
  let attempts=0;
  ends.a=now+30001;keys[0].billing_limits=await refresh(keys[0].key);
  await assert.rejects(retryUnsentRequest(()=>{
    const reason=scheduler.routingBlock(keys[0],'gpt-5.6-luna');if(reason)throw new Error(reason);
    attempts++;now+=2;throw Object.assign(new Error('Not connected'),{syscall:'connect',code:'ECONNREFUSED'});
  },{retryDelay:0}),/Window ending/);
  assert.equal(attempts,1,'Retry cannot send after crossing the cutoff');

  // An already-sent generation can finish normally; group start waits for it.
  const finish=scheduler.trackRequest(keys[0]);
  ends.a=ends.b=now-1;for(const key of keys)key.billing_limits=await refresh(key.key);
  await scheduler.tick();assert.equal(sends.length,0,'No automatic start while a participant still has a request');
  finish();finish();assert.equal(scheduler.requests.get('a').count,0,'Finish is idempotent');
  reads.length=0;now+=31000;await scheduler.tick();
  assert.deepEqual(sends.sort(),['a','b']);assert.ok(reads.includes('a'),'Refresh Factory after the outstanding request finishes');
  console.log('PASS: cutoff defaults/validation, live settings, both model pools, Test/retry boundary, drain and fresh group start');
}finally{await scheduler.stop();destroyPool();fs.rmSync(directory,{recursive:true,force:true});}
