/** Three actual Managers contend for the two automatic wake slots. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`manager-capacity:${randomUUID()}`;
async function raw(action,payload={}){return (await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;}
async function call(action,payload={}){const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function probe(action,sessionId){const r=await(await client.post('/api/super-bot-probe',{action,sessionId})).json();assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function wait(check){let value;for(let n=0;n<200;n++){value=await check();if(value.ok)return value;await delay(100);}assert.fail(JSON.stringify(value));}
const managers=[];
for(let n=0;n<3;n++){
  const bot=await call('bot.create',{requestId:prefix+':bot:'+n,name:`并发 Manager 探针 ${n}`,instructions:'只观察暂停任务，不执行。'});
  const manager=await call('manager.prepare',{requestId:prefix+':manager:'+n,botId:bot.id});await probe('select-test-model',manager.sessionId);
  await wait(async()=>{const state=await probe('inspect-session',manager.sessionId),info=await call('manager.status',{botId:bot.id});return {ok:state.status==='idle'&&info.pending===0};});
  managers.push({bot,manager,before:(await probe('inspect-session',manager.sessionId)).modelSteps});
}
try {
  for(const {bot} of managers)await call('task.create',{requestId:prefix+':task:'+bot.id,botId:bot.id,goal:'MANAGER_HOLD_PROBE',scope:'只读暂停任务',acceptance:'无 Worker',reviewPolicy:'human',startPaused:true});
  const first=await wait(async()=>{const states=await Promise.all(managers.map(({manager})=>probe('inspect-session',manager.sessionId)));return {ok:states.filter(s=>s.stalled).length===2,states};});
  const held=first.states.map((s,i)=>s.stalled?i:-1).filter(i=>i>=0),waiting=first.states.findIndex(s=>!s.stalled);
  await delay(2200);const queued=await probe('inspect-session',managers[waiting].manager.sessionId);assert.equal(queued.modelSteps,managers[waiting].before);assert.equal((await call('manager.status',{botId:managers[waiting].bot.id})).pending,1);
  const busy=managers[held[0]];const change=await raw('bot.update',{requestId:prefix+':busy-update',id:busy.bot.id,expectedRevision:1,name:'Must not change',instructions:'Busy update refused'});assert.equal(change.ok,false);assert.equal(change.error.code,'manager-busy');
  await probe('release-stalled-model',busy.manager.sessionId);
  await wait(async()=>({ok:(await probe('inspect-session',managers[waiting].manager.sessionId)).stalled}));assert.equal((await probe('inspect-session',managers[held[1]].manager.sessionId)).stalled,true);
  console.log(JSON.stringify({ok:true,bots:managers.map(m=>m.bot.id),checks:['exactly two automatic Managers hold slots simultaneously','third event remains pending without any model call','busy Manager configuration update is refused','releasing one slot starts third while second remains active']},null,2));
}finally{
  for(const {manager} of managers){const state=await probe('inspect-session',manager.sessionId);if(state.stalled)await probe('release-stalled-model',manager.sessionId);}
  for(const {manager} of managers)await wait(async()=>({ok:(await probe('inspect-session',manager.sessionId)).status==='idle'}));
}
