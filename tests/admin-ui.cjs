// Run with playwright-skill/run.js (Playwright supplied by the installed skill).
// All admin requests are intercepted; only static UI files reach TARGET_URL.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const fs=require('node:fs');
const {once}=require('node:events');
(async()=>{
 const root=path.resolve(process.env.DROID_UI_ROOT||path.join(__dirname,'../public'));
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const TARGET_URL='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:false});
 const page=await browser.newPage({viewport:{width:1360,height:900}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const ids=['account_acct00001','account_acct00002','account_acct00003','account_acct00004'];
 let keys=ids.map((id,i)=>({id,key:'fk-never-render-me-tail0000'+i,notes:i===0?'Reserved':i===3?'New account':'Work '+i,poolGroup:'default',status:'active',excluded:i===0,last_test_result:i===3?'untested':'success',routing:{standard:{blocked:null},core:{blocked:null}},usage_count:12,last_used_at:Date.now()}));
 const config={port:3000,models:[{id:'claude-haiku-4-5-20251001',name:'Claude Haiku 4.5',type:'anthropic'}],key_pool:{algorithm:'max-remaining',retry:{enabled:true}},system_prompt:'Leave unchanged',endpoint:[{name:'anthropic',base_url:'https://api.factory.ai/api/llm/a/v1/messages'}],redis:{enabled:false}};
 let syncMembers={};
 const settings={enabled:true,keyIds:ids.slice(1,3),modelId:config.models[0].id,workingHours:{enabled:false,start:'09:00',end:'18:00'}};
 const makeLimits=i=>({available:i===0||i===3,retryAt:i===1||i===2?Date.now()+86400000:null,reason:i===1||i===2?'Factory usage limit reached':'',known:true,stale:i===2,windows:{fiveHour:{usedPercent:[0,39,54,0][i],windowEnd:i===0||i===3?null:new Date(Date.now()+3600000).toISOString()},weekly:{usedPercent:i===1||i===2?100:0,windowEnd:i===1||i===2?new Date(Date.now()+86400000).toISOString():null},monthly:{usedPercent:i===3?0:25,windowEnd:new Date(Date.now()+20*86400000).toISOString()}}});
 let limits=Object.fromEntries(ids.map((id,i)=>[id,{standard:makeLimits(i),core:{...makeLimits(0),available:true},fetchedAt:Date.now(),error:null}]));
 let mutateCount=0,testCount=0,failSave=false,failLimits=false;
 const savedBodies=[];
 const reply=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({success:status<400,...(status<400?{data}:{message:data})})});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==new URL(TARGET_URL).origin)return route.abort();
  if(!url.pathname.startsWith('/admin/'))return route.continue();
  const endpoint=url.pathname.slice(6),method=route.request().method(),body=route.request().postDataJSON();
  if(method!=='GET'){mutateCount++;savedBodies.push({endpoint,body});}
  if(endpoint==='/config'){
   if(method==='PUT'){
    if(failSave)return reply(route,'Simulated save failure',500);
    if(body.key_pool)config.key_pool={...config.key_pool,...body.key_pool};else Object.assign(config,body);
   }return reply(route,config);
  }
  if(endpoint==='/keys')return reply(route,{keys,pagination:{total_pages:1}});
  if(endpoint==='/pool-groups')return reply(route,[]);
  if(endpoint==='/token/limits')return failLimits?reply(route,'Simulated telemetry outage',503):reply(route,{keys:limits});
  if(endpoint==='/window-sync'){
   if(method==='PUT')Object.assign(settings,body);
   return reply(route,{settings,state:{phase:'waiting',message:'Waiting for weekly quota',members:syncMembers,spreadMs:15,nextCheckAt:Date.now()+30000},running:true,error:null,timezone:'Europe/Moscow',keys:keys.map(k=>({...k,tested:k.last_test_result==='success'})),models:config.models.map(m=>({...m,group:'standard'}))});
  }
  if(endpoint==='/logs/history')return reply(route,{logs:[{type:'generation',timestamp:new Date().toISOString(),level:'info',summary:{model:'claude-haiku-4-5-20251001',keyId:ids[1],outcome:'Completed',elapsedMs:1600,usage:{input:1000,output:20,cacheRead:900}}},{type:'generation',level:'error',timestamp:new Date().toISOString(),summary:{model:'test-model',outcome:'HTTP 503',upstreamError:{code:'provider_busy',message:'Provider is busy'},error:'<img src=x onerror=alert(1)> fk-hidden-secret',elapsedMs:100}}]});
  if(endpoint==='/keys/batch'){
   assert.equal(body.autoTest,false);keys.push({id:'account_added',status:'active',last_test_result:'untested',poolGroup:'default',notes:'Added'});
   return reply(route,{import:{success:1,duplicate:0,invalid:0}});
  }
  const exclusion=endpoint.match(/^\/keys\/(.+)\/exclusion$/);
  if(exclusion){keys.find(k=>k.id===exclusion[1]).excluded=body.excluded;return reply(route,{excluded:body.excluded});}
  if(endpoint.endsWith('/test')){testCount++;keys.find(k=>endpoint.includes(k.id)).last_test_result='success';return reply(route,{success:true,status:200});}
  if(endpoint.endsWith('/notes')){keys.find(k=>endpoint.includes(k.id)).notes=body.notes;return reply(route,{});}
  if(endpoint.endsWith('/toggle')){keys.find(k=>endpoint.includes(k.id)).status=body.status;return reply(route,{});}
  if(endpoint.startsWith('/keys/')&&method==='DELETE'){keys=keys.filter(k=>!endpoint.endsWith(k.id));return reply(route,{});}
  if(endpoint==='/keyword-filter/config')return reply(route,{enabled:false,rules:[]});
  return reply(route,'Unexpected test endpoint '+endpoint,404);
 });
 try{
  await page.goto(TARGET_URL);await page.locator('#adminKey').fill('ui-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('[data-account="'+ids[0]+'"] .badge').filter({hasText:'Excluded'}).waitFor();
  assert.equal(await page.locator('[data-account]').count(),4);
  assert.equal(await page.locator('body').textContent().then(t=>t.includes('fk-never-render-me')),false);
  assert.match(await page.locator('[data-account="'+ids[0]+'"] .subline').first().textContent(),/…tail00000/);
  assert.equal(await page.locator('body').textContent().then(t=>ids.some(id=>t.includes(id.slice(-9)))),false);
  assert.equal(await page.evaluate(async()=>{const {state,suffix}=await import('/ui.js');return !('key' in state.keys[0])&&state.keys[0].keySuffix==='…tail00000'&&suffix('missing')==='Unavailable key';}),true);
  await page.locator('#accountSearch').fill('tail00001');assert.equal(await page.locator('[data-account]').count(),1);
  await page.locator('#accountSearch').fill('');
  assert.equal(await page.locator('[data-account="'+ids[0]+'"] [data-action=test]').isDisabled(),true);
  assert.match(await page.locator('[data-account="'+ids[3]+'"] .badge').textContent(),/Needs test/);
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-accounts.png'),fullPage:true});
  await page.getByRole('button',{name:'Droid Core',exact:true}).click();assert.equal(await page.locator('[data-group=core]').getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Standard',exact:true}).click();
  await page.getByRole('link',{name:'Five-hour windows',exact:true}).click();
  assert.equal(await page.locator('[name=syncKey]:checked').count(),2);
  assert.equal(await page.locator('#syncKeys').textContent().then(t=>ids.some(id=>t.includes(id.slice(-9)))),false);
  assert.equal((await page.locator('#syncStatus').textContent()).includes('15 ms'),false,'Old group spread is not presented as current');
  settings.keyIds=[ids[1]];syncMembers={[ids[1]]:{windowEnd:new Date(Date.now()+4*3600000).toISOString(),quotaReady:true,ready:false,attempts:0}};
  await page.getByRole('button',{name:'Reload saved settings',exact:true}).click();
  await page.locator('#syncStatus').getByText('Current window is still running',{exact:true}).waitFor();
  assert.match(await page.locator('#syncStatus').textContent(),/Current window ends/);assert.match(await page.locator('#syncStatus').textContent(),/Quota checks do not send model requests/);
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-single-window.png'),fullPage:true});
  settings.keyIds=ids.slice(1,3);syncMembers={};await page.getByRole('button',{name:'Reload saved settings',exact:true}).click();

  await page.getByText('Working hours (optional)',{exact:true}).click();await page.locator('#hoursEnabled').check();await page.locator('#hoursStart').fill('10:15');
  await page.waitForTimeout(11000);assert.equal(await page.locator('#hoursStart').inputValue(),'10:15','Polling preserves draft');
  assert.match(await page.locator('#windowSaved').textContent(),/Unsaved/);
  await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.waitForFunction(()=>document.getElementById('windowSaved').textContent==='Saved configuration');
  assert.equal(settings.workingHours.start,'10:15');assert.deepEqual(settings.keyIds,ids.slice(1,3));
  await page.reload();await page.locator('#hoursStart').waitFor({state:'visible'});assert.equal(await page.locator('#hoursStart').inputValue(),'10:15');
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-windows.png'),fullPage:true});
  await page.getByRole('link',{name:'Settings',exact:true}).click();await page.locator('#algorithm').selectOption('round-robin');
  await page.getByRole('button',{name:'Save balancing',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Balancing saved'));
  assert.equal(config.key_pool.algorithm,'round-robin');assert.equal(config.key_pool.retry.enabled,true);assert.equal(config.system_prompt,'Leave unchanged');
  failSave=true;await page.locator('#algorithm').selectOption('random');await page.getByRole('button',{name:'Save balancing',exact:true}).click();await page.locator('#notice.error').waitFor();assert.equal(config.key_pool.algorithm,'round-robin');failSave=false;
  await page.getByText('Models and advanced settings',{exact:true}).click();await page.locator('#configSection').selectOption('system_prompt');await page.locator('#configJson').fill('"Edited prompt"');
  await page.getByRole('button',{name:'Save section',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Section saved'));
  assert.equal(config.system_prompt,'Edited prompt');assert.equal(config.models.length,1);
  await page.getByRole('link',{name:'Requests',exact:true}).click();await page.locator('#requestRows tr').first().waitFor();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();assert.equal(await page.locator('#requestRows img').count(),0);
  assert.equal((await page.locator('#requestRows').textContent()).includes('fk-hidden-secret'),false);
  assert.match(await page.locator('#requestRows').textContent(),/provider_busy: Provider is busy/);
  assert.match(await page.locator('#requestRows').textContent(),/…tail00001/);
  await page.locator('#errorsOnly').check();assert.equal(await page.locator('#requestRows tr').count(),1);
  await page.getByRole('link',{name:'Accounts',exact:true}).click();
  await page.locator('[data-account="'+ids[0]+'"] [data-action=exclude]').click();await page.locator('[data-account="'+ids[0]+'"] [data-action=exclude]').filter({hasText:'Disable usage'}).waitFor();
  assert.equal(keys[0].excluded,false);assert.equal(keys[0].status,'active','Usage control preserves technical status');
  await page.locator('[data-account="'+ids[0]+'"] [data-action=exclude]').click();await page.locator('[data-account="'+ids[0]+'"] .badge').filter({hasText:'Excluded'}).waitFor();assert.equal(keys[0].excluded,true);
  await page.getByRole('button',{name:'Add keys',exact:true}).click();await page.locator('[name=keys]').fill('fk-fixture');await page.locator('#editorSave').click();await page.locator('[data-account=account_added]').waitFor();assert.equal(testCount,0);
  await page.locator('[data-account=account_added] [data-action=test]').click();assert.equal(testCount,0);await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(testCount,0);
  await page.locator('[data-account=account_added] [data-action=test]').click();await page.locator('#editorSave').click();await page.locator('#editor').waitFor({state:'hidden'});assert.equal(testCount,1);
  await page.locator('[data-account=account_added] [data-action=edit]').click();await page.locator('[name=notes]').fill('Renamed account');await page.locator('#editorSave').click();await page.locator('#editor').waitFor({state:'hidden'});assert.equal(keys.at(-1).notes,'Renamed account');
  await page.locator('[data-account=account_added] [data-action=edit]').click();assert.equal(await page.locator('#toggleAccount').count(),0);assert.match(await page.locator('#editor').textContent(),/Technical status: active/);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('[data-account=account_added] [data-action=edit]').click();await page.locator('#deleteAccount').click();await page.locator('#editorSave').click();await page.locator('#editor').waitFor({state:'hidden'});assert.equal(keys.length,4);
  failLimits=true;await page.getByRole('button',{name:'Refresh limits',exact:true}).click();await page.locator('#accountsError').waitFor({state:'visible'});assert.equal(await page.locator('[data-account]').count(),4);failLimits=false;
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page-wide horizontal overflow');
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Refresh limits',exact:true}).click();await page.locator('#accountsError').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
  for(const width of [1920,1360,1280,1101,1024,900,768,640,390,320]) {
   await page.setViewportSize({width,height:900});
   for(const tab of ['Accounts','Five-hour windows','Requests','Settings']) {
    await page.getByRole('link',{name:tab,exact:true}).click();
    if(tab==='Five-hour windows')await page.locator('#windows>details').evaluate(el=>el.open=true);
    const layout=await page.evaluate(()=>({page:document.documentElement.scrollWidth<=innerWidth, tables:[...document.querySelectorAll('section:not([hidden]) .table-wrap')].every(el=>el.scrollWidth<=el.clientWidth+1)}));
    assert.ok(layout.page && layout.tables, 'No page/table clipping at '+width+'px on '+tab+': '+JSON.stringify(layout));
   }
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('link',{name:'Accounts',exact:true}).click();
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-mobile.png'),fullPage:true});
  await page.getByRole('link',{name:'Five-hour windows',exact:true}).click();await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-windows-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.getByRole('link',{name:'Accounts',exact:true}).click();
  await page.screenshot({path:path.join(os.tmpdir(),'droid-admin-accounts.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.ok(mutateCount>=6);assert.equal(testCount,1);
  console.log('PASS: compact UI, excluded/untested states, drafts, persistence, failures, safe imports, XSS, mobile layout; no Factory calls');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
