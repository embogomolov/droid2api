import {$,state,api,escape as e,suffix,date,action,notify} from './ui.js';
let initialized=false, dirty=false;
export function renderWindows(force=false) {
  const data=state.sync; if(!data)return;
  const cfg=data.settings, phase=data.state.phase;
  if(!initialized||force){
    $('syncEnabled').checked=cfg.enabled; $('hoursEnabled').checked=cfg.workingHours.enabled;
    $('hoursStart').value=cfg.workingHours.start; $('hoursEnd').value=cfg.workingHours.end;
    $('syncModel').innerHTML=data.models.map(m=>'<option value="'+e(m.id)+'">'+e(m.name)+' · '+(m.group==='core'?'Droid Core':'Standard')+'</option>').join('');
    if(!data.models.some(m=>m.id===cfg.modelId))$('syncModel').add(new Option(cfg.modelId+' (removed)',cfg.modelId));
    $('syncModel').value=cfg.modelId;
    $('syncKeys').innerHTML=data.keys.map(key=>{
      const name=state.keys.find(k=>k.id===key.id)?.notes;
      return '<label class="check"><input type="checkbox" name="syncKey" value="'+e(key.id)+'" '+(cfg.keyIds.includes(key.id)?'checked':'')+'><span>'+e(name||suffix(key.id))+(key.excluded?' <small>Excluded — omitted</small>':!key.tested?' <small>Needs test</small>':'')+'</span></label>';
    }).join('')||'<p class="muted">Add an account first.</p>';
    for(const id of cfg.keyIds.filter(id=>!data.keys.some(k=>k.id===id)))$('syncKeys').insertAdjacentHTML('beforeend','<label class="check"><input type="checkbox" name="syncKey" value="'+e(id)+'" checked><span>'+e(suffix(id))+' <small>Removed — uncheck to save</small></span></label>');
    initialized=true;dirty=false;$('windowSaved').textContent='Saved configuration';
  }
  $('hoursFields').hidden=!$('hoursEnabled').checked;
  $('syncTimezone').textContent='Server timezone: '+data.timezone;
  const label=!cfg.enabled?'Automatic starts are off':data.error?'Check failed — retrying':phase==='active'?'Windows started':phase==='starting'?'Starting selected windows':'Waiting for all accounts';
  $('syncStatus').innerHTML='<p class="badge '+(data.error?'bad':phase==='active'?'':'warn')+'">'+e(label)+'</p><p class="below">'+e(data.error||data.state.message||'Waiting for a fresh quota check.')+'</p><p class="hint">Next check: '+e(date(data.state.nextCheckAt))+'</p>'+(Number.isFinite(data.state.spreadMs)?'<p class="hint">Last confirmed start spread: '+e(data.state.spreadMs)+' ms</p>':'');
  $('syncMembers').innerHTML='<table><thead><tr><th>Selected account</th><th>State</th><th>Start attempts</th><th>Confirmed reset</th><th>Next retry / error</th></tr></thead><tbody>'+cfg.keyIds.map(id=>{
    const key=data.keys.find(k=>k.id===id), m=data.state.members[id]||{};
    const status=!key?'Removed':key.excluded?'Excluded':key.status!=='active'?key.status:!key.tested?'Needs test':m.confirmedEnd>Date.now()?'Confirmed':m.acceptedAt?'Verifying start':m.refreshError?'Retrying quota check':m.quotaReady===false?'Waiting for quota':m.ready?'Ready':'Waiting';
    return '<tr><td data-label="Account">'+e(suffix(id))+'</td><td data-label="State">'+e(status)+'</td><td data-label="Start attempts">'+e(m.attempts||0)+'</td><td data-label="Confirmed reset">'+e(date(m.confirmedEnd))+'</td><td data-label="Next retry / error">'+e(m.refreshError||m.error||date(m.refreshAfter||m.nextAttemptAt))+'</td></tr>';
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
