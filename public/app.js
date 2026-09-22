import {$,state,api,setCredential,wireUI,notify,action} from './ui.js';
import {initAccounts,renderAccounts} from './accounts.js';
import {initWindows,renderWindows} from './windows.js';
import {initSettings,renderSettings} from './settings.js';
import {initRequests,refreshRequests} from './requests.js';
const storage='droid2api_admin_key';
let signedIn=false, refreshing=null, lastLimits=0, timer;
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
    const limits=force||Date.now()-lastLimits>60000
      ? api('/token/limits'+(force?'?forceRefresh=true':''),'GET',undefined,45000).then(data=>{state.limits=data.keys;lastLimits=Date.now();})
      : Promise.resolve();
    // Routing status must observe the completed quota refresh, including failures.
    const jobs=[limits,limits.then(loadKeys,loadKeys),api('/window-sync').then(data=>state.sync=data),api('/pool-groups').then(data=>state.pools=Array.isArray(data)?data:data.groups||data.poolGroups||[])];
    const results=await Promise.allSettled(jobs);if(!signedIn)return;
    const errors=results.filter(r=>r.status==='rejected');
    $('accountsError').hidden=!errors.length;$('accountsError').textContent=errors.map(r=>r.reason.message).join(' ');
    $('connection').textContent=errors.length?'Refresh incomplete':'Connected · '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    renderAccounts();renderWindows();renderSettings();
    if(JSON.stringify(state.keys.map(k=>[k.id,k.excluded,k.status,k.last_test_result,k.notes]))!==previous)document.dispatchEvent(new Event('accounts-changed'));
  })().finally(()=>refreshing=null);
  return refreshing;
}
async function signIn(key){
  setCredential(key);state.config=await api('/config');signedIn=true;sessionStorage.setItem(storage,key);
  localStorage.removeItem(storage);localStorage.removeItem('droid2api_login_time');
  $('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;$('adminKey').value='';
  showTab();await refresh();schedule();
}
function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{
  if(!signedIn)return;
  if(!document.hidden){await refresh();if(state.tab==='requests')await refreshRequests();}
  schedule();
},10000);}
wireUI();initAccounts(refresh);initWindows(refresh);initSettings(refresh);initRequests();
window.addEventListener('hashchange',showTab);document.addEventListener('auth-expired',signOut);
$('logout').onclick=signOut;
$('login').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{try{await signIn($('adminKey').value.trim());$('loginError').textContent='';}catch(error){$('loginError').textContent=error.message;}});};
showTab();
const saved=sessionStorage.getItem(storage)||localStorage.getItem(storage);
if(saved)signIn(saved).catch(error=>{signOut();$('loginError').textContent=error.message;});
window.addEventListener('beforeunload',()=>clearTimeout(timer));
