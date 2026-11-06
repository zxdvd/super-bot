/** Real DSH step cap and a separately observed, real ten-minute deadline. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const mode=process.argv[2]??'steps';
assert.ok(['steps','time-start','time-verify'].includes(mode));
const client=await hostClient(),prefix=`budget:${randomUUID()}`;
async function call(action,payload={}) {
  const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});
  assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
async function probe(action,sessionId) {
  const response=await client.post('/api/super-bot-probe',{action,sessionId});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;
}
let taskId,sessionId,runId,startedAt;
if(mode==='time-verify')({taskId,sessionId,runId,startedAt}=JSON.parse(await readFile('.runtime/time-budget.json','utf8')));
else {
  const bot=await call('bot.create',{requestId:prefix+':bot',name:mode==='steps'?'四十步执行预算探针':'十分钟执行预算探针',instructions:'无网络合成任务。'});
  const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:mode==='steps'?'STEP_BUDGET_PROBE':'STOP_PROBE',scope:'仅任务目录，不产生外部效果',acceptance:'程序执行预算耗尽后停止且不自动重试',reviewPolicy:'human'});
  const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});
  taskId=task.id;sessionId=binding.sessionId;await probe('select-test-model',sessionId);
  const current=(await call('task.detail',{id:taskId})).task;
  startedAt=Date.now();const run=await call('task.dispatch',{requestId:prefix+':dispatch',id:taskId,expectedRowVersion:current.rowVersion});runId=run.id;
}
if(mode==='time-start') {
  await writeFile('.runtime/time-budget.json',JSON.stringify({taskId,sessionId,runId,startedAt}));
  console.log(JSON.stringify({ok:true,taskId,sessionId,runId,verifyAfter:new Date(startedAt+601000).toISOString()},null,2));
}else {
  let detail;
  for(let n=0;n<300;n++){detail=await call('task.detail',{id:taskId});if(detail.run.state==='cancelled')break;await delay(100);}
  assert.equal(detail.run.id,runId);assert.equal(detail.run.state,'cancelled',JSON.stringify(detail));assert.equal(detail.task.status,'recovery');assert.equal(detail.task.controlMode,'paused');assert.equal(detail.result,null);
  const budget=detail.events.filter(event=>event.kind==='run.budget-reached');assert.equal(budget.length,1);
  assert.match(detail.run.note,mode==='steps'?/40 步/:/10 分钟/);
  assert.ok(detail.attentions.some(attention=>attention.kind==='recovery'&&attention.state==='open'&&attention.question.includes('不会自动重试')));
  const native=await probe('inspect-session',sessionId);assert.equal(native.status,'idle');assert.equal(native.pending,0);
  if(mode==='steps')assert.equal(native.modelSteps,40);else assert.ok(detail.run.finishedAt-startedAt>=600000);
  const recovered=await call('run.recover',{requestId:prefix+':recover',id:taskId,expectedRowVersion:detail.task.rowVersion,acknowledged:true});assert.equal(recovered.status,'paused');
  await delay(1200);assert.equal((await call('task.detail',{id:taskId})).run.id,runId);
  console.log(JSON.stringify({ok:true,mode,taskId,sessionId,runId,modelSteps:native.modelSteps,elapsedMs:detail.run.finishedAt-startedAt,checks:['budget reason persists','real native Agent idle with empty inbox','no candidate or automatic retry','explicit recovery keeps task paused']},null,2));
}
