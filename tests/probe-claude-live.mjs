// Explicit opt-in. Real Claude Code -> production router -> one Factory key.
// Quota is checked after EVERY physical request before the next may proceed.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import fetch from 'node-fetch';
import { fetchBillingLimits, getLimitState } from '../utils/factory-limits.js';
assert.equal(process.argv[2], '--live');
const stage=process.argv[3]; assert.ok(['count','cold','repeat','tool','resume','large','large-repeat','normal','normal-repeat'].includes(stage));
const file=new URL('../work/claude-live-verification.json',import.meta.url);
const report=existsSync(file)?JSON.parse(readFileSync(file)):{ model:'claude-fable-5.1',session:randomUUID(),cwd:mkdtempSync(join(tmpdir(),'claude-factory-live-')),calls:[],stages:[],maxIncrease:2,maxRequests:8 };
assert.ok(!report.stopped, report.stopped); assert.ok(!report.stages.includes(stage),'Do not replay a stage');
const keys=JSON.parse(readFileSync(new URL('../data/key_pool.json',import.meta.url))).keys;
report.keyId??=keys[1].id; const key=keys.find(k=>k.id===report.keyId); assert.ok(key);
const save=()=>writeFileSync(file,JSON.stringify(report,null,2));
const snapshot=async()=>{ const raw=await fetchBillingLimits(key.key); const state=getLimitState({billing_limits:raw}); assert.ok(state.known,'Unknown quota'); return {at:new Date().toISOString(),available:state.available,windows:state.windows}; };
report.baseline??=await snapshot(); save();
process.env.DROID2API_STATS_FILE=join(report.cwd,'stats.json');
process.env.API_ACCESS_KEY='local-live-'+randomUUID(); delete process.env.FACTORY_API_KEY;
const {default:pool}=await import('../auth.js');
const {getConfig}=await import('../config.js');
const {default:router}=await import('../routes.js');
const {validateClientAuth}=await import('../middleware/client-auth.js');
const {destroyPool}=await import('../utils/http-client.js');
pool.keys=[structuredClone(key)]; pool.stats={};pool.poolGroups=[];
pool.saveKeyPool=pool.saveKeyPoolImmediately=async()=>{};
pool.config={...pool.config,algorithm:'round-robin',multiTier:{enabled:false}};
const cfg=getConfig();
cfg.endpoint.find(e=>e.name==='anthropic').base_url='https://api.factory.ai/api/llm/a/v1/messages';
const app=express();app.use(express.json({limit:'32mb'}));app.use(validateClientAuth);
let gate=Promise.resolve();
app.use(async(req,res,next)=>{
  if(req.method!=='POST'){next();return;}
  const previous=gate;let release;gate=new Promise(r=>{release=r;});await previous;
  if(report.stopped){res.status(429).json({type:'error',error:{type:'rate_limit_error',message:report.stopped}});release();return;}
  const counting=req.path.endsWith('/count_tokens');
  let entry;
  try{
    const before=await snapshot();
    assert.ok(before.available,'Account unavailable');
    assert.ok(before.windows.fiveHour.usedPercent-report.baseline.windows.fiveHour.usedPercent<report.maxIncrease,'Quota budget reached');
    assert.ok(report.calls.filter(c=>!c.counting).length<report.maxRequests,'Request budget reached');
    assert.equal(req.body.model,report.model,'Unexpected model: refuse extra traffic');
    assert.ok(counting||req.body.max_tokens<=1024,'Output budget exceeded');
    entry={stage,counting,before,bytes:Buffer.byteLength(JSON.stringify(req.body)),model:req.body.model};report.calls.push(entry);save();
    writeFileSync(join(report.cwd,`request-${report.calls.length}.json`), JSON.stringify(req.body));
    const chunks=[];const write=res.write.bind(res),end=res.end.bind(res);
    res.write=(chunk,...args)=>{if(chunk)chunks.push(Buffer.from(chunk));return write(chunk,...args);};
    res.end=(chunk,...args)=>{if(chunk)chunks.push(Buffer.from(chunk));return end(chunk,...args);};
    res.once('finish',async()=>{
      try{
        entry.status=res.statusCode;
        const raw=Buffer.concat(chunks).toString('utf8');
        if(counting||res.statusCode!==200){try{entry.result=JSON.parse(raw);}catch{entry.result=raw.slice(0,1500);}}
        else for(const line of raw.split('\n'))if(line.startsWith('data:')){
          let e;try{e=JSON.parse(line.slice(5));}catch{continue;}
          if(e.type==='message_start'){entry.responseModel=e.message.model;entry.usage=e.message.usage;}
          if(e.type==='message_delta'&&e.usage)entry.usage={...entry.usage,...e.usage};
          if(e.type==='message_stop')entry.completed=true;
          if(e.type==='error')entry.error=e;
        }
        entry.afterImmediate=await snapshot();save();await delay(12000);entry.afterDelayed=await snapshot();
        entry.totalIncrease=entry.afterDelayed.windows.fiveHour.usedPercent-report.baseline.windows.fiveHour.usedPercent;
        if(entry.totalIncrease>=report.maxIncrease)report.stopped='Quota budget reached';
        if(entry.status!==200||entry.error||(!counting&&!entry.completed))report.stopped='Request failed; inspect before any further inference';
      }catch(e){report.stopped=e.message;}finally{save();console.log(JSON.stringify(entry));release();}
    });
    next();
  }catch(e){report.stopped=e.message;save();res.status(429).json({type:'error',error:{type:'rate_limit_error',message:e.message}});release();}
});
app.use(router);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
try{
  if(stage==='count'){
    const r=await fetch(base+'/v1/messages/count_tokens?beta=true',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.API_ACCESS_KEY}`},body:JSON.stringify({model:report.model,messages:[{role:'user',content:'Reply OK.'}]})});
    console.log(JSON.stringify({countStatus:r.status,body:(await r.text()).slice(0,300)}));
  }else{
    mkdirSync(join(report.cwd,'config'),{recursive:true});writeFileSync(join(report.cwd,'probe.txt'),'TOOL_READ_VERIFIED');
    const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('ANTHROPIC_')||k.startsWith('CLAUDE_'))delete env[k];
    Object.assign(env,{ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:process.env.API_ACCESS_KEY,CLAUDE_CONFIG_DIR:join(report.cwd,'config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_UPDATE:'1',CLAUDE_CODE_ATTRIBUTION_HEADER:'0',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'1024'});
    const args=['-p',stage.startsWith('normal')?'--safe-mode':'--bare','--model',report.model,'--effort','low','--tools','Read','--allowedTools','Read','--strict-mcp-config','--output-format','stream-json','--verbose'];
    if (stage==='normal') report.normalSession=randomUUID();
    args.push(...(['cold','normal'].includes(stage)?['--session-id',stage==='normal'?report.normalSession:report.session]:['--resume',stage.startsWith('normal')?report.normalSession:report.session]));
    args.push('--append-system-prompt','This is a bounded connectivity/cache test. Answer in at most five words. Use no tools unless explicitly asked to read probe.txt.');
    let prompt=['tool','normal'].includes(stage)?'Read probe.txt with Read. Reply with its exact contents.':'Reply exactly CACHE_OK.';
    if(stage==='cold'||stage==='large')prompt=Array.from({length:stage==='large'?2400:850},(_,i)=>`Reference ${i}: alpha beta gamma delta epsilon.`).join('\n')+'\n'+prompt;
    const child=spawn(join(process.env.USERPROFILE,'.local','bin','claude.exe'),args,{cwd:report.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stdin.end(prompt);
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    const timer=setTimeout(()=>child.kill(),180000);const [code]=await once(child,'exit');clearTimeout(timer);
    writeFileSync(join(report.cwd,stage+'.jsonl'),stdout);writeFileSync(join(report.cwd,stage+'.stderr'),stderr);
    const result=stdout.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return{};}}).findLast(e=>e.type==='result');
    report.results??={};report.results[stage]={code,result};
    if(code||result?.is_error)report.stopped='Claude Code failed; inspect saved output';
    console.log(JSON.stringify({stage,code,result:result?.result,usage:result?.usage,stderr:stderr.slice(-1000)}));
  }
  await gate;report.stages.push(stage);save();console.log(JSON.stringify({report:file.pathname,stopped:report.stopped??null}));
}finally{server.closeAllConnections();server.close();destroyPool();}
