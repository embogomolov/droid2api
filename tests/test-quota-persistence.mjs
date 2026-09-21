import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AsyncFileWriter} from '../utils/async-file-writer.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quota-persistence-'));
const file=path.join(dir,'state.json'),writer=new AsyncFileWriter(file,{debounceTime:40});
const writes=[],pending=[];let producing=true;
const atomic=writer._atomicWrite.bind(writer);
writer._atomicWrite=async data=>{writes.push({duringTraffic:producing,version:data.version});await atomic(data);};
for(let version=1;version<=50;version++){
  pending.push(writer.write({version}));
  await delay(5);
}
producing=false;
await writer.destroy();await Promise.all(pending);
assert.ok(writes.some(w=>w.duringTraffic&&w.version<50),'Continuous traffic must not defer every write until idle/shutdown');
assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:50});
assert.ok(JSON.parse(await fs.readFile(file+'.bak','utf8')).version<50);
console.log('PASS: quota state persists during continuous traffic; shutdown flushes the latest atomic snapshot');
