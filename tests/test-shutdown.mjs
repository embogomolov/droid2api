// Real server, isolated files and empty key pool; no Factory requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'droid-shutdown-test-'));
for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js')||n==='package.json')) fs.copyFileSync(path.join(root,name),path.join(dir,name));
for(const name of ['api','middleware','utils','transformers']) fs.cpSync(path.join(root,name),path.join(dir,name),{recursive:true});
fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'junction');
fs.mkdirSync(path.join(dir,'data'));
fs.writeFileSync(path.join(dir,'data/config.json'),JSON.stringify({models:[],endpoint:[],token_sync:{enabled:false},key_pool:{algorithm:'max-remaining'}}));
fs.writeFileSync(path.join(dir,'data/key_pool.json'),JSON.stringify({keys:[],stats:{}}));
fs.writeFileSync(path.join(dir,'shutdown-probe.mjs'),`
import writers from './utils/async-file-writer.js';
import cluster from 'node:cluster';
process.on('message', async message => {
  if (!message?.testSignal) return;
  if (process.env.CLUSTER_MODE==='true' && cluster.isPrimary) {
    process.emit(message.testSignal);
    process.emit(message.testSignal);
    return;
  }
  const writer=writers.getWriter('data/shutdown-check.json',{debounceTime:60000});
  const atomic=writer._atomicWrite.bind(writer);
  writer._atomicWrite=async data=>{await new Promise(r=>setTimeout(r,200));await atomic(data);};
  void writer.writeImmediately({batch:1});
  void writer.write({batch:2});
  // Windows child.kill(SIGINT) terminates forcibly; dispatch the real JS handler instead.
  process.emit(message.testSignal);
  process.emit(message.testSignal);
});
`);
const env={...process.env,ADMIN_ACCESS_KEY:'isolated-shutdown-test',API_ACCESS_KEY:'isolated-shutdown-test',TOKEN_SYNC_ENABLED:'false',AUTOMATIC_KEY_TESTS:'false',CLUSTER_MODE:'false',DROID2API_STATS_FILE:path.join(dir,'data/request_stats.json')};
for(const name of Object.keys(env)) if (/^(DROID_REFRESH_KEY|FACTORY_API_KEY|REDIS_|KEY_POOL_)/.test(name)) delete env[name];

for(const [signal,clusterMode] of [['SIGINT',false],['SIGTERM',false],['SIGBREAK',false],['SIGINT',true]]) {
  const reservation=net.createServer().listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=fork(path.join(dir,'server.js'),[],{cwd:dir,env:{...env,PORT:String(port),CLUSTER_MODE:String(clusterMode),CLUSTER_WORKERS:'1'},execArgv:['--import',pathToFileURL(path.join(dir,'shutdown-probe.mjs')).href],silent:true,windowsHide:true});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const exited=once(child,'exit');let stream;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error(output);
      try {const r=await fetch(`http://127.0.0.1:${port}/api/hello`,{method:'HEAD',signal:AbortSignal.timeout(200)});ready=r.status===204;} catch {}
      if(ready) break;await delay(100);
    }
    assert.ok(ready,output);
    if(signal==='SIGINT') {
      stream=http.get(`http://127.0.0.1:${port}/admin/logs/stream`,{headers:{'x-admin-key':'isolated-shutdown-test'}});
      const [response]=await once(stream,'response');response.on('error',()=>{});response.resume();
      assert.equal(response.statusCode,200);
      assert.match(response.headers['content-type'],/text\/event-stream/);
    }
    const start=Date.now();child.send({testSignal:signal});
    const timeout=setTimeout(()=>child.kill(),12000);
    const [code]=await exited;clearTimeout(timeout);
    assert.equal(code,0,output);
    assert.ok(Date.now()-start<6000,output);
    if(!clusterMode) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'data/shutdown-check.json'))),{batch:2});
    assert.equal((output.match(/All pending writes flushed; server stopped/g)||[]).length,1,output);
    const rebound=net.createServer().listen(port,'127.0.0.1');await once(rebound,'listening');await new Promise(r=>rebound.close(r));
    console.log('PASS:',clusterMode?'cluster':'single',signal,'exits once and releases port; queued writes checked in single mode',Date.now()-start+'ms');
  } finally {
    stream?.destroy();
    if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}
  }
}
