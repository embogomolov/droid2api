// Run through run-network-checks.mjs: no real account files or upstream requests.
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {logCollectorMiddleware,getLogBuffer,clearLogBuffer} from '../middleware/log-collector.js';
import {requestBodyMiddleware,requestBodyLimit} from '../middleware/request-body.js';
const app=express();app.use(logCollectorMiddleware);
// Use the same parser/error path with a small override for rejection checks.
const previousLimit=process.env.REQUEST_BODY_LIMIT_MB;
process.env.REQUEST_BODY_LIMIT_MB='1';
const {requestBodyMiddleware:smallBodyMiddleware}=await import('../middleware/request-body.js?small-limit');
if(previousLimit===undefined)delete process.env.REQUEST_BODY_LIMIT_MB;else process.env.REQUEST_BODY_LIMIT_MB=previousLimit;
const smallParser=express.Router().use(smallBodyMiddleware),parser=express.Router().use(requestBodyMiddleware);
app.use((req,res,next)=>(req.headers['x-small-limit'] ? smallParser : parser)(req,res,next));
app.post('/admin/keys',(_req,res)=>res.json({success:true}));
app.post('/v1/messages',(req,res)=>{
  res.locals.factoryRequest={model:req.body.model,keyId:'test-account',success:req.body.success,usage:req.body.usage};
  res.type('text/event-stream');res.write('event: message_stop\ndata: {}\n\n');res.end();
});
app.post('/v1/responses',(_req,res)=>res.status(503).json({error:'unavailable'}));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
try{
  clearLogBuffer();const base='http://127.0.0.1:'+server.address().port;
  const send=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.text());
  await send('/admin/keys',{key:'fk-do-not-log-this'});assert.equal(getLogBuffer().length,0);
  await send('/v1/messages',{model:'haiku-test',success:true,usage:{input:10,output:2,cacheRead:8},messages:[{content:'private-prompt'}]});
  await send('/v1/messages',{model:'haiku-test',success:false});
  await send('/v1/responses',{model:'luna-test'});
  const rows=getLogBuffer();assert.equal(rows.length,3,'One summary per request, including SSE');
  assert.equal(rows[0].summary.keyId,'test-account');assert.equal(rows[0].summary.usage.cacheRead,8);
  assert.equal(rows[1].summary.outcome,'Stream failed');assert.equal(rows[2].summary.outcome,'HTTP 503');
  assert.equal(rows[2].summary.usage,null,'Missing usage is not invented');
  assert.ok(!JSON.stringify(rows).includes('private-prompt'));assert.ok(!JSON.stringify(rows).includes('fk-do-not-log-this'));
  assert.equal(requestBodyLimit,256*1024*1024);
  clearLogBuffer();
  // A multimodal history larger than the old 50 MiB cap must reach the route.
  await send('/v1/messages',{model:'large-history',success:true,messages:[{content:'x'.repeat(65*1024*1024)}]});
  assert.equal(getLogBuffer()[0].summary.outcome,'Completed');
  for(const [body,status] of [[JSON.stringify({private:'fk-do-not-log-this',padding:'x'.repeat(1024*1024)}),413],['{"private":"fk-do-not-log-this",',400]]) {
    clearLogBuffer();
    const response=await fetch(base+'/v1/responses',{method:'POST',headers:{'content-type':'application/json','x-small-limit':'1'},body});
    assert.equal(response.status,status);const result=await response.json();
    const events=getLogBuffer();assert.equal(events.length,1);
    assert.equal(events[0].url,'/v1/responses');assert.equal(events[0].summary.outcome,'HTTP '+status);
    assert.equal(events[0].summary.error,result.error.message);
    assert.ok(!JSON.stringify(events).includes('fk-do-not-log-this'));
    assert.ok(!JSON.stringify(result).includes('fk-do-not-log-this'));
  }
  console.log('PASS: SSE outcomes, quota metadata, one event per request and no key/prompt logging');
  console.log('PASS: 65 MiB history accepted, oversized/malformed bodies return 413/400 with one safe request event');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
