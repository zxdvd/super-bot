/** Two live native Workers share one Bot; another Bot waits for a released slot. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`capacity:${randomUUID()}`;
async function raw(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}) {const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function select(sessionId) {const response=await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId});assert.equal(response.status,200);}
async function waitFor(id,condition) {let state;for(let n=0;n<200;n++){state=await call('task.detail',{id});if(condition(state))return state;await delay(100);}assert.fail(JSON.stringify(state));}
const firstBot=await call('bot.create',{requestId:prefix+':bot-a',name:'双执行容量 Bot',instructions:'无网络暂停流探针。'});
const secondBot=await call('bot.create',{requestId:prefix+':bot-b',name:'等待名额 Bot',instructions:'无网络文件探针。'});
const held=[];
try {
  for(let n=0;n<2;n++) {
    const task=await call('task.create',{requestId:prefix+':task-'+n,botId:firstBot.id,goal:'STOP_PROBE',scope:'本任务目录',acceptance:'明确停止',reviewPolicy:'human'});
    const binding=await call('session.prepare',{requestId:prefix+':prepare-'+n,id:task.id,expectedRowVersion:task.rowVersion});await select(binding.sessionId);
    const current=(await call('task.detail',{id:task.id})).task;await call('task.dispatch',{requestId:prefix+':dispatch-'+n,id:task.id,expectedRowVersion:current.rowVersion});held.push(task.id);
    await waitFor(task.id,state=>state.input.state==='entered');
  }
  const both=await Promise.all(held.map(id=>call('task.detail',{id})));assert.ok(both.every(state=>state.run.state==='running'));assert.notEqual(both[0].binding.sessionId,both[1].binding.sessionId);assert.notEqual(both[0].binding.cwd,both[1].binding.cwd);
  const task=await call('task.create',{requestId:prefix+':third',botId:secondBot.id,goal:'等待名额后生成说明',scope:'自己的任务目录',acceptance:'有两项事实',reviewPolicy:'human'});
  const binding=await call('session.prepare',{requestId:prefix+':prepare-third',id:task.id,expectedRowVersion:task.rowVersion});await select(binding.sessionId);
  const current=(await call('task.detail',{id:task.id})).task;
  const full=await raw('task.dispatch',{requestId:prefix+':full',id:task.id,expectedRowVersion:current.rowVersion});assert.equal(full.error.code,'capacity');assert.equal((await call('task.detail',{id:task.id})).run,null);
  const manager=await call('manager.prepare',{requestId:prefix+':manager',botId:secondBot.id});await select(manager.sessionId);
  await delay(2500);assert.equal((await call('task.detail',{id:task.id})).run,null);assert.ok((await call('manager.status',{botId:secondBot.id})).pending>0);
  const stopState=await call('task.detail',{id:held[0]});await call('task.stop',{requestId:prefix+':free-slot',id:held[0],expectedRowVersion:stopState.task.rowVersion});await waitFor(held[0],state=>state.run.state==='cancelled');
  const result=await waitFor(task.id,state=>state.task.lifecycle==='review');assert.equal(result.input.state,'entered');assert.equal(result.binding.sessionId,binding.sessionId);assert.equal(result.task.botId,secondBot.id);
  assert.equal((await call('task.detail',{id:held[1]})).run.state,'running');
  console.log(JSON.stringify({ok:true,heldTasks:held,waitingTask:task.id,checks:['two Workers of one Bot actually run concurrently','third dispatch creates no Run when full','Manager capacity event waits without overselling','released slot admits the other Bot while second Worker stays active']},null,2));
}finally {
  for(const id of held){const state=await call('task.detail',{id});if(state.run.finishedAt===null){await call('task.stop',{requestId:prefix+':cleanup:'+id,id,expectedRowVersion:state.task.rowVersion});await waitFor(id,state=>state.run.state==='cancelled');}}
}
