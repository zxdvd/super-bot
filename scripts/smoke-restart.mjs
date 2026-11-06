/** Two phases around an externally forced restart of the isolated test host. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient();
assert.equal(new URL(client.base).port,'3081');
async function call(action,payload={}) {
  const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});
  assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
const record='.runtime/restart-smoke.json';
if(process.argv[2]==='prepare') {
  const prefix=`restart:${randomUUID()}`;
  const bot=await call('bot.create',{requestId:prefix+':bot',name:'强制重启探针',instructions:'仅合成数据，无网络或进程工具。'});
  const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'STOP_PROBE',scope:'专用临时目录',acceptance:'重启不重复投递、不误标完成',reviewPolicy:'human'});
  const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});
  const selected=await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:binding.sessionId});assert.equal(selected.status,200);
  const version=(await call('task.detail',{id:task.id})).task.rowVersion;
  const dispatch={requestId:prefix+':dispatch',id:task.id,expectedRowVersion:version};
  const run=await call('task.dispatch',dispatch);let detail;
  for(let n=0;n<100;n++){detail=await call('task.detail',{id:task.id});if(detail.input.state==='entered')break;await delay(100);}
  assert.equal(detail.input.state,'entered');assert.equal(detail.run.state,'running');
  await writeFile(record,JSON.stringify({prefix,taskId:task.id,sessionId:binding.sessionId,runId:run.id,inputId:detail.input.id,dispatch},null,2));
  console.log(JSON.stringify({ok:true,phase:'prepared',taskId:task.id,runId:run.id}));
} else if(process.argv[2]==='verify') {
  const saved=JSON.parse(await readFile(record,'utf8'));let detail=await call('task.detail',{id:saved.taskId});
  assert.equal(detail.run.id,saved.runId);assert.equal(detail.run.state,'interrupted');assert.equal(detail.task.status,'recovery');assert.equal(detail.input.id,saved.inputId);
  assert.equal((await call('task.dispatch',saved.dispatch)).id,saved.runId);
  await delay(1500);detail=await call('task.detail',{id:saved.taskId});assert.equal(detail.run.id,saved.runId);assert.equal(detail.task.status,'recovery');
  const recovered=await call('run.recover',{requestId:saved.prefix+':recover',id:saved.taskId,expectedRowVersion:detail.task.rowVersion,acknowledged:true});
  assert.equal(recovered.status,'paused');assert.equal(recovered.lifecycle,'open');
  console.log(JSON.stringify({ok:true,phase:'verified',taskId:saved.taskId,checks:['same Run/Input after forced termination','interrupted and recovery instead of completion','duplicate dispatch never replays','explicit recovery remains paused']},null,2));
} else throw new Error('Usage: node scripts/smoke-restart.mjs prepare|verify');
