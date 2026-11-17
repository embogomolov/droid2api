// Isolated UI polling and cached limits route; no live accounts or Factory requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { accountStatus } from '../public/accounts.js';
import { state } from '../public/ui.js';
import { getLimitState } from '../utils/factory-limits.js';

const allowance={available:true,known:true,stale:false};
const key={id:'example',status:'active',last_test_result:'success',routing:{
  standard:{blocked:null,action:{label:'Starting…',pending:true},allowance},
  core:{blocked:'Manual request is being verified',action:{label:'Test'},allowance}
}};
state.group='standard';
key.last_test_result='pending';
assert.equal(accountStatus(key,allowance)[0],'Starting…');
key.last_test_result='success';
state.group='core';
assert.equal(accountStatus(key,allowance)[0],'Starting…','Manual start also explains the other pool barrier');
key.routing.standard.action.label='Testing…';
assert.equal(accountStatus(key,allowance)[0],'Testing…');
key.routing.core.blocked='Waiting for the selected group to start its next five-hour windows';
key.routing.standard.action.pending=false;
assert.equal(accountStatus(key,allowance)[0],'Waiting for group');
key.routing.core.blocked=null;
assert.equal(accountStatus(key,allowance)[0],'Eligible');
key.excluded=true;
assert.equal(accountStatus(key,allowance)[0],'Excluded');

// Execute the actual limits handler with a stub manager, avoiding auth.js side effects.
const routeSource=fs.readFileSync(new URL('../api/token-usage-routes.js',import.meta.url),'utf8');
const handlerSource=routeSource.slice(routeSource.indexOf("router.get('/limits'"),routeSource.indexOf("}, 'get Factory usage limits'));")+"}, 'get Factory usage limits'));".length);
let handler, quotaReads=0;
vm.runInNewContext(handlerSource,{
  router:{get:(_path,fn)=>handler=fn},wrapAsync:fn=>fn,getLimitState,
  keyPoolManager:{keys:[{id:'example'}],refreshBillingLimits:async()=>{quotaReads++;}},
  sendSuccessResponse:(res,data)=>res.data=data
});
const response={};
await handler({query:{cachedOnly:'true'}},response);
assert.equal(quotaReads,0);
assert.equal(response.data.keys.example.standard.known,false,'Unknown quota stays unknown');
await handler({query:{}},response);
await handler({query:{cachedOnly:'true',forceRefresh:'true'}},response);
assert.equal(quotaReads,2,'Normal and explicit refresh still update quota');

const uiState={keys:[],limits:{},config:{},group:'standard',tab:'accounts'};
const nodes=new Map(), listeners=new Map(), timers=new Map(), paths=[];
let nextTimer=0, pending=true, used=0, renderFailure=false, limitFailure=false;
let rendered;
const context={
  state:uiState,Date,Event,
  $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},
  document:{hidden:false,querySelectorAll:()=>[],dispatchEvent:()=>{},addEventListener:(name,fn)=>listeners.set(name,fn)},
  window:{addEventListener:()=>{}},location:{hash:'#accounts'},
  sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  localStorage:{getItem:()=>null,removeItem:()=>{}},
  setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},
  clearTimeout:id=>timers.delete(id),
  setCredential:()=>{},wireUI:()=>{},initAccounts:()=>{},initWindows:()=>{},initSettings:()=>{},initRequests:()=>{},
  notify:()=>{},action:()=>{},refreshRequests:async()=>{},renderSettings:()=>{},
  renderAccounts:()=>{rendered={used:uiState.limits.example.standard.windows.fiveHour.usedPercent,pending:!!uiState.keys[0].routing.standard.action.pending};},
  renderWindows:()=>{if(renderFailure)throw new Error('Simulated render failure');},
  api:async path=>{
    paths.push(path);
    if(path.startsWith('/token/limits')){
      if(limitFailure)throw new Error('Simulated telemetry outage');
      return {keys:{example:{standard:{windows:{fiveHour:{usedPercent:used}}}}}};
    }
    if(path.startsWith('/keys'))return {keys:[{id:'example',routing:{standard:{blocked:null,action:{pending}}}}]};
    if(path==='/pool-groups')return [];
    return {};
  }
};
const appSource=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export async function refresh','async function refresh');
vm.runInNewContext(appSource+'\nglobalThis.app={signIn,refresh,poll,signOut};',context);
await context.app.signIn('test-only');
assert.equal(timers.size,1);
assert.equal([...timers.values()][0].delay,2000);
assert.equal(rendered.pending,true);
pending=false;used=1;paths.length=0;
await [...timers.values()][0].fn();
assert.ok(paths.includes('/token/limits?cachedOnly=true'));
assert.deepEqual(rendered,{used:1,pending:false},'Confirmation and quota update without a page reload');
assert.equal([...timers.values()][0].delay,10000);
await context.app.refresh(true);
assert.equal(paths.at(-4),'/token/limits?forceRefresh=true');
renderFailure=true;
await context.app.poll();
assert.equal(timers.size,1,'An error must not stop polling');
renderFailure=false;limitFailure=true;
await context.app.poll();
assert.equal(nodes.get('accountsError').hidden,false);
assert.equal(timers.size,1);
limitFailure=false;used=2;
context.document.hidden=true;paths.length=0;
await context.app.poll();
assert.equal(paths.length,0,'Hidden tabs do not poll');
context.document.hidden=false;
listeners.get('visibilitychange')();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(rendered.used,2,'Returning to the tab refreshes immediately');
context.app.signOut();
assert.equal(timers.size,0);
console.log('PASS: manual status, cached quota polling, completion, visibility and error recovery');
