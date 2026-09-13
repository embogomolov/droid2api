import {$,state,api,escape as e,suffix,date,action,notify} from './ui.js';
let initialized=false, dirty=false;
export function renderWindows(force=false) {
  const data=state.sync; if(!data)return;
  const cfg=data.settings, phase=data.state.phase;
  if(!initialized||force){
    $('syncEnabled').checked=cfg.enabled; $('hoursEnabled').checked=cfg.workingHours.enabled;
    $('syncOptions').open=cfg.workingHours.enabled; $('hoursStart').value=cfg.workingHours.start; $('hoursEnd').value=cfg.workingHours.end;
    $('syncModel').innerHTML=data.models.map(m=>'<option value="'+e(m.id)+'">'+e(m.name)+' · '+(m.group==='core'?'Droid Core':'Standard')+'</option>').join('');
    if(!data.models.some(m=>m.id===cfg.modelId))$('syncModel').add(new Option(cfg.modelId+' (removed)',cfg.modelId));
    $('syncModel').value=cfg.modelId;
    $('syncKeys').innerHTML=data.keys.map(key=>{
      const name=state.keys.find(k=>k.id===key.id)?.notes;
      return '<label class="check"><input type="checkbox" name="syncKey" value="'+e(key.id)+'" '+(cfg.keyIds.includes(key.id)?'checked':'')+'><span>'+e(name&&!name.startsWith('Imported at ')?name:suffix(key.id))+(key.excluded?' <small>Excluded — omitted</small>':!key.tested?' <small>Needs test</small>':'')+'</span></label>';
    }).join('')||'<p class="muted">Add an account first.</p>';
    for(const id of cfg.keyIds.filter(id=>!data.keys.some(k=>k.id===id)))$('syncKeys').insertAdjacentHTML('beforeend','<label class="check"><input type="checkbox" name="syncKey" value="'+e(id)+'" checked><span>'+e(suffix(id))+' <small>Removed — uncheck to save</small></span></label>');
    initialized=true;dirty=false;$('windowSaved').textContent='Saved configuration';
  }
  $('hoursFields').hidden=!$('hoursEnabled').checked;
  $('syncTimezone').textContent='Server timezone: '+data.timezone;
  const selected=cfg.keyIds.map(id=>({key:data.keys.find(key=>key.id===id), member:data.state.members[id]||{}}));
  const included=selected.filter(item=>item.key&&!item.key.excluded);
  const futureEnds=included.map(item=>Date.parse(item.member.windowEnd)).filter(end=>end>Date.now());
  const refreshError=data.error||included.find(item=>item.member.refreshError)?.member.refreshError;
  let title, explanation;
  if(!cfg.enabled){title='Automatic starts are off';explanation='No automatic model requests will be sent.';}
  else if(data.running===false){title='Automatic starter is stopped';explanation='Restart the proxy to resume automatic checks.';}
  else if(selected.some(item=>!item.key)){title='Selected account was removed';explanation='Remove it from the selection and save.';}
  else if(!included.length){title='No accounts selected for use';explanation='Select an account with usage enabled.';}
  else if(included.some(item=>item.key.status!=='active'||!item.key.tested)){title='Account needs attention';explanation='Selected accounts must be enabled and successfully tested.';}
  else if(refreshError){title='Retrying the quota check';explanation=refreshError;}
  else if(phase==='starting'){title=included.some(item=>item.member.acceptedAt)?'Verifying the new window':'Starting the next window';explanation='Waiting for Factory to confirm each selected account. Accepted starts are not replayed.';}
  else if(included.some(item=>item.member.quotaReady===false)){title='Waiting for available quota';explanation='A selected account has no weekly/monthly allowance or is in cooldown. Automatic starts wait too.';}
  else if(futureEnds.length){title=included.length===1?'Current window is still running':'Waiting for current windows to end';explanation='You can keep using available accounts. Automatic starts wait until every selected window has ended.';}
  else if(data.state.message==='Waiting for configured working hours'){title='Waiting for working hours';explanation='The next automatic start is outside the allowed schedule.';}
  else {title='Checking readiness';explanation='Factory must confirm that the selected accounts are ready before a start request is sent.';}
  const check=data.state.nextCheckAt;
  const nextCheck=check>Date.now()?new Date(check).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Due now';
  const model=data.models.find(model=>model.id===cfg.modelId)?.name||cfg.modelId;
  $('syncStatus').innerHTML='<p class="sync-title">'+e(title)+'</p><p class="hint">'+e(explanation)+'</p>'+
    '<dl class="sync-facts"><dt>Selected for use</dt><dd>'+included.length+' '+(included.length===1?'account':'accounts')+'</dd>'+
    (cfg.enabled&&futureEnds.length?'<dt>'+(included.length===1?'Current window ends':'Last current window ends')+'</dt><dd>'+e(date(Math.max(...futureEnds)))+'</dd>':'')+
    (cfg.enabled&&included.length?'<dt>Next quota check</dt><dd>'+e(nextCheck)+'</dd>':'')+'</dl>'+
    (cfg.enabled&&included.length?'<p class="hint">Quota checks do not send model requests. Once ready, '+e(model)+' sends a short request to start the next '+(included.length===1?'window.':'windows together.')+'</p>':'');
  $('syncMembers').innerHTML='<table><thead><tr><th>Selected account</th><th>State</th><th>Last start attempts</th><th>Last confirmed reset</th><th>Next retry / error</th></tr></thead><tbody>'+cfg.keyIds.map(id=>{
    const key=data.keys.find(k=>k.id===id), m=data.state.members[id]||{};
    const status=!key?'Removed':key.excluded?'Excluded':key.status!=='active'?key.status:!key.tested?'Needs test':m.confirmedEnd>Date.now()?'Confirmed':phase==='starting'&&m.acceptedAt?'Verifying start':m.refreshError?'Retrying quota check':m.quotaReady===false?'Waiting for quota':m.ready?'Ready':'Waiting';
    return '<tr><td data-label="Account">'+e(suffix(id))+'</td><td data-label="State">'+e(status)+'</td><td data-label="Last start attempts">'+e(m.attempts||0)+'</td><td data-label="Last confirmed reset">'+e(date(m.confirmedEnd))+'</td><td data-label="Next retry / error">'+e(m.refreshError||m.error||date(m.refreshAfter||m.nextAttemptAt))+'</td></tr>';
  }).join('')+'</tbody></table>';
}
export function initWindows(refresh) {
  $('windowForm').oninput=()=>{dirty=true;$('windowSaved').textContent='Unsaved changes';$('hoursFields').hidden=!$('hoursEnabled').checked;};
  $('reloadWindows').onclick=event=>action(event.currentTarget,async()=>{state.sync=await api('/window-sync');renderWindows(true);});
  $('windowForm').onsubmit=event=>{
    event.preventDefault();action(event.submitter,async()=>{
      const settings={enabled:$('syncEnabled').checked,keyIds:[...document.querySelectorAll('[name=syncKey]:checked')].map(i=>i.value),modelId:$('syncModel').value,workingHours:{enabled:$('hoursEnabled').checked,start:$('hoursStart').value,end:$('hoursEnd').value}};
      await api('/window-sync','PUT',settings);state.sync=await api('/window-sync');renderWindows(true);await refresh();notify('Window settings saved.');
    });
  };
  document.addEventListener('accounts-changed',()=>{if(!dirty)renderWindows(true);});
}
