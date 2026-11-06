/** Observe the dedicated, unconfigured package profile without starting model work. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {hostClient} from './host-client.mjs';
const seconds=Number(process.argv[2]??600);assert.ok(Number.isFinite(seconds)&&seconds>=1&&seconds<=3600);
const fixture=JSON.parse(await readFile('.runtime/package-manager-lifecycle.json','utf8'));
const client=await hostClient('.runtime/package-host.log');assert.equal(new URL(client.base).port,'3082');
async function call(action,payload={}){const result=(await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const initial=await call('status'),first=await call('manager.status',{botId:fixture.botId});assert.equal(first.hourlyWakes,0);assert.ok(first.pending>0);
const started=performance.now();let samples=0;
do {
  const [status,info,tasks]=await Promise.all([call('status'),call('manager.status',{botId:fixture.botId}),call('task.list',{botId:fixture.botId})]);
  assert.equal(status.startedAt,initial.startedAt,'host must stay running');assert.equal(info.binding.sessionId,fixture.managerSessionId);assert.equal(info.pending,first.pending);assert.equal(info.hourlyWakes,0);assert.equal(tasks.total,0);samples++;
  const remaining=seconds*1000-(performance.now()-started);if(remaining<=0)break;
  await delay(Math.min(30000,remaining));
}while(true);
const evidence={ok:true,elapsedMs:Math.round(performance.now()-started),samples,botId:fixture.botId,checks:['packaged host stayed available without restart','unselected Manager retained its generation and pending notifications','no automatic wakes or tasks were created']};
await writeFile('.runtime/package-idle-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
