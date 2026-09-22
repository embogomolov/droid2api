import { limitGroup } from './factory-limits.js';

export const GROUPS = ['standard', 'core'];
const groupDefaults = modelId => ({ enabled: false, keyIds: [], modelId,
  workingHours: { enabled: false, start: '09:00', end: '18:00' } });
export const DEFAULT_WINDOW_SYNC = { version: 2, startTogether: false, stopBeforeResetSeconds: 30, groups: {
  standard: groupDefaults('gpt-5.6-luna'), core: groupDefaults('glm-5.3-flash')
} };

export function normalizeWindowSync(saved) {
  const cfg = structuredClone(DEFAULT_WINDOW_SYNC);
  if (!saved) return cfg;
  cfg.stopBeforeResetSeconds = saved.stopBeforeResetSeconds ?? 30;
  if(!validStopInterval(cfg.stopBeforeResetSeconds))throw new Error('Stop-before-reset interval must be a whole number from 0 to 17999 seconds');
  if (saved.version !== undefined && ![1, 2].includes(saved.version)) throw new Error('Unsupported window settings version');
  const groups = saved.groups || { [limitGroup(saved.modelId)]: saved };
  for (const group of GROUPS) if (groups[group]) cfg.groups[group] = {
    ...cfg.groups[group], ...groups[group], workingHours: { ...cfg.groups[group].workingHours, ...groups[group].workingHours }
  };
  for (const [group,v] of Object.entries(cfg.groups)) {
    if(typeof v.enabled!=='boolean'||!Array.isArray(v.keyIds)||v.keyIds.some(id=>typeof id!=='string')||new Set(v.keyIds).size!==v.keyIds.length||typeof v.modelId!=='string'||!validHours(v.workingHours))
      throw new Error(`Invalid saved ${group} window settings`);
  }
  if(saved.startTogether!==undefined&&typeof saved.startTogether!=='boolean')throw new Error('Invalid saved joint-start setting');
  // Legacy Core/joint starts cannot force which allowance Factory consumes.
  cfg.groups.core.enabled = false;
  cfg.startTogether = false;
  return cfg;
}

const validHours=h=>h&&typeof h.enabled==='boolean'&&[h.start,h.end].every(t=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t))&&(!h.enabled||h.start!==h.end);
const validStopInterval=value=>Number.isInteger(value)&&value>=0&&value<18000;
const minute = text => { const [h,m] = text.split(':').map(Number); return h*60+m; };
function allowed(hours, m) {
  if (!hours.enabled) return true;
  const a=minute(hours.start), b=minute(hours.end);
  return a<b ? m>=a&&m<b : m>=a||m<b;
}
export function withinWorkingHours(hours, now) {
  const date=new Date(now); return allowed(hours, date.getHours()*60+date.getMinutes());
}
export function nextWindowStart(cfg, group, at) {
  const groups=cfg.startTogether ? GROUPS.filter(g=>cfg.groups[g].enabled) : [group];
  const fits=time=>groups.every(g=>withinWorkingHours(cfg.groups[g].workingHours,time));
  if (fits(at)) return at;
  // At most two local days, including a DST transition. No timezone library or guessed offsets.
  for(let time=Math.floor(at/60000)*60000+60000;time<=at+49*3600000;time+=60000) if(fits(time)) return time;
  throw new Error('The selected working hours do not overlap');
}

export function validateWindowSync(value, keys, models) {
  const fail=message=>{throw Object.assign(new Error(message),{status:400});};
  if (!value || value.version!==2 || typeof value.startTogether!=='boolean' || !value.groups) fail('Reload the page: version 2 window settings are required');
  if(value.groups.core?.enabled || value.startTogether)fail('Factory controls Core fallback; independent or joint Core starts are not supported. Reload the page.');
  const cfg=structuredClone(DEFAULT_WINDOW_SYNC);
  cfg.stopBeforeResetSeconds=value.stopBeforeResetSeconds??30;
  if(!validStopInterval(cfg.stopBeforeResetSeconds))fail('Stop-before-reset interval must be a whole number from 0 to 17999 seconds');
  for (const group of GROUPS) {
    const v=value.groups[group];
    if(!v||typeof v.enabled!=='boolean')fail(`${group}: enabled must be a boolean`);
    if(!Array.isArray(v.keyIds)||v.keyIds.some(id=>typeof id!=='string'||(v.enabled&&!keys.some(k=>k.id===id))))fail(`${group}: select existing accounts`);
    if(new Set(v.keyIds).size!==v.keyIds.length)fail(`${group}: duplicate accounts`);
    if(v.enabled&&!v.keyIds.some(id=>!keys.find(k=>k.id===id).excluded))fail(`${group}: select at least one included account`);
    const model=models.find(m=>m.id===v.modelId);
    if(v.enabled&&(!model||!['anthropic','openai','common'].includes(model.type)||limitGroup(model.id)!==group))fail(`${group}: select a start model from this usage pool`);
    const h=v.workingHours;
    if(!validHours(h))fail(`${group}: invalid working hours`);
    cfg.groups[group]={enabled:v.enabled,keyIds:[...v.keyIds],modelId:typeof v.modelId==='string'?v.modelId:cfg.groups[group].modelId,workingHours:{enabled:h.enabled,start:h.start,end:h.end}};
  }
  // Disabling either pool must always remain possible, including emergency disable.
  cfg.startTogether=value.startTogether&&GROUPS.every(g=>cfg.groups[g].enabled);
  if(cfg.startTogether&&!Array.from({length:1440},(_,m)=>m).some(m=>GROUPS.every(g=>allowed(cfg.groups[g].workingHours,m))))fail('Standard and Droid Core working hours must overlap for a joint start');
  return cfg;
}
