// Exercise the real refresh flow with a delayed limits response; no server or quota.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?$/gm,'').replace('export async function refresh','async function refresh');
for(const failure of [false,true]){
  const elements=new Map(),calls=[],renders=[];
  let resolveLimits,rejectLimits,fresh=false;
  const limits=new Promise((resolve,reject)=>{resolveLimits=resolve;rejectLimits=reject;});
  const state={keys:[],limits:{}};
  const noop=()=>{};
  const context={state,console,Date,Promise,Event,setTimeout,clearTimeout,
    $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
    location:{hash:''},document:{querySelectorAll:()=>[],addEventListener:noop,dispatchEvent:noop},
    window:{addEventListener:noop},sessionStorage:{getItem:()=>null},localStorage:{getItem:()=>null},
    setCredential:noop,wireUI:noop,notify:noop,action:noop,
    initAccounts:noop,initWindows:noop,initSettings:noop,initRequests:noop,
    renderAccounts:()=>renders.push(state.keys[0]?.routing.standard.allowance.stale),
    renderWindows:noop,renderSettings:noop,refreshRequests:noop,
    api:async endpoint=>{
      calls.push(endpoint);
      if(endpoint.startsWith('/token/limits'))return limits;
      if(endpoint.startsWith('/keys?'))return {keys:[{id:'fake',key:'fake-secret-key',routing:{standard:{allowance:{known:true,stale:!fresh}}}}]};
      return {};
    }};
  vm.runInNewContext(source+'\nsignedIn=true;globalThis.runRefresh=refresh;',context);
  const pending=context.runRefresh(true);
  await Promise.resolve();
  assert.equal(calls.some(url=>url.startsWith('/keys?')),false,'Do not snapshot routing while limits are still refreshing');
  if(failure)rejectLimits(new Error('Limits unavailable'));
  else{fresh=true;resolveLimits({keys:{fake:{fetchedAt:Date.now()}}});}
  await pending;
  assert.deepEqual(renders,[failure],'Render the post-refresh status, retaining genuine stale data on failure');
  assert.equal(elements.get('accountsError').hidden,!failure);
  if(failure)assert.match(elements.get('accountsError').textContent,/Limits unavailable/);
  assert.equal(state.keys[0].key,undefined,'Do not retain credentials');
}
console.log('PASS: routing waits for quota refresh; failures remain visible and do not prevent account loading');
