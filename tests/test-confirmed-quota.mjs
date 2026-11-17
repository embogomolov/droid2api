// Run in the isolated network runner; no real credentials or upstream calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {KeyPoolManager} from '../auth.js';
import {getLimitState,getRequestQuota,recordQuotaRejection,classifyFactoryRejection,rejectionDiagnostic} from '../utils/factory-limits.js';
import {QuotaAware} from '../utils/quota-aware.js';
import {destroyPool} from '../utils/http-client.js';

const now=Date.now(), H=3600000;
const make=id=>({id,key:'fk-private-test-credential-'+id,notes:'Account '+id,status:'active',last_test_result:'success',
  billing_limits:{fetchedAt:now,overagePreference:'droidCore',limits:Object.fromEntries(['standard','core'].map(group=>[group,
    Object.fromEntries(['fiveHour','weekly','monthly'].map((name,i)=>[name,{usedPercent:group==='standard'?100:0,windowEnd:new Date(now+[1,24,48][i]*H).toISOString()}]))]))}});
const key=make('a'), model='claude-opus-5-5', core='kimi-k3.1-pro';
const monthlyBody=JSON.parse(fs.readFileSync(new URL('./fixtures/factory-monthly-standard-limit.json',import.meta.url)));
const monthly=make('monthly');
for(const body of [monthlyBody,monthlyBody.error])assert.deepEqual(classifyFactoryRejection(402,body,core),{kind:'quota',group:'standard',window:'monthly'},'The reported allowance takes precedence over the model');
for(const body of [{...monthlyBody.error,displayToUser:false},{...monthlyBody.error,status:400},{...monthlyBody.error,detail:'No active subscription'},
  {...monthlyBody.error,detail:'Documentation: '+monthlyBody.detail}])assert.equal(classifyFactoryRejection(402,body,model).kind,'rejected');
assert.equal(classifyFactoryRejection(400,monthlyBody,model).kind,'rejected');
recordQuotaRejection(monthly,402,null,model,monthlyBody,now);
assert.equal(monthly.cooldowns.standard.until,now+48*H,'Monthly refusal must not expire at the earlier five-hour or weekly reset');
assert.equal(monthly.cooldowns.standard.window,'monthly');
assert.equal(getRequestQuota(monthly,core,now+H).group,'core');
assert.equal(getRequestQuota(monthly,model,now+48*H).available,true);
const missingMonthly=make('missing-monthly');delete missingMonthly.billing_limits.limits.standard.monthly;
recordQuotaRejection(missingMonthly,402,null,model,monthlyBody,now);
assert.equal(missingMonthly.cooldowns.standard.until,now+60000,'A missing monthly reset cannot be replaced with another window');
const roundedMonthly=make('rounded-monthly');roundedMonthly.billing_limits.limits.standard.monthly.usedPercent=99;
recordQuotaRejection(roundedMonthly,402,'2',model,monthlyBody,now);
assert.equal(roundedMonthly.cooldowns.standard.until,now+48*H,'Explicit refusal identifies the window regardless of rounded percentages');
assert.equal(getLimitState(key,'standard',now).available,true);
assert.equal(getRequestQuota(key,core,now).group,'standard');
assert.equal(getRequestQuota(key,core,now).attributionKnown,false,'A 100% display cannot prove which allowance billed a Core model');
for(const body of [{reason:'billing_not_active'},{error:{message:'quota exceeded'}},{error:{code:'unrecognized'}}]){
  recordQuotaRejection(key,402,'60',model,body,now);
  assert.equal(getRequestQuota(key,model,now).available,true,'Unknown 402 is forwarded, not invented quota evidence');
}
recordQuotaRejection(key,429,'3',core,{error:{type:'rate_limit_error'}},now);
assert.equal(getRequestQuota(key,core,now).available,false);
assert.equal(getRequestQuota(key,model,now).available,true,'Rate limiting one model does not block a different model');
assert.equal(key.cooldowns,undefined);
assert.equal(getRequestQuota(key,core,now+3001).available,true);
const concurrent=make('parallel');
recordQuotaRejection(concurrent,429,'30',model,{error:{type:'rate_limit_error'}},now);
recordQuotaRejection(concurrent,429,'1',model,{error:{type:'rate_limit_error'}},now+1);
assert.equal(concurrent.model_cooldowns[model].until,now+30000,'A second rejection cannot shorten an outstanding Retry-After');
recordQuotaRejection(key,402,null,model,{error:{reason:'UserOverQuota',displayToUser:true,detail:'Quota reached'}},now);
assert.equal(key.cooldowns.standard.until,now+H,'Retry at the first possible reset, not the last');
assert.equal(getRequestQuota(key,model,now).available,false);
assert.equal(getRequestQuota(key,core,now+3001).group,'core');
assert.equal(getRequestQuota(key,core,now+3001).available,true);
assert.equal(getRequestQuota(key,core,now+H).group,'standard');
assert.equal(getRequestQuota(key,model,now+H).available,true);
assert.deepEqual(classifyFactoryRejection(429,{error:{code:'insufficient_quota'}},core),{kind:'quota',group:null});
recordQuotaRejection(key,429,'4',core,{error:{code:'insufficient_quota'}},now+3001);
assert.equal(key.cooldowns.core,undefined,'Ambiguous Core-model refusal cannot invent a billed pool');
assert.equal(getRequestQuota(key,'glm-5.3-flash',now+3001).available,true);
recordQuotaRejection(key,402,'7',core,{error:{reason:'UserOverQuota',pool:'core'}},now);
assert.equal(key.cooldowns.core.until,now+7000);
assert.equal(getRequestQuota(key,'glm-5.3-flash',now).available,false);
const unknownReset=make('unknown');delete unknownReset.billing_limits;
recordQuotaRejection(unknownReset,402,null,model,{reason:'UserOverQuota'},now);
assert.equal(unknownReset.cooldowns.standard.until,now+60000);
const legacy=make('legacy');legacy.cooldowns={standard:{status:429,until:now+H}};
assert.equal(getRequestQuota(legacy,core,now).group,'standard','Legacy cooldown is not proof of Core fallback');
const accounts=[make('one'),make('two'),make('three')], counts={one:0,two:0,three:0};
const balancer=new QuotaAware({keys:()=>accounts,now:()=>now});
for(let i=0;i<30;i++)counts[balancer.select(accounts,'standard').key.id]++;
assert.deepEqual(counts,{one:10,two:10,three:10},'All accounts at 100% remain routable and interleaved');
const diagnostic=rejectionDiagnostic(key,model,402,'30',{error:{detail:key.key+' Bearer other-secret '+ 'x'.repeat(9000)}});
assert.equal(diagnostic.accountId,'a');assert.equal(diagnostic.accountName,'Account a');assert.equal(diagnostic.keySuffix,key.key.slice(-9));
assert.equal(diagnostic.body.includes(key.key),false);assert.equal(diagnostic.body.includes('other-secret'),false);
assert.equal(diagnostic.body.length,8192);assert.equal(diagnostic.bodyTruncated,true);
assert.equal(rejectionDiagnostic({id:'short',key:'secret'},model,402,null,'secret').keySuffix,null);

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quota-state-'));
try {
  const manager=Object.create(KeyPoolManager.prototype);
  Object.assign(manager,{keyPoolPath:path.join(directory,'keys.json'),keys:[key,monthly],stats:{},poolGroups:[],config:{}});
  await manager.saveKeyPoolImmediately();
  const restored=Object.create(KeyPoolManager.prototype);restored.keyPoolPath=manager.keyPoolPath;restored.loadKeyPool();
  assert.deepEqual(restored.keys[0].cooldowns,key.cooldowns);
  assert.deepEqual(restored.keys[0].model_cooldowns,key.model_cooldowns);
  assert.equal(getRequestQuota(restored.keys[0],model,now).available,false);
  assert.equal(getRequestQuota(restored.keys[0],model,now+H).available,true);
  assert.deepEqual(restored.keys[1].cooldowns,monthly.cooldowns);
  assert.equal(getRequestQuota(restored.keys[1],core,now+H).group,'core');
  key.key='replacement';
  await manager.recordUpstreamFailure(key.id,401,null,model,{},'old-credential');
  assert.equal(key.status,'active','Late failure must not disable a replacement credential');
  console.log('PASS: percentages, real quota markers, rate limits, unknown errors, pool scope, reset, balanced zero headroom, redaction and saved rejection recovery');
} finally {destroyPool();fs.rmSync(directory,{recursive:true,force:true});}
