// Execute the actual form handlers with an isolated DOM and saved-settings API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_WINDOW_SYNC} from '../utils/window-settings.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{value:'',checked:false,hidden:false,textContent:'',innerHTML:'',add(){},insertAdjacentHTML(){}}]));
const buttons=['standard','core'].map(group=>({dataset:{syncGroup:group},setAttribute(name,value){this[name]=value;}}));
let selected=[],saved=structuredClone(DEFAULT_WINDOW_SYNC),pending,fail=false;
const keys=[{id:'a',keySuffix:'…a',notes:'First',status:'active',tested:true},{id:'b',keySuffix:'…b',notes:'Second',status:'active',tested:true}];
const snapshot=()=>({settings:structuredClone(saved),running:true,timezone:'UTC',keys,models:[{id:'gpt-5.6-luna',name:'Luna',group:'standard'},{id:'glm-5.3-flash',name:'GLM Flash',group:'core'},{id:'kimi-k3.1-pro',name:'Kimi',group:'core'}],state:{groups:{standard:{phase:'waiting',members:{}},core:{phase:'waiting',members:{}}}}});
const state={keys,sync:snapshot()},listeners=new Map();
Object.defineProperty(nodes.get('syncKeys'),'innerHTML',{set(value){selected=[...value.matchAll(/value="([^"]+)" (checked)?/g)].filter(m=>m[2]).map(m=>({value:m[1]}));}});
const context={structuredClone,Date,state,
  $:id=>{assert.ok(nodes.has(id),'Missing real DOM element: '+id);return nodes.get(id);},
  e:String,suffix:id=>'…'+id,date:String,Option:function(){},notify:()=>{},
  action:(_button,fn)=>{pending=fn();},
  document:{querySelectorAll:selector=>selector==='[data-sync-group]'?buttons:selected,addEventListener:(name,fn)=>listeners.set(name,fn)},
  api:async(_path,method,body)=>{if(method==='PUT'){if(fail)throw new Error('Save failed');saved=structuredClone(body);}return snapshot();}
};
const source=fs.readFileSync(new URL('../public/windows.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function','function');
vm.runInNewContext(source+'\nglobalThis.ui={renderWindows,initWindows};',context);
context.ui.initWindows(async()=>{});context.ui.renderWindows();
const change=()=>nodes.get('windowForm').oninput();
const save=async()=>{nodes.get('windowForm').onsubmit({preventDefault(){},submitter:{}});await pending;};
assert.equal(nodes.get('syncEnabled').checked,false);
nodes.get('syncEnabled').checked=true;selected=[{value:'a'}];nodes.get('hoursEnabled').checked=true;
nodes.get('hoursStart').value='08:00';nodes.get('hoursEnd').value='18:00';nodes.get('stopBeforeResetSeconds').value='45';change();
buttons[1].onclick();assert.equal(nodes.get('syncEnabled').checked,false,'Core is not enabled by selecting the tab');
assert.equal(buttons[1]['aria-pressed'],'true');assert.equal(nodes.get('coreSyncHint').hidden,false);
nodes.get('syncEnabled').checked=true;selected=[{value:'b'}];nodes.get('syncModel').value='kimi-k3.1-pro';
nodes.get('hoursEnabled').checked=true;nodes.get('hoursStart').value='22:00';nodes.get('hoursEnd').value='06:00';change();
for(let i=0;i<3;i++){
  buttons[0].onclick();assert.equal(nodes.get('syncEnabled').checked,true);assert.equal(nodes.get('hoursStart').value,'08:00');assert.deepEqual(selected,[{value:'a'}]);
  buttons[1].onclick();assert.equal(nodes.get('syncModel').value,'kimi-k3.1-pro');assert.equal(nodes.get('hoursStart').value,'22:00');assert.deepEqual(selected,[{value:'b'}]);
}
state.sync=snapshot();context.ui.renderWindows();assert.equal(nodes.get('syncEnabled').checked,true,'Background polling preserves unsaved edits');
fail=true;await assert.rejects(save(),/Save failed/);assert.equal(nodes.get('windowSaved').textContent,'Unsaved changes');
fail=false;await save();
assert.equal(saved.groups.standard.enabled,true);assert.equal(saved.groups.core.enabled,true);
assert.deepEqual(saved.groups.standard.keyIds,['a']);assert.deepEqual(saved.groups.core.keyIds,['b']);
assert.equal(saved.groups.core.modelId,'kimi-k3.1-pro');assert.equal(saved.stopBeforeResetSeconds,45);
assert.equal(nodes.get('windowSaved').textContent,'Saved configuration');
nodes.get('syncEnabled').checked=false;change();await save();
assert.equal(saved.groups.standard.enabled,true);assert.equal(saved.groups.core.enabled,false);
nodes.get('syncEnabled').checked=true;change();buttons[0].onclick();
nodes.get('hoursStart').value='10:00';change();nodes.get('reloadWindows').onclick({currentTarget:{}});await pending;
assert.equal(nodes.get('hoursStart').value,'08:00');buttons[1].onclick();assert.equal(nodes.get('syncEnabled').checked,false,'Reload discards both unsaved drafts');
saved.groups.core.enabled=true;state.sync=snapshot();context.ui.renderWindows(true);
assert.match(nodes.get('syncStatus').innerHTML,/at most once per minute/);
assert.doesNotMatch(nodes.get('syncStatus').innerHTML,/Quota checks do not send model requests/);
state.sync.state.groups.core={phase:'waiting',members:{},blockedKeyId:'b',blockReason:'Standard is still available'};
context.ui.renderWindows();assert.match(nodes.get('syncStatus').innerHTML,/Second: Standard is still available/);
state.sync.state.groups.core.blockReason='Telemetry unavailable';state.sync.state.groups.core.members.b={refreshError:'Telemetry unavailable'};
context.ui.renderWindows();assert.match(nodes.get('syncStatus').innerHTML,/Second: Telemetry unavailable/);
saved.groups.core.keyIds=[];state.sync=snapshot();listeners.get('accounts-changed')();assert.equal(selected.length,0,'Deleted account disappears from saved selection');
console.log('PASS: independent tabs, unsaved drafts, polling, failed save, round-trip save, reload and blocker display');
