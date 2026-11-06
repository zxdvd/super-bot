/** Read-only verification against the host started with the restored data directory. */
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostClient } from './host-client.mjs';
const manifest=JSON.parse(await readFile(process.argv[2]??'.runtime/lifecycle-backup.json','utf8'));
const client=await hostClient();
async function call(action,payload={}) {
  const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});
  assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
const bots=await call('bot.list');assert.equal(bots.length,manifest.counts.bots);
let tasks=0,paused=0,files=0;
for(const bot of bots) {
  const manager=await call('manager.status',{botId:bot.id});assert.equal(manager.pending,0,'restored manager notifications must not replay');
  for(let offset=0;;offset+=25) {
    const page=await call('task.list',{botId:bot.id,offset,limit:25});tasks+=page.items.length;
    for(const task of page.items) {
      if(['open','review'].includes(task.lifecycle)){assert.equal(task.controlMode,'paused');assert.equal(task.status,'recovery');paused++;}
      const detail=await call('task.detail',{id:task.id});
      for(const evidence of detail.result?.evidence??[]) {
        const data=await readFile(evidence.path);assert.equal(createHash('sha256').update(data).digest('hex'),evidence.sha256);assert.equal(data.length,evidence.bytes);files++;
      }
    }
    if(page.items.length<25)break;
  }
}
assert.equal(tasks,manifest.counts.tasks);
for(const sessionId of manifest.sessions) {
  const response=await client.post('/api/super-bot-probe',{action:'inspect-session',sessionId});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.sessionId,sessionId);assert.equal(result.status,'idle');assert.equal(result.pending,0);
  assert.deepEqual(result.productTools.sort(),['super_bot_manage','super_bot_report']);
}
console.log(JSON.stringify({ok:true,bots:bots.length,tasks,paused,files,retainedSessions:manifest.sessions.length,checks:['same task counts','unfinished tasks held for recovery','no restored notification replay','original evidence hashes','original sessions accessible','one registration per product tool']},null,2));
