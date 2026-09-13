// Native Droid BYOK -> guarded local relay -> running droid2api. No automatic paid retries.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync,existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parse} from 'dotenv';
import {fetchBillingLimits,getLimitState} from '../utils/factory-limits.js';

function verify(report) {
 assert.equal(report.calls.length,3);assert.equal(report.runs.length,2);assert.ok(!report.error,report.error);
 const routed=[];
 for(const [i,c] of report.calls.entries()) {
  assert.equal(c.status,200);assert.equal(c.responseModel,report.model);assert.ok(c.chunks>1,'Stream was not delivered in chunks');
  const before=c.statsBefore,after=c.statsAfter;
  assert.equal(after.total.requests-before.total.requests,1,'Extra physical generation');
  assert.equal(after.total.warmups-before.total.warmups,0,'Unexpected warm-up');
  const changed=Object.keys(after.by_key).filter(k=>(after.by_key[k].requests||0)>(before.by_key[k]?.requests||0));
  assert.equal(changed.length,1);routed.push(changed[0]);
  const read=c.usage.cache_read_input_tokens??c.usage.input_tokens_details?.cached_tokens;
  if(i)assert.ok(read>=3000,'Expected cross-account prefix cache hit');
  assert.ok(c.before&&c.after&&c.afterDelayed,'Per-request quota checks missing');
 }
 assert.equal(new Set(routed).size,3,'Round-robin did not use all three accounts');
 const first=report.runs[0],second=report.runs[1];
 for(const run of report.runs){assert.equal(run.code,0);assert.equal(run.events.find(e=>e.type==='completion')?.finalText,report.marker);}
 const tool=first.events.find(e=>e.type==='tool_call'),result=first.events.find(e=>e.type==='tool_result');
 assert.equal(tool?.toolName,'Read');assert.equal(result?.id,tool.id);assert.equal(result?.isError,false);assert.equal(result?.value.trim(),report.marker);
 assert.ok(!second.events.some(e=>e.type==='tool_call'),'Resume should reuse history');
 assert.equal(first.events[0].session_id,second.events[0].session_id,'A different session was resumed');
 if(report.model.startsWith('gpt-'))assert.equal(new Set(report.calls.map(c=>c.body.prompt_cache_key)).size,1);
 return {model:report.model,requests:3,routedKeys:routed,cachedTokens:report.calls.map(c=>c.usage.cache_read_input_tokens??c.usage.input_tokens_details?.cached_tokens),outputTokens:report.calls.map(c=>c.usage.output_tokens),passed:true};
}
if(process.argv.includes('--verify')){
 for(const mode of ['haiku','luna']){const report=JSON.parse(readFileSync(new URL(`../work/droid-byok-${mode}-live.json`,import.meta.url)));console.log(JSON.stringify(verify(report)));}
 process.exit(0);
}
const live=process.argv.includes('--live');
const smoke=process.argv.includes('--smoke');
const high=process.argv.includes('--high');assert.ok(!high||!live,'High-effort capture is offline only');
const mode=process.argv.find(x=>['haiku','luna'].includes(x));assert.ok(mode,'Specify haiku or luna');
const model=mode==='haiku'?'claude-haiku-4-5-20251001':'gpt-5.6-luna';
assert.ok(!smoke||(live&&mode==='haiku'),'Smoke test requires --live haiku');
const reportFile=new URL(`../work/droid-byok-${mode}-${smoke?'network-smoke-'+Date.now():live?'live':high?'high-capture':'capture'}.json`,import.meta.url);
assert.ok(!live||!existsSync(reportFile),'Live run already exists; inspect it before authorizing another run');
const local=parse(readFileSync(new URL('../.env',import.meta.url)));
const keys=JSON.parse(readFileSync(new URL('../data/key_pool.json',import.meta.url))).keys.filter(k=>k.status==='active'&&k.last_test_result==='success');
const dir=mkdtempSync(join(tmpdir(),'droid-byok-'));mkdirSync(join(dir,'.factory'));
const marker=smoke?'OK':'BYOK_'+randomUUID().replaceAll('-','').slice(0,12);writeFileSync(join(dir,'marker.txt'),marker+'\n');
const report={model,live,dir,marker,startedAt:new Date().toISOString(),calls:[],runs:[]};
const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2));
const snapshot=async()=>Promise.all(keys.map(async k=>{const s=getLimitState({billing_limits:await fetchBillingLimits(k.key)});assert.ok(s.known,'Quota unavailable');return{id:k.id,available:s.available,windows:s.windows};}));
const stats=async()=>{const r=await fetch('http://127.0.0.1:3000/admin/stats/full',{headers:{'x-admin-key':local.ADMIN_ACCESS_KEY},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return(await r.json()).data.factory_transport;};
function guard(s){let increase=0;for(const k of s){const b=report.baseline.find(x=>x.id===k.id);const a=k.windows.fiveHour,p=b.windows.fiveHour;assert.ok(a.windowEnd===p.windowEnd||p.awaitingStart,'Quota reset during run');increase+=Math.max(0,a.usedPercent-p.usedPercent);}assert.ok(increase<2,'Two percentage-point budget reached');}
let queue=Promise.resolve(),fatal=false;
const server=http.createServer((req,res)=>{
 queue=queue.then(async()=>{
  let raw='';for await(const b of req)raw+=b;
  const body=JSON.parse(raw||'{}');
  const row={path:req.url,model:body.model,bytes:Buffer.byteLength(raw),bodyHash:createHash('sha256').update(raw).digest('hex'),body,
    headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!/authorization|api-key|cookie|token/i.test(k)))};
  report.calls.push(row);save();
  assert.ok(!fatal,'Earlier request failed');assert.equal(body.model,model,'Unexpected model');
  assert.ok(req.url.startsWith(mode==='haiku'?'/v1/messages':'/v1/responses'),'Wrong protocol URL');
  assert.ok(row.bytes<200000,'Unexpectedly large native prompt');
  if(!live){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'invalid_request_error',message:'Offline capture complete'}}));return;}
  assert.ok(report.calls.length<=(smoke?1:3),'Generation cap reached');
  const outputCap=body.max_tokens??body.max_output_tokens;assert.ok(outputCap>0&&outputCap<=512,'Output cap missing');
  row.before=await snapshot();guard(row.before);row.statsBefore=await stats();save();
  let failure;
  try{
   const headers={...req.headers,authorization:`Bearer ${local.API_ACCESS_KEY}`};delete headers.host;delete headers['content-length'];delete headers['x-api-key'];
   const upstream=await fetch('http://127.0.0.1:3000'+req.url,{method:'POST',headers,body:raw,signal:AbortSignal.timeout(90000)});
   row.status=upstream.status;res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json'});
   let text='';const decoder=new TextDecoder();row.chunks=0;
   for await(const chunk of upstream.body){row.chunks++;text+=decoder.decode(chunk,{stream:true});res.write(chunk);}text+=decoder.decode();
   row.events=text.split('\n').filter(l=>l.startsWith('data:')).flatMap(l=>{try{return[JSON.parse(l.slice(5))];}catch{return[];}});
   if(!upstream.ok)row.errorBody=text.slice(0,1500);
   assert.equal(upstream.status,200,'Proxy HTTP error');
   const completed=row.events.find(e=>e.type==='response.completed')?.response;
   const start=row.events.find(e=>e.type==='message_start')?.message;
   row.responseModel=(completed||start)?.model;
   row.usage=completed?.usage||{...start?.usage,...row.events.find(e=>e.type==='message_delta')?.usage};
   assert.equal(row.responseModel,model,'Response model mismatch');
   assert.ok(row.events.some(e=>e.type===(mode==='haiku'?'message_stop':'response.completed')),'Missing stream terminal');
  }catch(e){row.error=e.message;failure=e;fatal=true;}
  finally{
   row.after=await snapshot();row.statsAfter=await stats();save();await delay(7000);row.afterDelayed=await snapshot();save();
   console.log(JSON.stringify({model,call:report.calls.length,status:row.status,usage:row.usage,quota:row.afterDelayed.map(k=>({id:k.id,used:k.windows.fiveHour.usedPercent})),error:row.error}));
   res.end();
  }
  if(failure)throw failure;guard(row.afterDelayed);
 }).catch(e=>{fatal=true;report.error=e.message;save();if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));});
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const settings={cloudSessionSync:false,customModels:[{model,displayName:'BYOK Verification '+mode,provider:mode==='haiku'?'anthropic':'openai',baseUrl:base+(mode==='haiku'?'':'/v1'),apiKey:'local-test-relay',maxOutputTokens:smoke?64:512,...(mode==='luna'&&!high?{extraArgs:{max_output_tokens:512,reasoning:{effort:'none'}}}:{})}]};
writeFileSync(join(dir,'.factory','settings.local.json'),JSON.stringify(settings,null,2));
const exe=join(process.env.USERPROFILE,'bin','droid.exe');
const env={...process.env,FACTORY_DROID_AUTO_UPDATE_ENABLED:'false'};
const help=spawnSync(exe,['exec','--help'],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:20000});
const customId=help.stdout?.split('\n').find(l=>l.includes('custom:')&&l.includes('BYOK-Verification'))?.trim().split(/\s+/)[0];
assert.ok(customId,'Project BYOK model not loaded');report.customId=customId;save();
async function run(prompt,session){
 const args=['exec','--model',customId,'--reasoning-effort',high?'high':mode==='haiku'?'off':'none','--output-format','stream-json','--only-tools','Read',...(session?['--session-id',session]:[]),prompt];
 const child=spawn(exe,args,{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const timer=setTimeout(()=>child.kill(),120000);const [code]=await once(child,'exit');clearTimeout(timer);await queue;
 const events=out.split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});const row={code,events,stderr:err.slice(-2000)};report.runs.push(row);save();
 console.log(JSON.stringify({model,code,eventTypes:events.map(e=>e.type),stderr:row.stderr}));return row;
}
try{
 if(live){report.baseline=await snapshot();guard(report.baseline);save();}
 const first=await run(smoke?'Reply with exactly OK. Do not call any tools.':'Use the Read tool exactly once to read '+join(dir,'marker.txt')+'. Then reply with exactly the file contents. Do not use any other tools.');
 if(smoke){
  assert.equal(first.code,0);assert.ok(!fatal,report.error);assert.equal(report.calls.length,1);
  assert.equal(first.events.find(e=>e.type==='completion')?.finalText,marker);
  assert.ok(!first.events.some(e=>e.type==='tool_call'));
  const c=report.calls[0];assert.equal(c.status,200);assert.equal(c.responseModel,model);assert.ok(c.chunks>1);
  assert.equal(c.statsAfter.total.requests-c.statsBefore.total.requests,1,'Concurrent traffic or extra generation; inspect evidence');
  assert.equal(c.statsAfter.total.warmups-c.statsBefore.total.warmups,0);
  report.passed=true;
 }else if(live){
  assert.equal(first.code,0,'Native Droid first turn failed');assert.ok(!fatal,report.error);
  assert.equal(report.calls.length,2,'Expected tool call and tool-result continuation');
  const session=first.events.find(e=>e.session_id)?.session_id;assert.ok(session,'Session ID missing');
  const second=await run('Without calling any tools, repeat the exact marker you just read. Nothing else.',session);
  assert.equal(second.code,0);assert.equal(report.calls.length,3);assert.ok(!fatal,report.error);
  const answers=report.runs.map(r=>JSON.stringify(r.events));assert.ok(answers.every(t=>t.includes(marker)),'Marker missing from native output');
  report.verification=verify(report);report.passed=true;
 }
}catch(e){report.error=e.message;process.exitCode=1;console.error(e.message);}
finally{await queue;server.closeAllConnections();server.close();report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({report:reportFile.pathname,passed:report.passed,error:report.error}));}
