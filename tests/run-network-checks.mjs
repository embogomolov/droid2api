// Copy code to a temporary checkout: tests never read or write the real key pool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'droid-network-test-'));
for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js')||n==='package.json'))fs.copyFileSync(path.join(root,name),path.join(dir,name));
for(const name of ['api','middleware','utils','transformers','tests'])fs.cpSync(path.join(root,name),path.join(dir,name),{recursive:true});
fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'junction');
fs.mkdirSync(path.join(dir,'data'));
const config=JSON.parse(fs.readFileSync(path.join(root,'data/config.json')));
fs.writeFileSync(path.join(dir,'data/config.json'),JSON.stringify({models:config.models,endpoint:config.endpoint,token_sync:{enabled:false}}));
fs.writeFileSync(path.join(dir,'data/key_pool.json'),'{"keys":[],"stats":{}}');
fs.writeFileSync(path.join(dir,'offline.mjs'),`
import http from 'node:http';import https from 'node:https';
for(const mod of [http,https]){const original=mod.request;mod.request=function(url,...args){const host=typeof url==='string'?new URL(url).hostname:url.hostname||url.host;if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Offline test blocked external network');return original.call(this,url,...args);};}
`);
const env={...process.env,DROID2API_STATS_FILE:path.join(dir,'data/request_stats.json'),CLUSTER_MODE:'false',TOKEN_SYNC_ENABLED:'false',AUTOMATIC_KEY_TESTS:'false'};
for(const key of Object.keys(env))if(/^(FACTORY_|DROID_REFRESH_KEY|KEY_POOL_|REDIS_)/.test(key))delete env[key];
for(const name of process.argv.slice(2).length?process.argv.slice(2):['test-network-recovery.mjs','test-factory-limits.js','test-factory-websocket.js','test-claude-gateway.mjs','test-factory-images.js','test-settings-persistence.mjs','test-shutdown.mjs','test-key-exclusion.mjs','test-window-sync.mjs','test-window-sync-dual.mjs','test-window-actions.mjs','test-window-sync-api.mjs','test-admin-observability.mjs']) {
  if(!/^test-[a-z0-9-]+\.(mjs|js)$/.test(name))throw new Error('Invalid test filename');
  const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(dir,'offline.mjs')).href,path.join(dir,'tests',name)],{cwd:dir,env,encoding:'utf8',timeout:60000,windowsHide:true});
  if(result.status!==0){process.stderr.write(result.stdout+result.stderr);throw new Error(name+' failed: '+(result.error?.message||result.status));}
  console.log('PASS:',name);
}
console.log('Isolated evidence:',dir);
