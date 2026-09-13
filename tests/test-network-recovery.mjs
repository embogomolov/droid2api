// Run in an isolated checkout with the other transport tests. No Factory traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Response } from 'node-fetch';
import { fetchFactoryJSON, preserveUsageOnFailure } from '../utils/factory-telemetry.js';
import fetchWithPool, { retryUnsentRequest, destroyPool } from '../utils/http-client.js';
import { fetchFactoryWebSocket } from '../utils/factory-websocket.js';
import { WebSocketServer } from 'ws';

let calls = 0, mode = 'retry';
const server = http.createServer((req, res) => {
  calls++;
  if (mode === 'reset') { req.socket.destroy(); return; }
  if (mode === 'timeout') return;
  if (mode === 'body-timeout') { res.writeHead(200, {'content-type':'application/json'}); res.write('{'); return; }
  if (mode === 'unauthorized') { res.writeHead(401, {'content-type':'application/json'}).end('{}'); return; }
  if (mode === 'retry' && calls < 3) { res.writeHead(503, {'content-type':'application/json'}).end('{}'); return; }
  res.writeHead(200, {'content-type':'application/json'}).end('{"ok":true}');
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}/telemetry`;
try {
  assert.equal((await fetchFactoryJSON(url,{retryDelay:1})).data.ok,true); assert.equal(calls,3);
  for (const scenario of ['timeout','body-timeout','reset']) {
    mode=scenario; calls=0;
    await assert.rejects(fetchFactoryJSON(url,{timeout:30,retryDelay:1}),/attempt 3\/3/);
    assert.equal(calls,3,scenario);
  }
  mode='unauthorized';calls=0;
  assert.equal((await fetchFactoryJSON(url)).response.status,401);assert.equal(calls,1);
  mode='timeout';calls=0;
  await assert.rejects(fetchFactoryJSON(url,{signal:AbortSignal.timeout(30),timeout:500,retryDelay:1}));assert.equal(calls,1,'caller cancellation must not retry');
  // Retry-After seconds, dates, and a hint too long for an immediate retry.
  for (const hint of ['0.03',new Date(Date.now()+1500).toUTCString(),'120']) {
    let count=0;const start=Date.now();
    const result=await fetchFactoryJSON(url,{retryDelay:1,fetchImpl:async()=>++count===1 ? new Response('{}',{status:429,headers:{'retry-after':hint}}):new Response('{}')});
    if(hint==='120'){assert.equal(count,1);assert.equal(result.response.status,429);}
    else {assert.equal(count,2);if(hint==='0.03')assert.ok(Date.now()-start>=25);else assert.ok(Date.now()>=Date.parse(hint));}
  }
  const prior={success:true,standard:{remaining:17},last_sync:'old'};
  assert.deepEqual(preserveUsageOnFailure(prior,'timeout','now'),{...prior,stale:true,last_error:'timeout',last_attempt:'now'});
  assert.equal(prior.stale,undefined);
  // An accepted POST followed by a socket reset is ambiguous and must run once.
  mode='reset';calls=0;
  await assert.rejects(retryUnsentRequest(()=>fetchWithPool(url,{method:'POST',body:'{}',retry:false}),{retryDelay:1}));assert.equal(calls,1);
  let refusedAttempts=0;
  await assert.rejects(retryUnsentRequest(async()=>{refusedAttempts++;throw Object.assign(new Error('refused'),{code:'ECONNREFUSED',erroredSysCall:'connect'});},{retryDelay:1}));
  assert.equal(refusedAttempts,3,'safe retries must be bounded');
  const cancelled=new AbortController();refusedAttempts=0;
  await assert.rejects(retryUnsentRequest(async()=>{refusedAttempts++;throw Object.assign(new Error('refused'),{code:'ECONNREFUSED',erroredSysCall:'connect'});},{signal:cancelled.signal,onRetry:()=>cancelled.abort(),retryDelay:1}));
  assert.equal(refusedAttempts,1,'cancelled client must stop safe retries');
  // Real connect refusal, then server becomes available: retry without duplicate delivery.
  const late=http.createServer((req,res)=>{res.end('OK');});
  late.listen(0,'127.0.0.1');await once(late,'listening');const port=late.address().port;await new Promise(r=>late.close(r));
  let retries=0;
  const response=await retryUnsentRequest(()=>fetchWithPool(`http://127.0.0.1:${port}`,{method:'POST',body:'{}',retry:false}),{retryDelay:30,onRetry:()=>{retries++;late.listen(port,'127.0.0.1');}});
  assert.equal(await response.text(),'OK');assert.equal(retries,1);late.closeAllConnections();await new Promise(r=>late.close(r));
  // Actual WebSocket handshake drops once before any response.create frame.
  let upgrades=0,frames=0;
  const wsServer=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{if(++upgrades===1){socket.destroy();return;}wsServer.handleUpgrade(req,socket,head,ws=>wsServer.emit('connection',ws));});
  wsServer.on('connection',ws=>ws.on('message',()=>{frames++;ws.send(JSON.stringify({type:'response.completed',response:{id:'test',status:'completed',output:[]}}));}));
  const wsResponse=await retryUnsentRequest(()=>fetchFactoryWebSocket(url.replace('http:','ws:'),{headers:{},body:{model:'test',input:[],stream:false}}),{retryDelay:1});
  await wsResponse.json();assert.equal(upgrades,2);assert.equal(frames,1);
  for(const ws of wsServer.clients)ws.terminate();await new Promise(r=>wsServer.close(r));
  console.log('PASS: telemetry retries/timeouts/body timeout/cancel/Retry-After/cache retention; HTTP and WS pre-send recovery; no replay after POST.');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));destroyPool();}
