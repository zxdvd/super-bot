/** No credentials read or provider calls: fake failure through real turn/end events. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hostClient} from './host-client.mjs';
const c=await hostClient(),p=`model-errors:${randomUUID()}`;
async function raw(action,payload={}){return(await(await c.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;}
async function call(action,payload={}){const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function probe(action,sessionId){const r=await(await c.post('/api/super-bot-probe',{action,sessionId})).json();assert.equal(r.ok,true);return r;}
async function wait(test){let value;for(let n=0;n<100;n++){value=await test();if(value.ok)return value;await delay(100);}assert.fail(JSON.stringify(value));}
const bot=await call('bot.create',{requestId:p+':bot',name:'模型错误反馈探针',instructions:'不访问真实提供商'});
const task=await call('task.create',{requestId:p+':task',botId:bot.id,goal:'MODEL_FAILURE_PROBE',scope:'专用目录',acceptance:'失败原因明确',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:p+':prepare',id:task.id,expectedRowVersion:task.rowVersion});let d=await call('task.detail',{id:task.id});
const blocked=await raw('task.dispatch',{requestId:p+':unselected',id:task.id,expectedRowVersion:d.task.rowVersion});assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'model-required');assert.equal((await call('task.detail',{id:task.id})).run,null);
await probe('select-test-model',binding.sessionId);await call('task.dispatch',{requestId:p+':dispatch',id:task.id,expectedRowVersion:d.task.rowVersion});
await wait(async()=>{d=await call('task.detail',{id:task.id});return {ok:d.task.status==='recovery',d};});assert.match(d.run.note,/模型缺少/);assert.equal(d.result,null);
await wait(async()=>({ok:(await probe('inspect-session',binding.sessionId)).status==='idle'}));
assert.equal((await call('run.recover',{requestId:p+':recover',id:task.id,expectedRowVersion:d.task.rowVersion,acknowledged:true})).status,'paused');
const mb=await call('bot.create',{requestId:p+':mb',name:'管理模型选择探针',instructions:'无模型时保留通知'});
const m=await call('manager.prepare',{requestId:p+':manager',botId:mb.id});
await call('task.create',{requestId:p+':mt',botId:mb.id,goal:'MANAGER_MODEL_FAILURE_PROBE',scope:'只读账本',acceptance:'明确错误',reviewPolicy:'human',startPaused:true});await delay(2200);
let info=await call('manager.status',{botId:mb.id});assert.equal(info.hourlyWakes,0);assert.ok(info.pending>0);assert.match(info.problem.message,/选择并配置模型/);assert.equal((await probe('inspect-session',m.sessionId)).modelSteps,0);
await probe('select-test-model',m.sessionId);await wait(async()=>{info=await call('manager.status',{botId:mb.id});return {ok:info.problem?.message.includes('模型缺少'),info};});
await wait(async()=>({ok:(await probe('inspect-session',m.sessionId)).status==='idle'}));
console.log(JSON.stringify({ok:true,botId:bot.id,taskId:task.id,managerBotId:mb.id,checks:['host default is not treated as an explicit session model selection','unselected Worker has no Run','unselected Manager keeps notifications and spends zero wakes','native Worker missing-credential failure is visible without raw provider text','native Manager missing-credential failure is visible','recovery never automatically retries']},null,2));
