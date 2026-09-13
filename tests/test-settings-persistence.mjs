// Exercise the real admin routes in an isolated checkout; never touch the live server or keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import express from 'express';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'droid-settings-test-'));
for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js')||n==='package.json'))fs.copyFileSync(path.join(root,name),path.join(dir,name));
for(const name of ['api','middleware','utils','transformers'])fs.cpSync(path.join(root,name),path.join(dir,name),{recursive:true});
fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'junction');
fs.mkdirSync(path.join(dir,'data'));
const configPath=path.join(dir,'data/config.json'),poolPath=path.join(dir,'data/key_pool.json');
const config={port:3000,models:[],endpoint:[],system_prompt:'keep-me',key_pool:{algorithm:'max-remaining',retry:{enabled:true,maxRetries:3,retryDelay:1000},multiTier:{enabled:false}}};
fs.writeFileSync(configPath,JSON.stringify(config));
fs.writeFileSync(poolPath,JSON.stringify({keys:[],stats:{},config:{algorithm:'round-robin',retry:{enabled:false}}}));
for(const key of Object.keys(process.env))if(key.startsWith('KEY_POOL_'))delete process.env[key];
process.env.ADMIN_ACCESS_KEY='isolated-test';process.env.DROID2API_STATS_FILE=path.join(dir,'data/request_stats.json');
const {default:pool}=await import(pathToFileURL(path.join(dir,'auth.js')));
const {getConfig}=await import(pathToFileURL(path.join(dir,'config.js')));
const {default:router}=await import(pathToFileURL(path.join(dir,'api/admin-routes.js')));
assert.equal(pool.config.algorithm,'max-remaining','Stale pool snapshot overrode saved settings');
assert.equal(pool.config.retry.enabled,true);
const app=express();app.use(express.json());app.use('/admin',router);
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const call=async(method,url,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/admin${url}`,{method,headers:{'x-admin-key':'isolated-test','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
try {
 // Same combined payload shape as the Settings page; applies selection immediately.
 pool.config.algorithm='round-robin'; // Reproduce UI=max-remaining, running pool=round-robin.
 assert.equal((await call('PUT','/config',{system_prompt:'changed',reasoning_tokens:{high:24576},key_pool:{algorithm:'max-remaining',retry:{maxRetries:0,retryDelay:0}}})).status,200);
 assert.equal(pool.config.algorithm,'max-remaining');assert.equal(pool.config.retry.maxRetries,0);assert.equal(pool.config.retry.retryDelay,0);assert.equal(pool.config.retry.enabled,true);
 assert.equal((await call('GET','/config/key-pool')).body.data.algorithm,'max-remaining');
 const windows=used=>Object.fromEntries(['fiveHour','weekly','monthly'].map(n=>[n,{usedPercent:used,windowEnd:new Date(Date.now()+3600000).toISOString()}]));
 pool.keys=[91,17].map((used,i)=>({id:'fake-'+i,key:'fake-'+i,status:'active',last_test_result:'success',billing_limits:{fetchedAt:Date.now(),limits:{standard:windows(used)}}}));
 pool.refreshBillingLimits=async()=>{};pool.saveKeyPool=async()=>{};
 assert.equal((await pool.getNextKey({model:'claude-fable-5.1'})).keyId,'fake-1');
 // Both legacy update paths share persistence, validation and immediate application.
 assert.equal((await call('PUT','/config/key-pool',{algorithm:'round-robin'})).status,200);
 assert.equal(getConfig().key_pool.algorithm,'round-robin');
 assert.equal((await pool.getNextKey({model:'claude-fable-5.1'})).keyId,'fake-0');
 assert.equal((await pool.getNextKey({model:'claude-fable-5.1'})).keyId,'fake-1');
 assert.equal((await call('PUT','/config',{key_pool:{algorithm:'max-remaining'}})).status,200);
 assert.equal(pool.config.algorithm,'max-remaining');
 const before=fs.readFileSync(configPath,'utf8'),runtime=JSON.stringify(pool.config);
 assert.notEqual((await call('PUT','/config',{system_prompt:'must-not-save',key_pool:{algorithm:'invalid'}})).status,200);
 assert.equal(fs.readFileSync(configPath,'utf8'),before);assert.equal(JSON.stringify(pool.config),runtime);
 // A failed disk replacement leaves the effective configuration unchanged.
 fs.renameSync(configPath,configPath+'.saved');fs.mkdirSync(configPath);
 assert.notEqual((await call('PUT','/config',{key_pool:{algorithm:'random'}})).status,200);
 assert.equal(JSON.stringify(pool.config),runtime);assert.equal(getConfig().system_prompt,'changed');
 fs.rmdirSync(configPath);fs.renameSync(configPath+'.saved',configPath);
 assert.equal((await call('POST','/config/reset',{})).status,200);
 assert.equal(pool.config.algorithm,'round-robin');assert.equal(getConfig().key_pool.algorithm,'round-robin');
 await call('PUT','/config',{system_prompt:'changed',key_pool:{algorithm:'max-remaining',retry:{maxRetries:0,retryDelay:0}}});
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import pool from './auth.js';fs.writeFileSync('restarted.json',JSON.stringify(pool.config));`],{cwd:dir,env:process.env,encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.stderr);const restarted=JSON.parse(fs.readFileSync(path.join(dir,'restarted.json')));
 assert.equal(restarted.algorithm,'max-remaining');assert.equal(restarted.retry.maxRetries,0);assert.equal(restarted.retry.retryDelay,0);
 assert.equal(JSON.parse(fs.readFileSync(poolPath)).config.algorithm,'round-robin','Test must retain a conflicting old snapshot');
 console.log('PASS: full form, partial updates, real selection, reset, invalid input, failed write and fresh-process restart.');
}finally{server.closeAllConnections();server.close();}
