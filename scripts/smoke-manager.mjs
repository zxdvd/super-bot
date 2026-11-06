import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`manager:${randomUUID()}`;
async function call(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});const r=(await response.json()).result;assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function probe(body){const response=await client.post('/api/super-bot-probe',body);const r=await response.json();assert.equal(r.ok,true,JSON.stringify(r));return r;}
const bot=await call('bot.create',{requestId:prefix+':b',name:'持久 Manager 探针',instructions:'管理合成文档任务，核对文件，默认人验收。'});
const manager=await call('manager.prepare',{requestId:prefix+':m',botId:bot.id});assert.equal(manager.state,'ready');
await probe({action:'select-test-model',sessionId:manager.sessionId});
const human=await call('task.create',{requestId:prefix+':human',botId:bot.id,goal:'由 Manager 安排文档',scope:'专用目录',acceptance:'两项事实并回读',reviewPolicy:'human'});
const auto=await call('task.create',{requestId:prefix+':auto',botId:bot.id,goal:'已授权自动验收的合成文档',scope:'专用目录',acceptance:'两项事实并回读',reviewPolicy:'bot'});
async function waitFor(test,label) {let state;for(let n=0;n<200;n++){state=await test();if(state.ok)return state;await delay(100);}assert.fail(`${label}: ${JSON.stringify(state)}`);}
await waitFor(async()=>{const h=await call('task.detail',{id:human.id}),a=await call('task.detail',{id:auto.id});return {ok:h.task.lifecycle==='review'&&h.task.managerReviewed&&a.task.lifecycle==='completed',human:h,auto:a};},'automatic event-driven management');
assert.equal((await call('task.detail',{id:auto.id})).result.humanAcceptedAt,null);
const ordinary=await probe({action:'native-prompt',sessionId:manager.sessionId,text:'你好，请简短介绍职责。'});
assert.deepEqual(ordinary.tools,['super_bot_manage']);assert.equal((await call('task.list',{botId:bot.id})).total,2);
await probe({action:'native-prompt',sessionId:manager.sessionId,text:'MANAGER_PROBE：请创建并安排一份合成说明。'});
await waitFor(async()=>{const page=await call('task.list',{botId:bot.id});return {ok:page.total===3&&page.items.filter(t=>t.lifecycle==='review').length===2,page};},'manager chat creation');
const foreignBot=await call('bot.create',{requestId:prefix+':foreign-b',name:'另一个 Bot',instructions:'不应被其他 Bot 读取'});
const foreign=await call('task.create',{requestId:prefix+':foreign-t',botId:foreignBot.id,goal:'隔离任务',scope:'专用目录',acceptance:'不可跨 Bot',reviewPolicy:'human'});
const refused=await probe({action:'native-prompt',sessionId:manager.sessionId,text:`CROSS_BOT:${foreign.id}`});assert.equal(refused.refused,true);
assert.equal((await call('task.detail',{id:foreign.id})).task.rowVersion,1);
await delay(1200);
const replacement=await call('manager.replace',{requestId:prefix+':replace',botId:bot.id,expectedGeneration:manager.generation});
assert.notEqual(replacement.sessionId,manager.sessionId);assert.equal(replacement.generation,2);
await delay(1200);
const oldSession=await probe({action:'native-prompt',sessionId:manager.sessionId,text:'MANAGER_PROBE：旧会话不能再创建任务。'});assert.deepEqual(oldSession.tools,[]);
assert.equal((await call('task.list',{botId:bot.id})).total,3);
assert.equal((await call('manager.status',{botId:bot.id})).binding.sessionId,replacement.sessionId);
console.log(JSON.stringify({ok:true,botId:bot.id,managerSessionId:replacement.sessionId,checks:['persistent manager receives events and dispatches worker','human policy remains review','explicit bot policy completes without humanAcceptedAt','ordinary conversation creates no task','manager conversation creates a durable task','manager sees only management tool and rejects another bot task','replacement restores ledger work and revokes old manager authority']},null,2));
