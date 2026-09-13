import {$,state,api,escape as e,algorithms,action,notify,confirmAction} from './ui.js';
const sectionNames={models:'Models',system_prompt:'System prompt',key_pool:'Advanced balancing, retries and groups',reasoning:'Reasoning',reasoning_tokens:'Reasoning token budgets',endpoint:'Upstream endpoints',port:'Listen port',redis:'Redis',cluster:'Cluster',token_sync:'Usage synchronization',limits:'Size limits'};
let ready=false;
function sectionValue(){ const field=$('configSection').value; const value=structuredClone(state.config[field]); if(field==='key_pool'&&value)delete value.algorithm; $('configJson').value=JSON.stringify(value,null,2); }
function describe(){ $('algorithmHelp').textContent=(algorithms[$('algorithm').value]?.[1]||'Server-specific policy.')+' Excluded, untested and unavailable accounts are skipped.'; }
export function renderSettings(force=false) {
  if(!ready||force){
    $('algorithm').innerHTML=Object.entries(algorithms).map(([id,[name]])=>'<option value="'+id+'">'+e(name)+'</option>').join('');
    if(state.config.key_pool?.algorithm&&!algorithms[state.config.key_pool.algorithm])$('algorithm').add(new Option(state.config.key_pool.algorithm,state.config.key_pool.algorithm));
    $('algorithm').value=state.config.key_pool?.algorithm||'round-robin';describe();
    // Window selection has its own validated endpoint and must not be overwritten by the generic editor.
    $('configSection').innerHTML=Object.keys(state.config).filter(key=>key!=='window_sync'&&!/secret|password|access_key|api_key/i.test(key)).map(key=>'<option value="'+e(key)+'">'+e(sectionNames[key]||key)+'</option>').join('');
    $('configSection').value=state.config.models?'models':$('configSection').value;sectionValue();ready=true;
  }
  $('openaiUrl').textContent=location.origin+'/v1';$('anthropicUrl').textContent=location.origin;
  $('poolRows').innerHTML=state.pools.map(pool=>'<div class="pool-row"><span>'+e(pool.name)+' <small>'+e(pool.id)+' · priority '+e(pool.priority)+'</small></span>'+(pool.id!=='default'?'<button data-delete-pool="'+e(pool.id)+'">Delete group</button>':'')+'</div>').join('')||'<p class="muted">All accounts use the default group.</p>';
}
export function initSettings(refresh) {
  $('algorithm').onchange=describe;
  $('routingForm').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
    await api('/config','PUT',{key_pool:{algorithm:$('algorithm').value}});state.config=await api('/config');await refresh();notify('Balancing saved.');
  });};
  $('configSection').onchange=sectionValue;
  $('reloadSection').onclick=event=>action(event.currentTarget,async()=>{state.config=await api('/config');sectionValue();notify('Saved section reloaded.');});
  $('configEditor').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
    const field=$('configSection').value;let value;
    try{value=JSON.parse($('configJson').value);}catch{throw new Error('Invalid JSON. Nothing was saved.');}
    if(field==='key_pool'&&Object.hasOwn(value||{},'algorithm'))throw new Error('Change the algorithm with Save balancing above.');
    if(field==='models'&&(!Array.isArray(value)||value.some(m=>!m.id||!m.type)))throw new Error('Models must be an array with id and type for each model.');
    const previous=state.config[field];
    if(previous!==null&&(Array.isArray(previous)!==Array.isArray(value)||typeof previous!==typeof value||value===null))throw new Error('Keep the section’s original JSON type.');
    await api('/config','PUT',{[field]:value});state.config=await api('/config');sectionValue();notify('Section saved. Listener and transport changes may need a proxy restart.');
  });};
  $('poolForm').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
    const form=new FormData(event.target);await api('/pool-groups','POST',{id:form.get('id'),name:form.get('name'),priority:Number(form.get('priority'))});event.target.reset();await refresh();notify('Group created.');
  });};
  $('poolRows').onclick=event=>{const button=event.target.closest('[data-delete-pool]');if(button)confirmAction('Delete group','Accounts in this group will move to the default group.',async()=>{await api('/pool-groups/'+encodeURIComponent(button.dataset.deletePool),'DELETE');await refresh();});};
  const loadFilter=async()=>{const cfg=await api('/keyword-filter/config');$('filterJson').value=JSON.stringify(cfg,null,2);};
  $('filterDetails').addEventListener('toggle',()=>{if($('filterDetails').open&&!$('filterJson').value)action(null,loadFilter);});
  $('reloadFilter').onclick=event=>action(event.currentTarget,loadFilter);
  $('filterForm').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
    let cfg;try{cfg=JSON.parse($('filterJson').value);}catch{throw new Error('Invalid JSON. Nothing was saved.');}
    await api('/keyword-filter/config','PUT',cfg);await loadFilter();notify('Filter saved.');
  });};
}
