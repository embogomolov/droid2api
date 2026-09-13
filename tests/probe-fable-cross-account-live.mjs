// Explicit, single-run cache experiment. Never automatically replay a paid call.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import fetch from 'node-fetch';
import {prepareDirectAnthropic,getAnthropicHeaders} from '../transformers/request-anthropic.js';
import {fetchBillingLimits,getLimitState} from '../utils/factory-limits.js';
assert.equal(process.argv[2],'--live','Explicit --live required');
const file=new URL('../work/fable-cross-account-cache.json',import.meta.url);
assert.ok(!existsSync(file),'A run already exists: do not replay or reset its budget');
const keys=JSON.parse(readFileSync(new URL('../data/key_pool.json',import.meta.url))).keys.filter(k=>k.status==='active'&&k.last_test_result==='success').slice(0,3);
assert.ok(keys.length>=2);assert.equal(new Set(keys.map(k=>k.key)).size,keys.length);
const id=randomUUID();
const context=`Unique cache experiment ${id}.\n`+Array.from({length:85},(_,i)=>`Reference ${i}: amber birch cedar delta elm fern granite hazel indigo juniper kelp linen.`).join('\n');
const body=prepareDirectAnthropic({model:'claude-fable-5.1',max_tokens:64,stream:false,thinking:{type:'adaptive'},output_config:{effort:'low'},
 messages:[{role:'user',content:[{type:'text',text:context,cache_control:{type:'ephemeral'}},{type:'text',text:'Reply exactly CACHE_OK. Do not analyze the reference text.'}]}]});
const serialized=JSON.stringify(body);
const sample=JSON.parse(readFileSync(new URL('../work/claude-user-request.json',import.meta.url)))[0].headers;
const clientHeaders={...sample,'x-claude-code-session-id':id};for(const k of ['thread-id','session-id','x-session-id'])delete clientHeaders[k];
const report={model:body.model,nonce:id,bodySHA256:createHash('sha256').update(serialized).digest('hex'),bodyBytes:Buffer.byteLength(serialized),maxOutputTokens:64,maxTotalQuotaIncrease:2,calls:[]};
const save=()=>writeFileSync(file,JSON.stringify(report,null,2));
const snapshot=async()=>Promise.all(keys.map(async k=>{const state=getLimitState({billing_limits:await fetchBillingLimits(k.key)});assert.ok(state.known,'Quota unavailable');return{id:k.id,available:state.available,windows:state.windows};}));
report.baseline=await snapshot();save();
function guard(current){
 let increase=0;for(const [i,k] of current.entries()){
  assert.equal(k.windows.fiveHour.windowEnd,report.baseline[i].windows.fiveHour.windowEnd,'Quota window changed; stop for inspection');
  increase+=Math.max(0,k.windows.fiveHour.usedPercent-report.baseline[i].windows.fiveHour.usedPercent);
 }
 assert.ok(increase<report.maxTotalQuotaIncrease,'Quota budget reached');
}
const sequence=[{key:keys[0],label:'A-cold'},{key:keys[0],label:'A-repeat'},...keys.slice(1).map((key,i)=>({key,label:`${String.fromCharCode(66+i)}-same-prefix`}))];
try{
 for(const {key,label} of sequence){
  const before=await snapshot();guard(before);assert.ok(before.find(k=>k.id===key.id).available,'Selected account unavailable');
  const entry={label,keyId:key.id,before,startedAt:new Date().toISOString(),bodySHA256:report.bodySHA256};report.calls.push(entry);save();
  let error;
  try{
   const response=await fetch('https://api.factory.ai/api/llm/a/v1/messages',{method:'POST',headers:getAnthropicHeaders(`Bearer ${key.key}`,clientHeaders,false,body.model),body:serialized,signal:AbortSignal.timeout(45000),redirect:'error'});
   entry.status=response.status;const text=await response.text();
   let result;try{result=JSON.parse(text);}catch{throw Error(`Non-JSON upstream response (${response.status})`);}
   entry.responseModel=result.model;entry.usage=result.usage;entry.responseId=result.id;entry.text=result.content?.filter(b=>b.type==='text').map(b=>b.text).join('');
   assert.equal(response.status,200,`Upstream ${response.status}: ${text.slice(0,250)}`);
   assert.ok(['claude-fable-5.1','claude-fable-5-1'].includes(result.model));
   assert.equal(entry.text,'CACHE_OK');assert.ok(entry.usage);
  }catch(e){error=e;entry.error=e.message;}
  entry.after=await snapshot();save();await delay(10000);entry.afterDelayed=await snapshot();save();
  console.log(JSON.stringify({label,status:entry.status,usage:entry.usage,limits:entry.afterDelayed.map(k=>({id:k.id,used:k.windows.fiveHour.usedPercent})),error:entry.error}));
  if(error)throw error;
  if(label==='A-cold'){assert.ok(entry.usage.cache_creation_input_tokens>=512,'No cache creation; experiment inconclusive');assert.equal(entry.usage.cache_read_input_tokens,0,'Cold context unexpectedly already cached');}
  else {assert.equal(entry.usage.cache_read_input_tokens,report.calls[0].usage.cache_creation_input_tokens,'Full cached prefix was not reused');assert.equal(entry.usage.cache_creation_input_tokens,0,'Unexpected cache rewrite');}
 }
 report.crossAccountCacheConfirmed=true;report.completedAt=new Date().toISOString();save();
}catch(e){report.stopped=e.message;save();throw e;}
