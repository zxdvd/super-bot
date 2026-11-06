/** Real model pauses after reading an old task, then attempts its outdated command. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`manager-stale:${randomUUID()}`;
async function call(action,payload={}){const r=(await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function probe(action,sessionId,extra={}){const r=await(await client.post('/api/super-bot-probe',{action,sessionId,...extra})).json();assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function wait(check){let result;for(let n=0;n<250;n++){result=await check();if(result.ok)return result;await delay(100);}assert.fail(JSON.stringify(result));}
const results=[];
for(const mode of ['revise','native-dispatch','native-review']){
 const bot=await call('bot.create',{requestId:prefix+':bot:'+mode,name:'迟到管理命令 '+mode,instructions:'只处理合成文件'});
 let task=await call('task.create',{requestId:prefix+':task:'+mode,botId:bot.id,goal:mode==='native-review'?'MANAGER_STALE_REVIEW_PROBE':'MANAGER_STALE_PROBE',scope:'专用目录',acceptance:'两项事实并回读',reviewPolicy:'bot'});
 let binding;
 if(mode==='native-dispatch'){binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});await probe('select-test-model',binding.sessionId);}
 const manager=await call('manager.prepare',{requestId:prefix+':manager:'+mode,botId:bot.id});await probe('select-test-model',manager.sessionId);
 await wait(async()=>({ok:(await probe('inspect-session',manager.sessionId)).stalled}));
 try{
   const before=await call('task.detail',{id:task.id});task=before.task;
   if(mode==='revise'){
     task=await call('task.control',{requestId:prefix+':pause',id:task.id,expectedRowVersion:task.rowVersion,mode:'paused'});
     task=await call('task.revise',{requestId:prefix+':revise',id:task.id,expectedRowVersion:task.rowVersion,goal:'人工更新后的目标',scope:'专用目录',acceptance:'保留新目标'});
   }else{
     binding=before.binding;assert.ok(binding);
     await probe('queue-native',binding.sessionId,{text:'人工接管此任务，请暂时停止自动管理。'});
     await wait(async()=>({ok:(await call('task.detail',{id:task.id})).task.controlMode==='manual'}));
   }
   await probe('release-stalled-model',manager.sessionId);
   const native=await wait(async()=>{const s=await probe('inspect-session',manager.sessionId);return {ok:s.status==='idle'&&!s.pending,s};});
   const after=await call('task.detail',{id:task.id});
   const action=mode==='native-review'?'review':'dispatch';assert.ok(native.s.managerAttempts.some(a=>a.action===action&&a.taskId===task.id&&a.expectedRowVersion===before.task.rowVersion),JSON.stringify(native.s.managerAttempts));
   assert.notEqual(after.task.lifecycle,'completed');assert.equal(after.result?.humanAcceptedAt??null,null);
   if(mode==='native-review'){assert.equal(after.task.controlMode,'manual');assert.equal(after.task.lifecycle,'open');}
   else {assert.equal(after.run,null);if(mode==='revise'){assert.equal(after.task.goal,'人工更新后的目标');assert.equal(after.task.taskRevision,2);assert.equal(after.binding,null);}else assert.equal(after.task.controlMode,'manual');}
   results.push({mode,taskId:task.id,managerSessionId:manager.sessionId,attemptedAction:action,rejectedVersion:before.task.rowVersion,currentVersion:after.task.rowVersion});
 }finally{if((await probe('inspect-session',manager.sessionId)).stalled)await probe('release-stalled-model',manager.sessionId);}
}
console.log(JSON.stringify({ok:true,checks:['old dispatch after user goal edit cannot prepare a session or create a Run','native user takeover rejects delayed Manager dispatch','native user takeover rejects delayed Manager automatic acceptance'],results},null,2));
