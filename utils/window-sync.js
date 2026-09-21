import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { fetchBillingLimits, limitGroup, retryAfterTime, WINDOWS, getLimitState } from './factory-limits.js';
import { getEndpointByType } from '../config.js';
import { prepareDirectAnthropic, getAnthropicHeaders } from '../transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from '../transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from '../transformers/request-common.js';
import fetchWithPool from './http-client.js';
import { logInfo, logWarn } from '../logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { GROUPS, normalizeWindowSync, nextWindowStart, withinWorkingHours } from './window-settings.js';
export { DEFAULT_WINDOW_SYNC, validateWindowSync, withinWorkingHours } from './window-settings.js';
const freshGroup = () => ({ phase: 'waiting', members: {}, nextCheckAt: 0 });
const freshState = () => ({ version: 2, groups: Object.fromEntries(GROUPS.map(g => [g, freshGroup()])) });
const backoff = attempt => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
const identity = key => createHash('sha256').update(key.key).digest('hex');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// One short physical request; the scheduler owns retries and verifies the window first.
export async function sendWindowStart(key, model, signal, fetchImpl = fetchWithPool) {
  const request = { model: model.id, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 32, stream: false };
  const auth = `Bearer ${key.key}`;
  let body, headers;
  if (model.type === 'anthropic') {
    body = prepareDirectAnthropic(request); delete body.thinking;
    headers = getAnthropicHeaders(auth, {}, false, model.id);
  } else if (model.type === 'openai') {
    body = transformToOpenAI(request); body.reasoning = { effort: model.id==='gpt-5.6-luna'?'none':'low' };
    headers = getOpenAIHeaders(auth);
  } else {
    body = transformToCommon(request);
    headers = getCommonHeaders(auth, {}, model.api_provider);
  }
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 15_000);
  let response;
  try {
    response = await fetchImpl(getEndpointByType(model.type).base_url, { method: 'POST', headers, body: JSON.stringify(body), retry: false,
      signal: AbortSignal.any([signal, timeout.signal]), redirect: 'error' });
    const retryAt = retryAfterTime(response.headers.get('retry-after'));
    if (!response.ok) { response.body?.destroy(); return { accepted: false, status: response.status, retryAt, error: `HTTP ${response.status}` }; }
    const data = await response.json();
    if (!data.id || data.error || data.status === 'failed') return { accepted: false, error: 'No successful generation confirmed', ambiguous: true };
    return { accepted: true, status: response.status, responseId: data.id, usage: data.usage };
  } catch (error) {
    return { accepted: false, ambiguous: true, error: timeout.signal.aborted ? 'Probe timed out; checking the window before retry' : error.code || error.name };
  } finally { clearTimeout(timer); response?.body?.destroy(); }
}

export class WindowSync {
  constructor({ manager, directory = path.join(root, 'data'), readConfig = () => JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8')), refresh = fetchBillingLimits, send = sendWindowStart, now = Date.now } = {}) {
    this.manager = manager; this.directory = directory; this.readConfig = readConfig; this.refresh = refresh; this.send = send; this.now = now;
    this.file = path.join(directory, 'window_sync.json'); this.lock = path.join(directory, 'window_sync.lock');
  }
  settings() { return normalizeWindowSync(this.readConfig().window_sync); }
  load() {
    if (!fs.existsSync(this.file)) return freshState();
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (saved.version === 1 && saved.members && !Array.isArray(saved.members) && typeof saved.members === 'object' && ['waiting','starting','active'].includes(saved.phase)) {
      const state = freshState(), group = limitGroup(saved.modelId || this.readConfig().window_sync?.modelId);
      state.groups[group] = { ...saved, cycleKeyIds: Object.keys(saved.members), partners: [group] };
      delete state.groups[group].version;
      return state;
    }
    if (saved.version !== 2 || !GROUPS.every(g => saved.groups?.[g]?.members && typeof saved.groups[g].members==='object' && !Array.isArray(saved.groups[g].members) && ['waiting','starting','active'].includes(saved.groups[g].phase) && (saved.groups[g].phase!=='starting'||Array.isArray(saved.groups[g].cycleKeyIds))))
      throw new Error('Invalid saved window-sync state; refusing to discard previous attempts');
    return saved;
  }
  save(state) {
    try {
      if (this.journalFailure) throw this.journalFailure;
      if (this.lockToken && !this.ownsLock()) throw new Error('Window-sync ownership changed; stopping this attempt');
      state.updatedAt = this.now();
      if (this.lockToken) { const stamp = new Date(); fs.utimesSync(this.lock, stamp, stamp); }
      const temporary = `${this.file}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(state, null, 2)); fs.renameSync(temporary, this.file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    } catch(error) { this.journalFailure = error; throw error; }
  }
  manages(key, model = this.readConfig().key_test_model || 'claude-sonnet-4-5-20250929') {
    const cfg = this.settings().groups[limitGroup(model)];
    return cfg.enabled && !key.excluded && cfg.keyIds.includes(key.id);
  }
  nextStartTime(at, group = 'standard') {
    const cfg=this.settings();
    for (const g of GROUPS) if (!this.participates(cfg,g)) cfg.groups[g].enabled=false;
    return nextWindowStart(cfg, group, at);
  }
  selected(cfg, group) {
    return cfg.groups[group].keyIds.map(id=>this.manager.keys.find(k=>k.id===id)).filter(k=>k&&!k.excluded);
  }
  participates(cfg, group) {
    return cfg.groups[group].enabled && (this.selected(cfg,group).length>0 || cfg.groups[group].keyIds.some(id=>!this.manager.keys.some(k=>k.id===id)));
  }
  peers(state, cfg, group) {
    const s=state.groups[group];
    return (s.partners || [group]).filter(g=>this.participates(cfg,g)&&state.groups[g].cycleId===s.cycleId);
  }
  routingBlock(key, model) {
    const group=limitGroup(model), managed=this.manages(key,model);
    let state;try{state=this.load();}catch(error){if(managed)throw error;return null;}
    const pending=this.manualPending(state,group,key.id);
    if(pending?.credential===identity(key))return 'Manual request is being verified';
    if(!managed)return null;
    const cfg=this.settings(), s=state.groups[group];
    if (this.peers(state,cfg,group).some(g=>state.groups[g].phase==='starting')) return 'Waiting for all participants of the current start';
    const member=s.members[key.id];
    const trusted=member?.credential===identity(key);
    const end=Math.max(Date.parse(key.billing_limits?.limits?.[group]?.fiveHour?.windowEnd)||0,
      trusted ? member.confirmedEnd||0 : 0);
    if(end>this.now())return null;
    if(s.cycleId&&!s.cycleKeyIds?.includes(key.id))return 'Joins the next synchronized start';
    return 'Waiting for the selected group to start its next five-hour windows';
  }
  // Manual intents share the scheduler journal and lock; no second dispatcher.
  manualPending(state, group, id) {
    const m=state.manual?.[group]?.[id];
    return m&&['queued','starting'].includes(m.phase)?m:null;
  }
  accountAction(key, group, state=this.load()) {
    const cfg=this.settings().groups[group], model=this.readConfig().models.find(m=>m.id===cfg.modelId);
    const pending=this.manualPending(state,group,key.id), limits=getLimitState(key,group,this.now());
    const active=Date.parse(limits.windows?.fiveHour?.windowEnd)>this.now();
    const kind=active?'test':'start';
    let reason='';
    if(pending&&pending.credential===identity(key))return {kind:pending.kind,label:pending.kind==='test'?'Testing…':'Starting…',disabled:true,reason:pending.error||'Checking the window',modelId:pending.modelId};
    if(key.excluded)reason='Enable usage first';
    else if(key.status!=='active')reason='Account is disabled';
    else if(!model||!['anthropic','openai','common'].includes(model.type)||limitGroup(model.id)!==group)reason='Choose a start model in Five-hour windows';
    else if(!limits.known||limits.stale||key.limits_error)reason='Refresh limits before sending a request';
    else if(!limits.available)reason=limits.reason;
    else if(!active&&limits.windows.fiveHour.usedPercent!==0)reason='Factory has not reported the window reset';
    else if(this.peers(state,this.settings(),group).some(g=>state.groups[g].phase==='starting'))reason='An automatic start is already in progress';
    else if(kind==='test'&&this.manages(key,model.id))reason='Automatic starts manage this pool';
    const previous=state.manual?.[group]?.[key.id];
    return {kind,label:kind==='start'?'Start now':'Test',disabled:!!reason,reason:reason||`Uses ${model.name||model.id} in ${group==='core'?'Droid Core':'Standard'}`,modelId:model?.id,
      error:previous?.credential===identity(key)&&previous.phase==='failed'?previous.error:null};
  }
  requestAction(id, group, kind) {
    const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
    if(!GROUPS.includes(group)||!['start','test'].includes(kind))fail('Choose a usage pool and action',400);
    const key=this.manager.keys.find(k=>k.id===id);if(!key)fail('Account not found',404);
    const owned=!!this.activeState&&this.ownsLock();
    if(!owned&&!this.acquire())fail('The scheduler is busy; refresh and retry');
    if(!owned)this.journalFailure=null;
    try {
      const state=owned?this.activeState:this.load(), pending=this.manualPending(state,group,id);
      if(pending&&pending.credential===identity(key))return {pending:true,message:'Already queued; no duplicate request sent'};
      const action=this.accountAction(key,group,state);
      if(action.disabled)fail(action.reason);
      if(action.kind!==kind)fail('The window changed. Refresh the account before proceeding.');
      state.manual ||= {};state.manual[group] ||= {};
      state.manual[group][id]={kind,phase:'queued',modelId:action.modelId,credential:identity(key),requestedAt:this.now(),nextAttemptAt:0,attempts:0};
      state.groups[group].nextCheckAt=0;this.save(state);
      this.wake();return {pending:true,message:kind==='start'?'Start queued':'Test queued'};
    }finally{if(!owned){if(this.ownsLock())fs.unlinkSync(this.lock);this.lockToken=null;}}
  }
  async runManual(state,signal) {
    const pending=GROUPS.flatMap(group=>Object.entries(state.manual?.[group]||{}).filter(([,m])=>['queued','starting'].includes(m.phase)).map(([id,m])=>({group,id,m})));
    const results=await Promise.allSettled(pending.map(async({group,id,m})=>{
      if(m.nextAttemptAt>this.now()||signal.aborted||this.journalFailure)return;
      const key=this.manager.keys.find(k=>k.id===id), model=this.readConfig().models.find(v=>v.id===m.modelId);
      const valid=()=>key&&this.manager.keys.includes(key)&&!key.excluded&&key.status==='active'&&identity(key)===m.credential;
      const fail=message=>{m.phase='failed';m.error=message;this.save(state);};
      if(!valid())return fail('Account removed, disabled or changed');
      if(!model||!['anthropic','openai','common'].includes(model.type)||limitGroup(model.id)!==group)return fail('Start model is no longer available');
      if(m.kind==='test'&&this.manages(key,model.id))return fail('Automatic starts now manage this pool');
      try {
        const snapshot=await this.refresh(key.key,{signal});
        if(!valid()||signal.aborted)return;
        const limits=getLimitState({billing_limits:snapshot,cooldowns:key.cooldowns},group,this.now());
        if(!limits.known||limits.stale||!WINDOWS.every(n=>Number.isFinite(limits.windows[n].usedPercent)&&limits.windows[n].usedPercent>=0))throw new Error('Incomplete or stale quota data');
        if(!key.billing_limits||snapshot.fetchedAt>=key.billing_limits.fetchedAt){key.billing_limits=snapshot;delete key.limits_error;this.manager.observeBillingLimits?.(key);}
        const end=Date.parse(limits.windows.fiveHour.windowEnd);
        if(m.kind==='start'&&end>this.now()) {
          m.phase='done';m.confirmedEnd=end;m.error=null;state.groups[group].nextCheckAt=0;
          await this.manager.saveKeyPoolImmediately?.();this.save(state);return;
        }
        if(m.acceptedAt) {
          if(this.now()-m.acceptedAt>=5*3600000)return fail('Accepted request could not be confirmed before its window expired; refresh and start again');
          m.nextAttemptAt=this.now()+2000;this.save(state);return;
        }
        if(!limits.available)return fail(limits.reason);
        if(m.kind==='test'&&m.submittedAt)return fail('Previous test outcome is unknown; it was not replayed');
        if(m.kind==='test'&&!(end>this.now()))return fail('Window ended; use Start now');
        if(m.kind==='start'&&limits.windows.fiveHour.usedPercent!==0)return fail('Factory has not reported the window reset');
        // Persist before the physical send; a crash resumes with telemetry, not a blind replay.
        m.phase='starting';m.attempts++;m.submittedAt=this.now();m.nextAttemptAt=this.now()+30000;this.save(state);
        const result=await this.send({...key},model,signal);
        if(!valid())return fail('Account removed, disabled or changed after dispatch');
        m.error=result.error||null;m.httpStatus=result.status||null;
        if(result.accepted) {
          m.acceptedAt=this.now();m.responseId=result.responseId;m.phase=m.kind==='test'?'done':'starting';m.nextAttemptAt=this.now()+2000;
          key.last_test_result='success';key.last_test_at=new Date(this.now()).toISOString();key.last_error=null;
          await this.manager.saveKeyPoolImmediately?.();
        } else if(m.kind==='test'||(result.status>=400&&result.status<500&&![408,429].includes(result.status)))return fail(result.error||'Request failed');
        else m.nextAttemptAt=Math.max(this.now()+30000,result.retryAt||0);
        this.save(state);
      }catch(error){
        if(this.journalFailure)throw error;
        if(m.kind==='test'&&m.submittedAt&&!m.acceptedAt)return fail('Test outcome is unknown; refresh before retrying');
        m.error=error.message;m.nextAttemptAt=Math.max(this.now()+30000,error.retryAt||0);this.save(state);
      }
    }));
    const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  }
  snapshot() {
    const settings=this.settings();
    return { settings, state:this.load(), running:Boolean(this.timer||this.running), error:this.error||null,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      keys:this.manager.keys.map(key=>({id:key.id,status:key.status,excluded:key.excluded===true,tested:key.last_test_result==='success',testManaged:this.manages(key)})),
      models:this.readConfig().models.filter(m=>['anthropic','openai','common'].includes(m.type)).map(m=>({id:m.id,name:m.name||m.id,group:limitGroup(m.id)})) };
  }
  ownsLock() {
    try { return JSON.parse(fs.readFileSync(this.lock, 'utf8')).token === this.lockToken; }
    catch { return false; }
  }
  acquire() {
    fs.mkdirSync(this.directory, { recursive: true });
    const token = randomUUID();
    try {
      const fd = fs.openSync(this.lock, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      this.lockToken = token; return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(this.lock);
        let owner; try { owner = JSON.parse(fs.readFileSync(this.lock, 'utf8')); } catch {}
        let dead = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        }
        // Each network phase is bounded below this lease. Expiry also recovers a reused PID after reboot.
        if (dead || Date.now() - stat.mtimeMs > 120_000) {
          fs.unlinkSync(this.lock); return this.acquire();
        }
      } catch (e) { if (e.code === 'ENOENT') return this.acquire(); throw e; }
      return false;
    }
  }
  start() { this.stopped = false; this.wake(); }
  wake() {
    clearTimeout(this.timer);
    if (this.stopped || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick().then(() => { this.failures = 0; }).catch(error => { this.failures = (this.failures || 0) + 1; this.error = error.message; logWarn(`Window sync: ${error.message}`); }).finally(() => {
        this.running = null;
        if (!this.stopped) this.timer = setTimeout(() => this.wake(), this.failures ? backoff(this.failures) : 1000);
      });
    }, 0);
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; this.controller?.abort(); await this.running; }
  async tick() {
    if (!this.acquire()) return;
    this.controller = new AbortController(); this.journalFailure = null;
    try { this.activeState=this.load();
      if(GROUPS.some(g=>this.settings().groups[g].enabled||Object.keys(this.activeState.manual?.[g]||{}).some(id=>this.manualPending(this.activeState,g,id))))await this.run(this.controller.signal); this.error = null; }
    finally { this.activeState=null;this.controller = null; if (this.ownsLock()) fs.unlinkSync(this.lock); this.lockToken = null; }
  }
  async prepare(group, state, signal, reads) {
    const cfg=this.settings().groups[group], s=state.groups[group], now=this.now();
    const keys=this.selected(this.settings(),group);
    // Pin the selected credential, not just its editable row ID.
    for(const key of keys) {
      const credential=identity(key), old=s.members[key.id];
      if(old?.credential && old.credential!==credential) {
        s.members[key.id]={credential};
        if(s.phase==='starting')s.cycleKeyIds=s.cycleKeyIds.filter(id=>id!==key.id);
      } else (s.members[key.id] ||= {}).credential=credential;
    }
    const participants=s.phase==='starting'?keys.filter(k=>s.cycleKeyIds.includes(k.id)):keys;
    if(s.phase==='active')s.phase='waiting';
    const model=this.readConfig().models.find(m=>m.id===cfg.modelId);
    const ctx={group,cfg,s,keys:participants,model,ready:false,valid:false};
    s.nextCheckAt=now+30000;
    if(!model || limitGroup(model.id)!==group || !['anthropic','openai','common'].includes(model.type)) {
      s.message='Configured start model is missing or belongs to another pool';return ctx;
    }
    if(cfg.keyIds.some(id=>!this.manager.keys.some(k=>k.id===id))) {s.message='Selected account was removed; update the selection';return ctx;}
    ctx.valid=true;
    await Promise.all(participants.map(async key=>{
      const m=s.members[key.id], secret=key.key;
      if(m.refreshAfter>now)return;
      try {
        // One fetch per credential in this pass, even when it participates in both pools.
        if(!reads.has(secret))reads.set(secret,this.refresh(secret,{signal}));
        const snapshot=await reads.get(secret);
        if(key.key!==secret || !this.manager.keys.includes(key))throw new Error('Account changed; checking the new selection');
        const windows=snapshot.limits?.[group];
        if(!Number.isFinite(snapshot.fetchedAt)||snapshot.fetchedAt<now-60000||!WINDOWS.every(n=>Number.isFinite(windows?.[n]?.usedPercent)&&windows[n].usedPercent>=0))throw new Error('Incomplete '+group+' usage windows');
        const end=Date.parse(windows.fiveHour.windowEnd);
        Object.assign(m,{observedAt:this.now(),windowEnd:windows.fiveHour.windowEnd,usedPercent:windows.fiveHour.usedPercent,
          ready:(Number.isFinite(end)&&end<=this.now())||(!windows.fiveHour.windowEnd&&windows.fiveHour.usedPercent===0),
          quotaReady:['weekly','monthly'].every(n=>windows[n].usedPercent<100||Date.parse(windows[n].windowEnd)<=this.now())&&(key.cooldowns?.[group]?.until||0)<=this.now(),
          refreshError:null,refreshFailures:0,refreshAfter:0});
        if(!key.billing_limits || snapshot.fetchedAt>=key.billing_limits.fetchedAt) {
          key.billing_limits=snapshot;delete key.limits_error;this.manager.observeBillingLimits?.(key);
        }
        const previousEnd=m.confirmedEnd;
        // Fresh telemetry supersedes a migrated or previously confirmed window.
        if(s.phase==='starting')m.confirmedEnd=m.attempts&&end>this.now()&&end!==m.baselineEnd?end:null;
        // An expired participant must be able to rejoin a partially started cycle.
        if(s.phase==='starting'&&m.ready&&((previousEnd&&previousEnd<=this.now())||(m.acceptedAt&&m.acceptedAt+5*3600000<=this.now())))
          Object.assign(m,{acceptedAt:null,confirmedEnd:null,baselineEnd:end||null,nextAttemptAt:0});
      }catch(error){m.refreshError=error.message;m.ready=false;m.refreshAfter=Math.max(this.now()+backoff(m.refreshFailures=(m.refreshFailures||0)+1),error.retryAt||0);}
    }));
    ctx.ready=participants.length>0&&participants.every(k=>{const m=s.members[k.id];return k.status==='active'&&k.last_test_result==='success'&&m.ready&&m.quotaReady&&!m.refreshError&&m.observedAt>=now;});
    s.message=participants.some(k=>k.status!=='active'||k.last_test_result!=='success')?'Selected accounts must be enabled and tested':'Waiting for current windows and available quota';
    s.nextCheckAt=Math.min(this.now()+(s.phase==='starting'?2000:30000),...participants.map(k=>Date.parse(s.members[k.id].windowEnd)).filter(end=>end>this.now()));
    return ctx;
  }
  async run(signal) {
    const state=this.activeState||this.load();
    await this.runManual(state,signal);
    const cfg=this.settings(), reads=new Map(), batches=[], taken=new Set();
    for(const group of GROUPS) {
      const s=state.groups[group];
      const signature=JSON.stringify([cfg,this.manager.keys.map(k=>[k.id,k.excluded,k.status,k.last_test_result,identity(k)])]);
      if(s.selection!==signature){s.selection=signature;s.nextCheckAt=0;}
      if(Object.entries(state.manual?.[group]||{}).some(([id])=>this.manualPending(state,group,id)))continue;
      if(!this.participates(cfg,group)){s.message=cfg.groups[group].enabled?'No included accounts':'Automatic starts are off';continue;}
      if(s.phase==='starting'&&!taken.has(group)) {
        const peers=this.peers(state,cfg,group);batches.push(peers);peers.forEach(g=>taken.add(g));
      }
    }
    const manualGroups=GROUPS.filter(g=>Object.entries(state.manual?.[g]||{}).some(([id])=>this.manualPending(state,g,id)));
    const remaining=GROUPS.filter(g=>this.participates(cfg,g)&&!taken.has(g)&&!manualGroups.includes(g));
    if(cfg.startTogether&&manualGroups.length)remaining.length=0;
    if(cfg.startTogether&&taken.size===0&&remaining.length>1)batches.push(remaining);
    else if(!cfg.startTogether||taken.size===0)for(const g of remaining)batches.push([g]);
    // Drain every started operation before releasing the shared journal lock, even on disk errors.
    const results=await Promise.allSettled(batches.map(async groups=>{
      if(groups.every(g=>state.groups[g].nextCheckAt>this.now()))return;
      const prepared=await Promise.allSettled(groups.map(g=>this.prepare(g,state,signal,reads)));
      const preparationFailure=prepared.find(r=>r.status==='rejected');
      if(preparationFailure)throw preparationFailure.reason;
      const contexts=prepared.map(r=>r.value);
      const latest=this.settings();
      if(signal.aborted || !groups.every(g=>latest.groups[g].enabled&&equal(latest.groups[g],cfg.groups[g]))) {this.save(state);return;}
      if(contexts.some(c=>!c.valid)){this.save(state);return;}
      const starting=contexts.some(c=>c.s.phase==='starting');
      if(!starting) {
        if(groups.some(g=>Object.entries(state.manual?.[g]||{}).some(([id])=>this.manualPending(state,g,id))))return;
        if(latest.startTogether!==cfg.startTogether || !contexts.every(c=>c.ready)) {this.save(state);return;}
        if(!groups.every(g=>withinWorkingHours(latest.groups[g].workingHours,this.now()))) {
          contexts.forEach(c=>c.s.message='Waiting for configured working hours');this.save(state);return;
        }
        const cycleId=randomUUID();
        for(const c of contexts){Object.assign(c.s,{phase:'starting',cycleId,partners:groups,cycleKeyIds:c.keys.map(k=>k.id),modelId:c.cfg.modelId});
          for(const key of c.keys){const m=c.s.members[key.id];Object.assign(m,{baselineEnd:Date.parse(m.windowEnd)||null,attempts:0,submittedAt:null,acceptedAt:null,confirmedEnd:null,nextAttemptAt:0,error:null});}}
        this.save(state);
      }
      const hadDispatch=()=>contexts.some(c=>c.s.cycleKeyIds.some(id=>c.s.members[id]?.submittedAt));
      const sends=await Promise.allSettled(contexts.flatMap(c=>c.keys.map(async key=>{
        const m=c.s.members[key.id], current=this.now(), fresh=this.settings();
        if(this.journalFailure||signal.aborted||!this.ownsLock())return;
        if(!fresh.groups[c.group].enabled||!fresh.groups[c.group].keyIds.includes(key.id)||key.excluded||!this.manager.keys.includes(key)||key.status!=='active'||key.last_test_result!=='success'||identity(key)!==m.credential)return;
        if(!hadDispatch()&&!groups.every(g=>withinWorkingHours(fresh.groups[g].workingHours,current)))return;
        if(fresh.groups[c.group].modelId!==c.cfg.modelId||m.confirmedEnd>current||m.acceptedAt||m.refreshError||m.observedAt<this.now()-60000||!m.quotaReady||!m.ready||m.nextAttemptAt>current)return;
        m.attempts++;m.submittedAt=current;m.nextAttemptAt=current+30000;m.error='Request sent; awaiting confirmation';this.save(state);
        let result;try{result=await this.send({...key},c.model,signal);}catch(error){result={ambiguous:true,error:error.code||error.name};}
        if(identity(key)!==m.credential || c.s.members[key.id]!==m)return;
        m.error=result.error||null;m.httpStatus=result.status||null;
        if(result.accepted){m.acceptedAt=this.now();m.responseId=result.responseId;}
        else m.nextAttemptAt=Math.max(this.now()+(result.ambiguous?30000:backoff(m.attempts)),result.retryAt||0);
        this.save(state);
        logInfo(`Window sync ${c.group} ${c.s.cycleId}: ${key.id} ${result.accepted?'accepted; verifying window':'retry pending'}`);
      })));
      const failure=sends.find(r=>r.status==='rejected');if(failure)throw failure.reason;
      const activeContexts=contexts.filter(c=>this.participates(this.settings(),c.group));
      const participants=c=>c.keys.filter(k=>this.manages(k,c.cfg.modelId)&&this.manager.keys.includes(k));
      const complete=activeContexts.every(c=>!this.settings().groups[c.group].keyIds.some(id=>!this.manager.keys.some(k=>k.id===id))&&participants(c).every(k=>k.status==='active'&&k.last_test_result==='success'&&c.s.members[k.id]?.credential===identity(k)&&c.s.members[k.id]?.confirmedEnd>this.now()));
      for(const c of activeContexts) {
        if(complete){const ends=participants(c).map(k=>c.s.members[k.id].confirmedEnd);Object.assign(c.s,{phase:'active',completedAt:this.now(),message:'All selected windows confirmed',spreadMs:ends.length?Math.max(...ends)-Math.min(...ends):0,nextCheckAt:ends.length?Math.min(...ends):this.now()+30000});}
        else {c.s.message='Verifying the current start; accepted requests are not replayed';c.s.nextCheckAt=this.now()+2000;}
      }
      this.save(state);
    }));
    const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
    this.save(state);
  }

}

export function getWindowSync(manager) { return manager.windowSync ||= new WindowSync({ manager }); }
