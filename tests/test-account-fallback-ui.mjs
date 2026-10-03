import assert from 'node:assert/strict';
import { accountStatus, renderAccounts } from '../public/accounts.js';
import { state } from '../public/ui.js';
import { getRequestQuota, getLimitState } from '../utils/factory-limits.js';

const now=Date.now(), windowEnd=new Date(now+3600000).toISOString();
const windows=usedPercent=>Object.fromEntries(['fiveHour','weekly','monthly'].map(name=>[name,{usedPercent,windowEnd}]));
const key={id:'test',status:'active',last_test_result:'success',billing_limits:{fetchedAt:now,
  overagePreference:'extraUsage',limits:{standard:windows(100),core:windows(0)}}};
const refresh=()=>{
  key.routing=Object.fromEntries([['standard','claude-opus-5-5'],['core','kimi-k3']].map(([group,model])=>
    [group,{allowance:getRequestQuota(key,model,now)}]));
  return accountStatus(key,getLimitState(key,state.group,now))[0];
};
state.group='core';
assert.equal(refresh(),'Core fallback disabled');
const elements=Object.fromEntries(['accountSearch','accountSummary','algorithmLabel','accountRows'].map(id=>[id,{value:''}]));
globalThis.document={getElementById:id=>elements[id]};
state.keys=[key]; state.limits={test:{core:getLimitState(key,'core',now)}};
renderAccounts();
assert.match(elements.accountRows.innerHTML,/Core fallback disabled/);
assert.match(elements.accountRows.innerHTML,/Select Droid Core in Factory’s usage settings\./);
assert.doesNotMatch(elements.accountRows.innerHTML,/Factory usage limit reached/);
assert.match(elements.accountRows.innerHTML,/100% left/);
state.group='standard'; assert.equal(refresh(),'Limit / cooldown');
state.group='core';
key.billing_limits.overagePreference='droidCore'; assert.equal(refresh(),'Eligible');
key.billing_limits.limits.core=windows(100); assert.equal(refresh(),'Limit / cooldown');
key.billing_limits.overagePreference='none'; assert.equal(refresh(),'Core fallback disabled');
key.excluded=true; assert.equal(refresh(),'Excluded'); delete key.excluded;
key.cooldowns={standard:{until:now+60000,status:429}}; assert.equal(refresh(),'Limit / cooldown'); delete key.cooldowns;
key.billing_limits.overagePreference='unknown'; assert.notEqual(refresh(),'Core fallback disabled');
key.billing_limits.overagePreference='extraUsage';
key.billing_limits.extraUsageEnabled=true; assert.equal(refresh(),'Eligible');
key.billing_limits.extraUsageEnabled=false;
key.billing_limits.fetchedAt=now-120000; assert.notEqual(refresh(),'Core fallback disabled');
console.log('Account fallback UI checks passed');
