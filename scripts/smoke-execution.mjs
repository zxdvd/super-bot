/** One synthetic file task through the actual product API and real DSH tools. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient();const prefix=`execution-smoke:${randomUUID()}`;
async function raw(action,payload={}) {
  const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});
  assert.equal(response.status,200);return (await response.json()).result;
}
async function call(action,payload={}){const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'执行闭环探针',instructions:'仅处理合成文件，不使用网络。'});
let task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'生成包含两项事实的说明文件',scope:'本任务专用目录',acceptance:'result.md 包含标题与两项事实，回读检查',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});
assert.equal(binding.state,'ready');
const selection=await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:binding.sessionId});assert.equal(selection.status,200);
task=(await call('task.detail',{id:task.id})).task;
const dispatch={requestId:prefix+':dispatch',id:task.id,expectedRowVersion:task.rowVersion};
const run=await call('task.dispatch',dispatch);assert.equal((await call('task.dispatch',dispatch)).id,run.id);
let detail;
for(let i=0;i<200;i++) {detail=await call('task.detail',{id:task.id});if(['review','recovery'].includes(detail.task.status))break;await delay(100);}
assert.equal(detail.task.lifecycle,'review',JSON.stringify(detail));assert.equal(detail.input.state,'entered');assert.equal(detail.run.state,'settled');
const file=detail.result.evidence[0].path;assert.ok(file.startsWith(binding.cwd+'/'));
const original=await readFile(file);assert.match(original.toString(),/事实一/);
await writeFile(file,'Changed after report');
const accept={id:task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result.id};
const stale=await raw('result.accept',{requestId:prefix+':changed',...accept});assert.equal(stale.ok,false);assert.equal(stale.error.code,'evidence-changed');
await writeFile(file,original);
const accepted=await call('result.accept',{requestId:prefix+':accept',...accept});assert.equal(accepted.lifecycle,'completed');
assert.equal((await call('result.accept',{requestId:prefix+':accept',...accept})).lifecycle,'completed');
assert.equal((await call('task.dispatch',dispatch)).id,run.id);
let stopTask=await call('task.create',{requestId:prefix+':stop-task',botId:bot.id,goal:'STOP_PROBE',scope:'专用目录',acceptance:'取消后没有文件效果',reviewPolicy:'human'});
const stopBinding=await call('session.prepare',{requestId:prefix+':stop-prepare',id:stopTask.id,expectedRowVersion:stopTask.rowVersion});
await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:stopBinding.sessionId});
stopTask=(await call('task.detail',{id:stopTask.id})).task;
await call('task.dispatch',{requestId:prefix+':stop-dispatch',id:stopTask.id,expectedRowVersion:stopTask.rowVersion});
let stopDetail;
for(let i=0;i<50;i++){stopDetail=await call('task.detail',{id:stopTask.id});if(stopDetail.input.state==='entered')break;await delay(100);}
assert.equal(stopDetail.input.state,'entered');
const stop={requestId:prefix+':stop',id:stopTask.id,expectedRowVersion:stopDetail.task.rowVersion};
await call('task.stop',stop);await call('task.stop',stop);
for(let i=0;i<50;i++){stopDetail=await call('task.detail',{id:stopTask.id});if(stopDetail.run.state==='cancelled')break;await delay(100);}
assert.equal(stopDetail.run.state,'cancelled');assert.equal(stopDetail.task.status,'paused');
console.log(JSON.stringify({ok:true,taskId:task.id,sessionId:binding.sessionId,runId:run.id,stopTaskId:stopTask.id,checks:['real write/read/report tools','duplicate dispatch returns same run','input entered and execution settled','changed evidence refused','human acceptance commits once','streaming model cancellation converges without completing the task']},null,2));
