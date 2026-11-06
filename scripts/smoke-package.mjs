/** Black-box checks for a tarball-only install, without the developer probe plugin. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hostClient} from './host-client.mjs';
const mode=process.argv[2]??'prepare';assert.ok(['prepare','restored','retained'].includes(mode));
const client=await hostClient('.runtime/package-host.log');assert.equal(new URL(client.base).port,'3082');
async function raw(action,payload={}){return(await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;}
async function call(action,payload={}){const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
const record='.runtime/package-smoke.json';
if(mode==='prepare'){
 const prefix=`package:${randomUUID()}`,referencePath=resolve('.runtime/package-reference.md');await writeFile(referencePath,'SB_PACKAGE_REFERENCE_A\n');
 const bot=await call('bot.create',{requestId:prefix+':bot',name:'安装包生命周期验证',instructions:'仅合成文件；不配置真实模型',referencePaths:[referencePath]});
 const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'核对安装包与恢复流程',scope:'专用任务目录',acceptance:'保留任务与原生会话引用',reviewPolicy:'human'});
 const binding=await call('session.prepare',{requestId:prefix+':session',id:task.id,expectedRowVersion:task.rowVersion});
 const detail=await call('task.detail',{id:task.id});
 const blocked=await raw('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:detail.task.rowVersion});assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'model-required');assert.equal((await call('task.detail',{id:task.id})).run,null);
 const manager=await call('manager.prepare',{requestId:prefix+':manager',botId:bot.id});
 const backup=await call('backup.create',{requestId:prefix+':backup'});assert.deepEqual(await call('backup.create',{requestId:prefix+':backup'}),backup);assert.equal(backup.schema,7);
 const db=new DatabaseSync(backup.path,{readOnly:true});try{const saved=JSON.parse(db.prepare('SELECT botContext FROM tasks WHERE id=?').get(task.id).botContext);assert.equal(saved.materials[0].text,'SB_PACKAGE_REFERENCE_A\n');}finally{db.close();}
 await writeFile(referencePath,'SB_PACKAGE_REFERENCE_B\n');
 const saved={prefix,botId:bot.id,taskId:task.id,sessionId:binding.sessionId,managerSessionId:manager.sessionId,backup,backupHash:createHash('sha256').update(await readFile(backup.path)).digest('hex')};await writeFile(record,JSON.stringify(saved,null,2));
 console.log(JSON.stringify({ok:true,mode,botId:bot.id,taskId:task.id,backup:backup.path,checks:['tarball API creates persistent Bot and reference snapshot','missing model gives explicit error with no Run','native task and Manager sessions prepared','consistent backup contains saved reference A','backup request is idempotent']},null,2));
}else{
 const saved=JSON.parse(await readFile(record,'utf8'));const detail=await call('task.detail',{id:saved.taskId});assert.equal(detail.binding.sessionId,saved.sessionId);assert.equal(detail.run,null);
 assert.equal((await call('manager.status',{botId:saved.botId})).binding.sessionId,saved.managerSessionId);
 if(mode==='restored'){assert.equal(detail.task.controlMode,'paused');assert.equal(detail.task.status,'recovery');assert.equal((await call('manager.status',{botId:saved.botId})).pending,0);}
 assert.equal(createHash('sha256').update(await readFile(saved.backup.path)).digest('hex'),saved.backupHash);
 console.log(JSON.stringify({ok:true,mode,taskId:saved.taskId,sessionId:saved.sessionId,checks:['same Task and ordinary Session references','no model execution','original backup unchanged',mode==='restored'?'restored tasks paused and notifications not replayed':'uninstall/reinstall retained the original ledger']},null,2));
}
