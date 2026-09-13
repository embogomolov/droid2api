// Offline integration: production router/auth/failover, fake Anthropic upstream.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import fetch from 'node-fetch';
const temp = mkdtempSync(join(tmpdir(), 'claude-gateway-test-'));
process.env.DROID2API_STATS_FILE = join(temp, 'stats.json');
process.env.API_ACCESS_KEY = 'local-only'; delete process.env.FACTORY_API_KEY;
const { default: router } = await import('../routes.js');
const { default: pool } = await import('../auth.js');
const { getConfig } = await import('../config.js');
const { validateClientAuth } = await import('../middleware/client-auth.js');
const { getFactorySession } = await import('../utils/factory-sessions.js');
const { prepareDirectAnthropic } = await import('../transformers/request-anthropic.js');
const { logCollectorMiddleware, getLogBuffer } = await import('../middleware/log-collector.js');
const { upstreamEventError } = await import('../utils/factory-upstream.js');
const { destroyPool } = await import('../utils/http-client.js');
const cfg = getConfig();
cfg.system_prompt = 'You are Droid, an AI software engineering agent built by Factory.';
const limits = { fetchedAt: Date.now(), limits: { standard: Object.fromEntries(['fiveHour','weekly','monthly'].map(n => [n, { usedPercent: 0, windowEnd: new Date(Date.now()+3600000).toISOString() }])) } };
pool.keys = ['a','b'].map(id => ({ id, key: 'fake-'+id, status: 'active', last_test_result: 'success', billing_limits: structuredClone(limits) }));
pool.stats = {}; pool.poolGroups = []; pool.config = { ...pool.config, algorithm: 'round-robin', multiTier: { enabled: false } };
pool.saveKeyPool = pool.saveKeyPoolImmediately = async () => {};
pool.refreshBillingLimits = async () => {};
const calls = []; let scenario = 'ok', wire = '', upstreamClosed = false;
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push({ body, headers: req.headers, path: req.url });
  if (scenario === 'quota' && req.headers.authorization === 'Bearer fake-a') { res.writeHead(429, { 'content-type':'application/json','retry-after':'1' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"exhausted"}}'); return; }
  if (scenario === 'json-error') {res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'Invalid credentials'}}));return;}
  if (scenario === 'bad') { res.writeHead(400, { 'content-type':'application/json' }).end('{"type":"error","error":{"type":"invalid_request_error","message":"thinking signature rejected"}}'); return; }
  if (req.url.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type':'application/json' }).end('{"input_tokens":321}'); return; }
  const message = { id:'msg_native',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Привет 👋'}],stop_reason:'end_turn',usage:{input_tokens:7,cache_creation_input_tokens:11,cache_read_input_tokens:1000,output_tokens:9,output_tokens_details:{thinking_tokens:3}} };
  if (!body.stream) { res.writeHead(200, {'content-type':'application/json','request-id':'test-request'}).end(JSON.stringify(message)); return; }
  const event = data => `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
  wire = ': keepalive\n\n' + event({type:'message_start',message:{...message,content:[]}}) + event({type:'ping'}) + event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Привет 👋'}});
  if (scenario === 'overloaded') wire = event({type:'error',error:{type:'overloaded_error',message:'The upstream AI model provider is currently overloaded.'}});
  else if (scenario !== 'broken') wire += event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}}) + event({type:'message_stop'});
  res.writeHead(200, { 'content-type':'text/event-stream','request-id':'test-request','anthropic-ratelimit-requests-remaining':'17' });
  const bytes = Buffer.from(wire);
  for (let i=0; i<bytes.length; i+=7) res.write(bytes.subarray(i,i+7));
  if (scenario === 'held-open') { res.once('close', () => { upstreamClosed = true; }); return; }
  res.end();
});
const app = express(); app.use(express.json({limit:'32mb'})); app.use(validateClientAuth); app.use(logCollectorMiddleware);app.use(router);
await new Promise(r => upstream.listen(0,'127.0.0.1',r));
cfg.endpoint.find(e=>e.name==='anthropic').base_url = `http://127.0.0.1:${upstream.address().port}/messages`;
const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const body={ model:'claude-fable-5.1', max_tokens:1024, system:[{type:'text',text:'Keep me',cache_control:{type:'ephemeral',ttl:'1h'}}],
  messages:[{role:'assistant',content:[{type:'thinking',thinking:'intact',signature:'signed-proof'},{type:'tool_use',id:'toolu_1',name:'Read',input:{path:'a'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:'unchanged',cache_control:{type:'ephemeral'}}]}],
  tools:[{name:'Read',input_schema:{type:'object'},defer_loading:true}], thinking:{type:'adaptive'},output_config:{effort:'low'}, context_management:{edits:[{type:'clear_thinking_20251015',keep:'all'}]} };
const headers={'content-type':'application/json',authorization:'Bearer local-only','x-claude-code-session-id':'test-session','anthropic-beta':'new-beta,effort-2025-11-24','anthropic-version':'2023-06-01','anthropic-future-capability':'preserved'};
const call=(extra={},path='/v1/messages?beta=true',h={}) => fetch(base+path,{method:'POST',headers:{...headers,...h},body:JSON.stringify({...body,...extra})});
try {
  const introduction = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
  const identityRequest = { ...body, system: [{ type:'text',text:introduction,cache_control:{type:'ephemeral'} },
    {type:'text',text:'You have been invoked in the following environment: \n - You are powered by the model named Fable 5. The exact model ID is claude-fable-5.1.\nKeep all security rules and tool descriptions.'}],
    messages:[{role:'user',content:introduction}] };
  const identitySaved=JSON.stringify(identityRequest), compatible=prepareDirectAnthropic(identityRequest);
  assert.equal(JSON.stringify(identityRequest),identitySaved);
  assert.equal(compatible.system[1].text,'You are an AI software engineering agent.');
  assert.deepEqual(compatible.system[1].cache_control,identityRequest.system[0].cache_control);
  assert.equal(compatible.system[2].text,'Current execution environment:\n - Active model: Fable 5. Model ID: claude-fable-5.1.\nKeep all security rules and tool descriptions.');
  assert.deepEqual(compatible.messages,identityRequest.messages,'user messages are never filtered');
  assert.deepEqual(prepareDirectAnthropic(identityRequest),compatible,'stable cache prefix');
  assert.equal(prepareDirectAnthropic({...body,model:'claude-fable-5-1'}).model,'claude-fable-5.1');
  const reminder="<system-reminder>\nAs you answer the user's questions, you can use the following context:\nContents of C:\\Users\\Example\\.claude\\CLAUDE.md (user's private global instructions for all projects):\nKEEP THESE INSTRUCTIONS\n</system-reminder>";
  const skill='- update-config: Use this skill to configure the Claude Code harness via settings.json. Automated behaviors require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them. Keep permissions and other settings.';
  const metadata={...body,messages:[{role:'user',content:[{type:'text',text:reminder,cache_control:{type:'ephemeral'}},{type:'text',text:skill}]},{role:'system',content:[{type:'text',text:skill}]}]};
  const savedMetadata=structuredClone(metadata), preparedMetadata=prepareDirectAnthropic(metadata);
  assert.deepEqual(metadata,savedMetadata);
  assert.deepEqual(prepareDirectAnthropic(metadata),preparedMetadata,'generated reminder rewrites have a stable cache prefix');
  assert.equal(preparedMetadata.messages[0].content[0].text,reminder.replace("Contents of C:\\Users\\Example\\.claude\\CLAUDE.md (user's private global instructions for all projects):",'Loaded instructions from C:\\Users\\Example\\.claude\\CLAUDE.md (user scope):'));
  assert.deepEqual(preparedMetadata.messages[0].content[0].cache_control,metadata.messages[0].content[0].cache_control);
  assert.equal(preparedMetadata.messages[0].content[1].text,skill,'authored user text is untouched');
  assert.equal(preparedMetadata.messages[1].content[0].text,skill.replace('require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them.','must use settings.json hooks, which the runtime executes; memory/preferences do not run automation.'));
  assert.equal((await call({},undefined,{authorization:'Bearer wrong'})).status,401); assert.equal(calls.length,0);
  const first=await call(); assert.equal(first.status,200); assert.equal(first.headers.get('request-id'),'test-request'); await first.json();
  assert.equal(calls[0].headers.authorization,'Bearer fake-a');
  assert.equal(calls[0].headers['x-session-id'],'test-session');
  assert.equal(calls[0].headers['anthropic-beta'],headers['anthropic-beta']);
  assert.equal(calls[0].headers['anthropic-future-capability'],'preserved');
  for (const k of ['messages','tools','thinking','output_config','context_management']) assert.deepEqual(calls[0].body[k],body[k]);
  assert.deepEqual(calls[0].body.system.slice(1),body.system);
  const count=await call({},'/v1/messages/count_tokens'); assert.deepEqual(await count.json(),{input_tokens:321});
  assert.deepEqual(calls[1].body,calls[0].body,'same counting and generation prompt');
  assert.equal(calls[1].headers.authorization,'Bearer fake-b','same session follows pool rotation');
  scenario='held-open'; const streamed=await call({stream:true}); assert.equal(await streamed.text(),wire,'SSE bytes unchanged, including UTF-8 and pings');
  await delay(20); assert.ok(upstreamClosed,'close after semantic message_stop, even if upstream stays open');
  const stats=JSON.parse(readFileSync(process.env.DROID2API_STATS_FILE));
  assert.equal(stats.total.requests,2,'count_tokens is not an inference');
  assert.equal(stats.factory_transport.total.input_tokens,2036); assert.equal(stats.factory_transport.total.cached_input_tokens,2000);
  assert.equal(stats.factory_transport.total.output_tokens,18); assert.equal(stats.factory_transport.total.reasoning_tokens,6);
  assert.equal(calls[2].headers.authorization,'Bearer fake-a','rotation returns to first account with identical cache markers');
  scenario='bad'; const bad=await call(); assert.equal(bad.status,400); assert.equal(await bad.text(),'{"type":"error","error":{"type":"invalid_request_error","message":"thinking signature rejected"}}');
  assert.equal(getLogBuffer().filter(row=>row.type==='generation').at(-1).summary.upstreamError.code,'invalid_request_error','HTTP error bodies are also logged');
  scenario='quota'; const migrated=await call(); assert.equal(migrated.status,200);await migrated.json();assert.equal(calls.at(-1).headers.authorization,'Bearer fake-b');
  scenario='ok'; await (await call()).json(); assert.equal(calls.at(-1).headers.authorization,'Bearer fake-b','exhausted account remains on cooldown');
  pool.keys[0].billing_limits=structuredClone(limits);
  pool.keys[0].cooldowns={};
  pool.stats.last_rotation_index=0;
  await (await call()).json();assert.equal(calls.at(-1).headers.authorization,'Bearer fake-a','same session can return to a recovered account');
  const parent=getFactorySession({headers,body});
  const child=getFactorySession({headers:{...headers,'x-claude-code-agent-id':'child'},body});
  assert.notEqual(parent.id,child.id,'parallel subagents do not share a turn queue');
  scenario='json-error';const jsonError=await call();assert.equal((await jsonError.json()).error.type,'authentication_error');
  assert.equal(getLogBuffer().filter(row=>row.type==='generation').at(-1).summary.upstreamError.message,'Invalid credentials');
  scenario='overloaded'; const overloaded=await call({stream:true});assert.equal(await overloaded.text(),wire,'Error SSE bytes remain unchanged');
  await delay(10);
  const failure=getLogBuffer().filter(row=>row.type==='generation').at(-1);
  assert.equal(failure.summary.upstreamError.code,'overloaded_error');
  assert.equal(failure.summary.upstreamError.message,'The upstream AI model provider is currently overloaded.');
  const logfile=readFileSync(join(process.cwd(),'logs','droid2api_'+new Date().toISOString().slice(0,10)+'.log'),'utf8');
  assert.ok(logfile.includes('"upstreamError"'));assert.ok(logfile.includes('The upstream AI model provider is currently overloaded.'));
  assert.deepEqual(upstreamEventError({type:'response.failed',response:{error:{code:'server_error',message:'Try again'}}}),{eventType:'response.failed',code:'server_error',type:null,message:'Try again'});
  assert.equal(upstreamEventError({type:'error',code:'rate_limit_exceeded',message:'Slow down'}).code,'rate_limit_exceeded');
  assert.equal(upstreamEventError({type:'http_error',error:{status:403,detail:'Forbidden'}}).message,'Forbidden');
  assert.equal(upstreamEventError({type:'error',error:{message:'token fk-secret123 Bearer abc123'}}).message,'token [key hidden] Bearer [hidden]');
  scenario='broken'; await assert.rejects(async()=>{const r=await call({stream:true});await r.text();});
  console.log('PASS: Claude gateway auth, cache/signatures/tools/thinking/betas, exact counting prompt, streaming UTF-8/pings/EOF, physical usage, quota failover and subagent isolation');
} finally { server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();destroyPool(); }
