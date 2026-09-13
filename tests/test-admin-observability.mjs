// Run through run-network-checks.mjs: no real account files or upstream requests.
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {logCollectorMiddleware,getLogBuffer,clearLogBuffer} from '../middleware/log-collector.js';
const app=express();app.use(express.json());app.use(logCollectorMiddleware);
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
  console.log('PASS: SSE outcomes, quota metadata, one event per request and no key/prompt logging');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
