import {$,state,api,escape as e,suffix,date,number,dialog,confirmAction,action,notify,algorithms} from './ui.js';
let reload;
export function meter(window, stale=false) {
  if (!window || !Number.isFinite(window.usedPercent)) return '<div class="muted">No data</div><div class="meter-empty"></div><small>Awaiting Factory</small>';
  const expired=Date.parse(window.windowEnd)<=Date.now(), value=expired?0:window.usedPercent;
  const tone=stale?'stale':value>=90?'bad':value>=70?'warn':'';
  const reset=expired||window.awaitingStart||(!window.windowEnd&&value===0)?'Starts with next use':window.windowEnd?'Reset '+date(window.windowEnd):'Reset not reported';
  return '<div class="meter-head"><strong>'+e(value)+'%</strong><span>'+(stale?'Last reported':e(Math.max(0,100-value))+'% left')+'</span></div><div class="meter-track" role="progressbar" aria-label="Quota used'+(stale?' (stale data)':'')+'" aria-valuenow="'+Math.min(100,Math.max(0,value))+'" aria-valuemin="0" aria-valuemax="100"><div class="meter-fill '+tone+'" style="width:'+Math.min(100,Math.max(0,value))+'%"></div></div><div class="meter-note">'+e(reset)+'</div>';
}
export function accountStatus(key, limits) {
  if(key.excluded)return ['Excluded','dim','Not used by routing or automatic starts'];
  if(key.status!=='active')return [key.status==='banned'?'Blocked':'Disabled','bad',key.banned_reason||'Not eligible for routing'];
  if(key.last_test_result!=='success')return [key.last_test_result==='failed'?'Test failed':'Needs test','warn','A successful test is required'];
  if(limits?.available===false)return ['Limit / cooldown','bad',limits.reason+(limits.retryAt?' · '+date(limits.retryAt):'')];
  const route=key.routing?.[state.group];
  if(route?.blocked)return ['Waiting for group','warn',route.blocked];
  if(!limits?.known || limits.stale)return ['Needs quota refresh','warn','Last data is missing or stale; routing rechecks it'];
  return ['Eligible','','Selection follows your balancing policy'];
}
export function renderAccounts() {
  const query=$('accountSearch').value.toLowerCase();
  const keys=state.keys.filter(k=>(suffix(k.id)+' '+(k.notes||'')).toLowerCase().includes(query));
  $('accountSummary').textContent=state.keys.length+' accounts · '+state.keys.filter(k=>k.excluded).length+' excluded';
  const algorithm=state.config.key_pool?.algorithm==='weighted-usage'?'max-remaining':state.config.key_pool?.algorithm;
  $('algorithmLabel').textContent='Balancing: '+(algorithms[algorithm]?.[0]||algorithm||'—');
  $('accountRows').innerHTML=keys.map(key=>{
    const snapshot=state.limits[key.id], limits=snapshot?.[state.group];
    const status=accountStatus(key,limits), managed=state.sync?.settings.enabled&&state.sync.settings.keyIds.includes(key.id)&&!key.excluded;
    const testDisabled=key.excluded||managed;
    return '<tr data-account="'+e(key.id)+'"><td><span class="account-name" title="'+e(key.notes||suffix(key.id))+'">'+e(key.notes||suffix(key.id))+'</span><span class="subline">'+e(key.notes?suffix(key.id):key.poolGroup||'default')+'</span><span class="subline">Updated '+e(date(snapshot?.fetchedAt))+(snapshot?.error?' · refresh failed':'')+'</span></td><td><span class="badge '+status[1]+'">'+e(status[0])+'</span><span class="subline" title="'+e(status[2])+'">'+e(limits?.available===false?limits.reason:'')+'</span>'+(managed?'<span class="subline">Synchronized group</span>':'')+(limits?.extraUsage?'<span class="subline">Prepaid extra usage enabled</span>':'')+'</td>'+['fiveHour','weekly','monthly'].map((name,index)=>'<td data-label="'+['5 hours used','7 days used','30 days used'][index]+'">'+meter(limits?.windows?.[name],limits?.stale)+'</td>').join('')+'<td><div class="row-actions"><button data-action="test" '+(testDisabled?'disabled ':'')+'title="'+(managed?'Managed by automatic window starts':key.excluded?'Enable usage before testing':'Sends a real request and uses quota')+'">Test</button><button data-action="exclude">'+(key.excluded?'Enable usage':'Disable usage')+'</button><button data-action="edit" aria-label="Details for '+e(suffix(key.id))+'">Details</button></div></td></tr>';
  }).join('')||'<tr><td colspan="6" class="empty">'+(state.keys.length?'No matching accounts.':'No accounts yet. Add a Factory key to begin.')+'</td></tr>';
}
function poolOptions(current) {
  const options=[{id:'default',name:'Default'},...state.pools.filter(p=>p.id!=='default')];
  if(current&&!options.some(p=>p.id===current))options.push({id:current,name:current});
  return options.map(p=>'<option value="'+e(p.id)+'" '+(p.id===current?'selected':'')+'>'+e(p.name)+'</option>').join('');
}
export function initAccounts(refresh) {
  reload=refresh;
  $('accountSearch').oninput=renderAccounts;
  document.querySelectorAll('[data-group]').forEach(button=>button.onclick=()=>{
    state.group=button.dataset.group; document.querySelectorAll('[data-group]').forEach(b=>b.setAttribute('aria-pressed',String(b===button))); renderAccounts();
  });
  $('refreshAccounts').onclick=event=>action(event.currentTarget,()=>reload(true));
  $('addAccount').onclick=()=>dialog('Add Factory keys','<label>Keys, one per line<textarea name="keys" rows="5" required spellcheck="false" autocomplete="off" placeholder="fk-…"></textarea></label><label>Group<select name="poolGroup">'+poolOptions('default')+'</select></label><p class="hint">Keys are imported without a test. Use Test on an account when you are ready to spend quota.</p>',async form=>{
    const keys=[...new Set(String(form.get('keys')).split(/\s+/).filter(Boolean))];
    if(!keys.length||keys.some(key=>!key.startsWith('fk-')))throw new Error('Every key must start with fk-.');
    const result=await api('/keys/batch','POST',{keys,poolGroup:form.get('poolGroup'),autoTest:false});
    notify('Added '+result.import.success+' · duplicates '+result.import.duplicate+' · invalid '+result.import.invalid); await reload();
  },'Add keys');
  $('accountRows').onclick=event=>{
    const button=event.target.closest('button[data-action]'); if(!button)return;
    const key=state.keys.find(k=>k.id===button.closest('tr').dataset.account); if(!key)return;
    const endpoint='/keys/'+encodeURIComponent(key.id);
    if(button.dataset.action==='exclude')return action(button,async()=>{await api(endpoint+'/exclusion','PATCH',{excluded:!key.excluded}); await reload(); notify(key.excluded?'Usage enabled. A successful test and available quota are still required.':'Usage disabled. Already sent requests may finish.');});
    if(button.dataset.action==='test')return confirmAction('Test '+suffix(key.id),'This sends a real model request, uses quota and can start usage windows.',async()=>{
      const result=await api(endpoint+'/test','POST',{},120000); await reload();
      if(!result.success)throw new Error(result.message||'Test failed (HTTP '+result.status+').'); notify('Test passed.');
    });
    if(button.dataset.action==='edit'){
      const quota=key.routing?.[state.group]?.quota;
      const explanation=quota?'<p class="hint">Last routing calculation: '+e(date(quota.at))+'<br>Target share: '+e((quota.share*100).toFixed(1))+'% · '+e({measured:'Reset-aware · refined by measured intervals',adaptive:'Reset-aware · no reliable price adjustment yet',partial:'Reset-aware · some quota data is missing or stale',learning:'Previous calculation · learning',telemetry_unavailable:'Quota telemetry unavailable'}[quota.mode])+(quota.limitingWindow?'<br>Limiting window: '+e({fiveHour:'5 hours',weekly:'7 days',monthly:'30 days'}[quota.limitingWindow])+' · '+e(quota.remaining??'Unknown')+'% remaining · planning boundary '+e(date(quota.resetAt)):'')+'<br>In flight at selection: '+e(quota.inFlight)+(quota.selected?' · Selected for that request':'')+(quota.windows?'<br>Calibration evidence: '+quota.windows.map(w=>e({fiveHour:'5h',weekly:'7d',monthly:'30d'}[w.window])+' '+e(w.intervals)+' intervals'+(!w.fresh?' (stale / missing)':'')).join(' · '):'')+'</p>':'';
      dialog('Account '+suffix(key.id),'<label>Name / notes<input name="notes" value="'+e(key.notes)+'"></label><label>Group<select name="poolGroup">'+poolOptions(key.poolGroup||'default')+'</select></label><p class="hint">Last used: '+e(date(key.last_used_at))+' · Requests: '+number(key.usage_count)+'<br>Technical status: '+e(key.status)+' · Last test: '+e(key.last_test_result)+'</p>'+explanation+'<div class="actions"><button type="button" id="deleteAccount">Delete key</button></div>',async form=>{
        await api(endpoint+'/notes','PATCH',{notes:form.get('notes')});
        if(form.get('poolGroup')!==(key.poolGroup||'default'))await api(endpoint+'/pool','PATCH',{poolGroup:form.get('poolGroup')});
        await reload();notify('Account saved.');
      });
      $('deleteAccount').onclick=()=>{ $('editor').close();confirmAction('Delete '+suffix(key.id),'Remove this key from the proxy? Its Factory account is not deleted.',async()=>{await api(endpoint,'DELETE');await reload();notify('Key deleted.');});};
    }
  };
}
