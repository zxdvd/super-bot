/** Real bounded Manager turns; no Worker execution or external effects. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const mode=process.argv[2]??'steps';assert.ok(['steps','hourly','time-start','time-verify'].includes(mode));
const client=await hostClient(),prefix=`manager-budget:${randomUUID()}`;
async function call(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId) {const response=await client.post('/api/super-bot-probe',{action,sessionId});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true);return result;}
async function waitFor(check,limit=400) {for(let n=0;n<limit;n++){const value=await check();if(value)return value;await delay(100);}assert.fail('Timed out waiting for Manager budget');}
let botId,sessionId,taskId,startedAt;
if(mode==='time-verify')({botId,sessionId,taskId,startedAt}=JSON.parse(await readFile('.runtime/manager-time-budget.json','utf8')));
else {
  const bot=await call('bot.create',{requestId:prefix+':bot',name:`管理预算探针 ${mode}`,instructions:'只查询合成账本，不安排执行。'});botId=bot.id;
  const manager=await call('manager.prepare',{requestId:prefix+':manager',botId});sessionId=manager.sessionId;await probe('select-test-model',sessionId);
  await waitFor(async()=>{const info=await call('manager.status',{botId});const native=await probe('inspect-session',sessionId);return info.pending===0&&native.status==='idle';});
}
if(mode==='time-verify') {
  const info=await waitFor(async()=>{const current=await call('manager.status',{botId});return current.problem?.message.includes('5 分钟')?current:false;});
  await waitFor(async()=>(await probe('inspect-session',sessionId)).status==='idle');
  assert.ok(info.problem.at-startedAt>=300000);const task=await call('task.detail',{id:taskId});assert.equal(task.run,null);assert.equal(task.task.controlMode,'paused');
  console.log(JSON.stringify({ok:true,mode,botId,sessionId,elapsedMs:info.problem.at-startedAt,checks:['actual five-minute automatic wake deadline','native Manager converges to idle','budget problem remains visible','paused task is never dispatched']},null,2));
}else if(mode==='hourly') {
  for(let n=0;n<25;n++)await call('task.create',{requestId:prefix+':task-'+n,botId,goal:`只观察已暂停任务 ${n}`,scope:'无执行',acceptance:'保持暂停',reviewPolicy:'human',startPaused:true});
  const limited=await waitFor(async()=>{const info=await call('manager.status',{botId});return info.hourlyWakes===20?info:false;});assert.ok(limited.pending>=6);
  await waitFor(async()=>(await probe('inspect-session',sessionId)).status==='idle');const before=await probe('inspect-session',sessionId);
  await delay(2200);const unchanged=await call('manager.status',{botId});assert.equal(unchanged.hourlyWakes,20);assert.equal(unchanged.pending,limited.pending);assert.equal((await probe('inspect-session',sessionId)).modelSteps,before.modelSteps);
  const replacement=await call('manager.replace',{requestId:prefix+':replace',botId,expectedGeneration:unchanged.binding.generation});await delay(2200);
  const after=await call('manager.status',{botId});assert.equal(after.hourlyWakes,20);assert.ok(after.pending>unchanged.pending);assert.equal((await probe('inspect-session',replacement.sessionId)).modelSteps,0);
  console.log(JSON.stringify({ok:true,mode,botId,sessionId:replacement.sessionId,pending:after.pending,checks:['exactly twenty automatic wakes in the hour','additional work stays pending without model calls','Manager replacement cannot reset hourly quota']},null,2));
}else {
  const before=await probe('inspect-session',sessionId);startedAt=Date.now();
  const task=await call('task.create',{requestId:prefix+':task',botId,goal:mode==='steps'?'MANAGER_STEP_PROBE':'MANAGER_TIME_PROBE',scope:'只读账本，不执行',acceptance:'预算耗尽停止',reviewPolicy:'human',startPaused:true});taskId=task.id;
  if(mode==='time-start') {
    await writeFile('.runtime/manager-time-budget.json',JSON.stringify({botId,sessionId,taskId,startedAt}));
    console.log(JSON.stringify({ok:true,mode,botId,sessionId,verifyAfter:new Date(startedAt+302000).toISOString()},null,2));
  }else {
    await waitFor(async()=>(await call('manager.status',{botId})).problem?.message.includes('12 步'));
    const native=await waitFor(async()=>{const current=await probe('inspect-session',sessionId);return current.status==='idle'?current:false;});
    assert.equal(native.modelSteps-before.modelSteps,12);assert.equal((await call('task.detail',{id:taskId})).run,null);
    console.log(JSON.stringify({ok:true,mode,botId,sessionId,modelSteps:native.modelSteps-before.modelSteps,checks:['exactly twelve Manager model steps','budget reason visible on dashboard','no Worker Run created']},null,2));
  }
}
