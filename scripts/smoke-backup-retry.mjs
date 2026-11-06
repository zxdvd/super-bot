/** Published-snapshot fault checks against the dedicated tarball host; no model required. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,rename,rm,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {hostClient} from './host-client.mjs';
const client=await hostClient('.runtime/package-host.log');assert.equal(new URL(client.base).port,'3082');
async function raw(action,payload={}){return(await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;}
async function call(action,payload={}){const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const prefix=`backup-window:${randomUUID()}`,requestId=prefix+':snapshot';
const first=await call('backup.create',{requestId});
assert.equal(dirname(first.path),resolve('.runtime/package-test/super-bot/backups'),'only dedicated synthetic backups may be changed');
const bytes=await readFile(first.path),hash=createHash('sha256').update(bytes).digest('hex');
const manifest=await readFile(first.manifestPath);
await call('bot.create',{requestId:prefix+':later',name:'备份断点验证',instructions:'此 Bot 创建于快照之后，不调用模型。'});
try {
  await rm(first.manifestPath);
  const retried=await call('backup.create',{requestId});
  assert.deepEqual(retried.counts,first.counts);assert.deepEqual(await readFile(first.path),bytes);
  assert.deepEqual(await call('backup.create',{requestId}),retried);
  const held=first.path+'.smoke-held';await rename(first.path,held);
  try {
    const missing=await raw('backup.create',{requestId});assert.equal(missing.ok,false);assert.equal(missing.error.code,'backup-unavailable');
  }finally{await rename(held,first.path);}
  assert.equal(createHash('sha256').update(await readFile(first.path)).digest('hex'),hash);
}finally{
  // Restore the original manifest even if an assertion fails; keep the first snapshot intact.
  await writeFile(first.manifestPath,manifest,{mode:0o600});
}
const result={ok:true,backup:first.path,sha256:hash,checks:['manifest interruption keeps first published snapshot after later ledger writes','duplicate retry remains stable','missing snapshot returns backup-unavailable','original snapshot and manifest retained']};
await writeFile('.runtime/backup-retry-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
