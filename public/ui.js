export const $ = id => document.getElementById(id);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const suffix = id => state.keys.find(key => key.id === id)?.keySuffix || 'Unavailable key';
export const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
export const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value) : '—';
export const state = {keys:[], limits:{}, sync:null, config:{}, pools:[], group:'standard', tab:'accounts'};
let credential = '', noticeTimer, editorSubmit;
export function setCredential(value) { credential = value; }
export async function api(path, method='GET', body, timeout=15000) {
  let response;
  try { response = await fetch('/admin' + path, {method,headers:{'x-admin-key':credential,'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(timeout),cache:'no-store'}); }
  catch(error) { throw new Error(method === 'GET' ? 'Proxy did not respond. Check the server and refresh.' : 'No response to this action. Reload its saved state before retrying.'); }
  if (response.status === 401) { document.dispatchEvent(new Event('auth-expired')); throw new Error('Admin session rejected. Sign in again.'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('Unexpected server response (HTTP ' + response.status + ').'); }
  if (!response.ok || result.success === false) throw new Error(result.message || result.error?.message || (typeof result.error === 'string' && result.error) || ('HTTP ' + response.status));
  return result.data ?? result;
}
export function notify(message, error=false) {
  clearTimeout(noticeTimer); $('notice').hidden=false; $('notice').classList.toggle('error',error); $('notice').querySelector('span').textContent=message;
  if (!error) noticeTimer=setTimeout(() => $('notice').hidden=true,6500);
}
export async function action(button, run) {
  if (button?.disabled) return;
  if (button) button.disabled=true;
  try { await run(); } catch(error) { notify(error.message,true); } finally { if(button) button.disabled=false; }
}
export function dialog(title, fields, submit, label='Save') {
  $('editorTitle').textContent=title; $('editorFields').innerHTML=fields; $('editorError').hidden=true;
  $('editorSave').textContent=label; editorSubmit=submit; $('editor').showModal();
}
export function confirmAction(title, text, run) { dialog(title, '<p>' + escape(text) + '</p>', run, 'Confirm'); }
export function wireUI() {
  $('notice').querySelector('button').onclick=() => $('notice').hidden=true;
  document.querySelectorAll('[data-close]').forEach(button => button.onclick=() => $('editor').close());
  $('editor').addEventListener('close', () => { if (!$('editor').open) { $('editorFields').replaceChildren(); editorSubmit=null; } });
  $('editorForm').onsubmit=async event => {
    event.preventDefault(); const button=$('editorSave'); if(button.disabled)return; button.disabled=true;
    try { await editorSubmit(new FormData(event.currentTarget)); $('editor').close(); }
    catch(error) { $('editorError').textContent=error.message; $('editorError').hidden=false; }
    finally {button.disabled=false;}
  };
}
export const algorithms = {
 'max-remaining':['Max remaining','Chooses the most headroom across 5-hour, weekly and monthly limits.'],
 'round-robin':['Round robin','Rotates eligible accounts in sequence. Request costs can differ.'],
 'random':['Random','Chooses a random eligible account.'],
 'least-used':['Fewest requests','Chooses by request count, not quota consumed.'],
 'weighted-score':['Weighted score','Uses the server score and usage history.'],
 'least-token-used':['Fewest tokens','Uses recorded token consumption.'],
 'quota-aware':['Quota aware','Spreads work using remaining quota and reset times immediately. Reliable completed-request intervals refine each account and window independently.'],
 'time-window':['Time window','Uses recent usage within the configured time window.']
};
