import {$,api,escape as e,suffix,date,number} from './ui.js';
let entries=[];
const redact=value=>String(value??'').replace(/fk-[\w-]+/g,'[key hidden]').replace(/Bearer\s+[^\s"'\\]+/gi,'Bearer [hidden]');
export function renderRequests(){
  const query=$('logSearch').value.toLowerCase(), errors=$('errorsOnly').checked;
  const filtered=entries.filter(row=>(!errors||row.level==='error'||row.level==='warn')&&JSON.stringify(row).toLowerCase().includes(query));
  $('logCount').textContent=filtered.length+' events · latest 500 server entries';
  $('requestRows').innerHTML=filtered.slice().reverse().map(row=>{
    const data=row.summary||{}, model=data.model||row.url||row.message||'Event';
    const outcome=data.outcome||(row.statusCode?'HTTP '+row.statusCode:row.level||'Received');
    const duration=Number.isFinite(data.elapsedMs)?(data.elapsedMs/1000).toFixed(1)+'s':row.duration||'—';
    const usage=data.usage;
    const tokens=usage?'In '+number(usage.input)+' · out '+number(usage.output)+' · cache read '+number(usage.cacheRead)+(Number.isFinite(usage.cacheWrite)?' · write '+number(usage.cacheWrite):''):'No usage reported';
    const upstream=data.upstreamError;
    const detail=redact(upstream ? [upstream.code||upstream.type,upstream.message].filter(Boolean).join(': ') : data.error||row.error?.message||row.message||'');
    return '<tr><td data-label="Time" class="muted">'+e(date(row.timestamp))+'</td><td data-label="Model / endpoint" class="request-details">'+e(redact(model))+'</td><td data-label="Account">'+(data.keyId?e(suffix(data.keyId)):'—')+'</td><td data-label="Result"><span class="badge '+(row.level==='error'?'bad':row.level==='warn'?'warn':'')+'">'+e(outcome)+'</span></td><td data-label="Duration">'+e(duration)+'</td><td data-label="Tokens / details" class="request-details"><small>'+e(tokens)+'</small>'+(detail?'<details><summary>Details</summary><pre>'+e(detail)+'</pre></details>':'')+'</td></tr>';
  }).join('')||'<tr><td colspan="6" class="empty">No matching events in the server buffer.</td></tr>';
}
export async function refreshRequests(){
  try{
    const result=await api('/logs/history?limit=500');
    entries=(result.logs||[]).filter(row=>row.type==='generation'||(!row.url&&['warn','error'].includes(row.level))||(row.url?.startsWith('/v1/')&&row.type==='response'));
    $('requestsError').hidden=true;renderRequests();
  }catch(error){$('requestsError').hidden=false;$('requestsError').textContent=error.message;}
}
export function initRequests(){ $('logSearch').oninput=renderRequests;$('errorsOnly').onchange=renderRequests;$('refreshRequests').onclick=refreshRequests; }
