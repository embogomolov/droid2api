import {$,state,api,setCredential,wireUI,notify,action} from './ui.js';
import {initAccounts,renderAccounts} from './accounts.js';
import {initWindows,renderWindows} from './windows.js';
import {initSettings,renderSettings} from './settings.js';
import {initRequests,refreshRequests} from './requests.js';
const storage='droid2api_admin_key';
let signedIn=false, refreshing=null, lastLimits=0, timer;
const manualPending=()=>state.keys.some(key=>Object.values(key.routing||{}).some(route=>route.action?.pending));
function signOut(){
  signedIn=false;setCredential('');sessionStorage.removeItem(storage);localStorage.removeItem(storage);localStorage.removeItem('droid2api_login_time');
  $('workspace').hidden=true;$('logout').hidden=true;$('login').hidden=false;$('connection').textContent='Local proxy';clearTimeout(timer);
  if($('editor').open)$('editor').close();
}
function showTab(){
  const tab=location.hash.slice(1);state.tab=['accounts','windows','requests','settings'].includes(tab)?tab:'accounts';
  document.querySelectorAll('main>section').forEach(section=>section.hidden=section.id!==state.tab);
  document.querySelectorAll('nav a').forEach(a=>{if(a.hash==='#'+state.tab)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  if(signedIn&&state.tab==='requests')void refreshRequests();
}
async function loadKeys(){
  const keys=[];let page=1,total=1;
  do{const data=await api('/keys?limit=100&page='+page);keys.push(...data.keys);total=data.pagination?.totalPages??data.pagination?.total_pages??1;page++;}while(page<=total);
  // Keep only the display suffix; full credentials never enter UI state or the DOM.
  state.keys=keys.map(({key,...metadata})=>({...metadata,keySuffix:typeof key==='string'&&key.length>9?'…'+key.slice(-9):null}));
}
export async function refresh(force=false){
  while(refreshing)await refreshing;
  refreshing=(async()=>{
    const previous=JSON.stringify(state.keys.map(k=>[k.id,k.excluded,k.status,k.last_test_result,k.notes]));
    // Read the scheduler's latest snapshot on every poll, without extra Factory calls.
    const updateLimits=force||(!manualPending()&&Date.now()-lastLimits>60000);
    const limits=api('/token/limits'+(force?'?forceRefresh=true':updateLimits?'':'?cachedOnly=true'),'GET',undefined,updateLimits?45000:15000)
      .then(data=>{state.limits=data.keys;if(updateLimits)lastLimits=Date.now();});
    // Routing status must observe the completed quota refresh, including failures.
    const jobs=[limits,limits.then(loadKeys,loadKeys),api('/window-sync').then(data=>state.sync=data),api('/pool-groups').then(data=>state.pools=Array.isArray(data)?data:data.groups||data.poolGroups||[])];
    const results=await Promise.allSettled(jobs);if(!signedIn)return;
    const errors=results.filter(r=>r.status==='rejected');
    $('accountsError').hidden=!errors.length;$('accountsError').textContent=errors.map(r=>r.reason.message).join(' ');
    $('connection').textContent=errors.length?'Refresh incomplete':'Connected · '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    renderAccounts();renderWindows();renderSettings();
    if(JSON.stringify(state.keys.map(k=>[k.id,k.excluded,k.status,k.last_test_result,k.notes]))!==previous)document.dispatchEvent(new Event('accounts-changed'));
  })().finally(()=>{refreshing=null;if(signedIn)schedule();});
  return refreshing;
}
async function signIn(key){
  setCredential(key);state.config=await api('/config');signedIn=true;sessionStorage.setItem(storage,key);
  localStorage.removeItem(storage);localStorage.removeItem('droid2api_login_time');
  $('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;$('adminKey').value='';
  showTab();await refresh();
}
async function poll(){
  if(!signedIn)return;
  try{if(!document.hidden){await refresh();if(state.tab==='requests')await refreshRequests();}}
  catch(error){notify(error.message,true);}
  finally{if(signedIn)schedule();}
}
function schedule(){clearTimeout(timer);timer=setTimeout(poll,manualPending()?2000:10000);}
wireUI();initAccounts(refresh);initWindows(refresh);initSettings(refresh);initRequests();
window.addEventListener('hashchange',showTab);document.addEventListener('auth-expired',signOut);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
$('logout').onclick=signOut;
$('login').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{try{await signIn($('adminKey').value.trim());$('loginError').textContent='';}catch(error){$('loginError').textContent=error.message;}});};
showTab();
const saved=sessionStorage.getItem(storage)||localStorage.getItem(storage);
if(saved)signIn(saved).catch(error=>{signOut();$('loginError').textContent=error.message;});
window.addEventListener('beforeunload',()=>clearTimeout(timer));
