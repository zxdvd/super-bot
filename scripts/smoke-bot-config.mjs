/** Configuration snapshots exercised through the actual plugin and DSH model inputs. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile,unlink,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`bot-config:${randomUUID()}`;
async function raw(action,payload={}) {const r=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});return (await r.json()).result;}
async function call(action,payload={}){const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function probe(body){const r=await (await client.post('/api/super-bot-probe',body)).json();assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function wait(test,label){let state;for(let n=0;n<300;n++){state=await test();if(state.ok)return state;await delay(100);}assert.fail(`${label}: ${JSON.stringify(state)}`);}
async function quiet(botId,sessionId){await wait(async()=>{const s=await probe({action:'inspect-session',sessionId}),m=await call('manager.status',{botId});return {ok:s.status==='idle'&&!s.pending&&m.pending===0,s,m};},'manager quiet');}
await mkdir('.runtime/config-materials',{recursive:true});const path=resolve('.runtime/config-materials',`${randomUUID()}.md`);
await writeFile(path,'# Reference A\nSB_MATERIAL_A\n');
const create={requestId:prefix+':create',name:'配置快照探针',instructions:'保存原始职责 A',referencePaths:[path]};
const [bot,duplicate]=await Promise.all([call('bot.create',create),call('bot.create',create)]);assert.equal(bot.id,duplicate.id);assert.equal(bot.configRevision,1);
const taskDraft={botId:bot.id,goal:'生成合成文件并核对两项事实',scope:'专用任务目录',acceptance:'result.md 两项事实并回读',reviewPolicy:'human',startPaused:true};
const old=await call('task.create',{...taskDraft,requestId:prefix+':old'});
const manager=await call('manager.prepare',{botId:bot.id,requestId:prefix+':manager'});await probe({action:'select-test-model',sessionId:manager.sessionId});await quiet(bot.id,manager.sessionId);
await writeFile(path,'# Reference B\nSB_MATERIAL_B\n');
const update={requestId:prefix+':update',id:bot.id,expectedRevision:1,name:'配置快照探针 v2',instructions:'保存更新职责 B',referencePaths:[path]};
const [changed,changedAgain]=await Promise.all([call('bot.update',update),call('bot.update',update)]);assert.equal(changed.configRevision,2);assert.deepEqual(changedAgain,changed);assert.equal(changed.managerSessionId,null);
await unlink(path);assert.equal((await call('bot.update',update)).configRevision,2);
const current=await call('task.create',{...taskDraft,requestId:prefix+':current'});assert.equal(current.botConfigRevision,2);assert.equal((await call('task.detail',{id:old.id})).task.botConfigRevision,1);
await writeFile(path,'SB_MATERIAL_C\n');
async function runTask(task,expected,unexpected){
  const binding=await call('session.prepare',{requestId:prefix+':prepare:'+task.id,id:task.id,expectedRowVersion:task.rowVersion});await probe({action:'select-test-model',sessionId:binding.sessionId});
  let detail=await call('task.detail',{id:task.id});await call('task.control',{requestId:prefix+':resume:'+task.id,id:task.id,expectedRowVersion:detail.task.rowVersion,mode:'auto'});
  detail=await call('task.detail',{id:task.id});await call('task.dispatch',{requestId:prefix+':dispatch:'+task.id,id:task.id,expectedRowVersion:detail.task.rowVersion});
  await wait(async()=>{const d=await call('task.detail',{id:task.id});return {ok:d.task.lifecycle==='review',task:d.task};},'worker result');
  const state=await probe({action:'inspect-session',sessionId:binding.sessionId});assert.ok(state.materialMarkers.includes(expected),JSON.stringify(state));for(const marker of unexpected)assert.ok(!state.materialMarkers.includes(marker),JSON.stringify(state));return binding.sessionId;
}
const oldWorker=await runTask(old,'SB_MATERIAL_A',['SB_MATERIAL_B','SB_MATERIAL_C']);
const newWorker=await runTask(current,'SB_MATERIAL_B',['SB_MATERIAL_A','SB_MATERIAL_C']);
const archived=await probe({action:'native-prompt',sessionId:manager.sessionId,text:'MANAGER_PROBE：旧管理器不应创建任务。'});assert.deepEqual(archived.tools,[]);assert.equal((await call('task.list',{botId:bot.id})).total,2);
const next=await call('manager.prepare',{requestId:prefix+':next',botId:bot.id});await probe({action:'select-test-model',sessionId:next.sessionId});await quiet(bot.id,next.sessionId);
const state=await probe({action:'inspect-session',sessionId:next.sessionId});assert.ok(state.materialMarkers.includes('SB_MATERIAL_B'));assert.ok(!state.materialMarkers.includes('SB_MATERIAL_C'));
await writeFile(path,'# Reference B\nSB_MATERIAL_B\n');
const noChange=await call('bot.update',{...update,requestId:prefix+':noop',expectedRevision:2});assert.equal(noChange.configRevision,2);assert.equal(noChange.managerSessionId,next.sessionId);
const stale=await raw('bot.update',{...update,requestId:prefix+':stale'});assert.equal(stale.ok,false);assert.equal(stale.error.code,'version-conflict');
await writeFile(path,Buffer.from([0,255]));const invalid=await raw('bot.update',{...update,requestId:prefix+':invalid',expectedRevision:2});assert.equal(invalid.ok,false);assert.equal((await call('bot.list')).find(b=>b.id===bot.id).configRevision,2);
await writeFile(path,'# Reference B\nSB_MATERIAL_B\n');
const backlogBot=await call('bot.create',{requestId:prefix+':backlog',name:'启用前积压任务探针',instructions:'处理已有任务'});
const backlog=[];for(let n=0;n<3;n++)backlog.push(await call('task.create',{...taskDraft,botId:backlogBot.id,startPaused:false,requestId:prefix+':backlog:'+n}));
const backlogManager=await call('manager.prepare',{requestId:prefix+':backlog-manager',botId:backlogBot.id});await probe({action:'select-test-model',sessionId:backlogManager.sessionId});
await wait(async()=>{const p=await call('task.list',{botId:backlogBot.id});return {ok:p.items.length===3&&p.items.every(t=>t.lifecycle==='review'&&t.managerReviewed),tasks:p.items};},'all pre-existing tasks managed');
console.log(JSON.stringify({ok:true,botId:bot.id,oldTaskId:old.id,newTaskId:current.id,oldWorker,newWorker,managerSessionId:next.sessionId,referencePath:path,backlogBotId:backlogBot.id,checks:['concurrent create and update share durable receipts','accepted retry works after reference deleted','old and new task inputs retain A/B snapshots despite source C','archived manager loses tools','new manager receives saved B, never changed source C','no-op preserves manager','stale and invalid updates leave version unchanged','all three pre-existing tasks run after enabling manager']},null,2));
