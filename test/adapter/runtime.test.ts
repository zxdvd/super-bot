import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm';
import {configureRole} from '../../src/runtime.ts';
import {Config} from '../../src/index.ts';

test('fresh profiles can omit role overrides but incomplete model selections fail',()=>{
  const config=Config({});
  assert.equal(config.fullAccess,true);
  assert.equal(Config({fullAccess:false}).fullAccess,false);
  assert.equal(config.managerModel,undefined);
  assert.equal(config.workerModel,undefined);
  assert.throws(()=>Config({managerModel:{model:'sol'}}));
  assert.throws(()=>Config({workerModel:{provider:'test'}}));
  assert.deepEqual(Config({workerModel:{provider:'test',model:'sol'}}).workerModel,{provider:'test',model:'sol'});
});

test('full roles select independent models and the complete native permission preset',()=>{
  const selected:unknown[]=[],presets:unknown[]=[];
  const session={id:'role-session'};
  const ctx={permissionPresets:{set:(target:unknown,name:string)=>presets.push({target,name})}} as unknown as Context;
  const agent={session,model:{select:(value:unknown)=>selected.push(value)},ctx:new Proxy({}, {get(){throw Error('Native Agent context has no plugin service injection');}})} as unknown as Agent;
  const managerModel={provider:'test',model:'sol',reasoningEffort:ReasoningEffortId('medium')};
  const workerModel={provider:'test',model:'sol',reasoningEffort:ReasoningEffortId('xhigh')};
  configureRole(ctx,agent,'manager',{fullAccess:true,managerModel,workerModel});
  configureRole(ctx,agent,'worker',{managerModel,workerModel});
  assert.deepEqual(selected,[managerModel,workerModel]);
  assert.deepEqual(presets,[{target:session,name:'danger-full-access'},{target:session,name:'danger-full-access'}]);
});

test('legacy file roles leave native permissions and existing model selection alone',()=>{
  const agent={} as Agent,ctx={} as Context;
  assert.doesNotThrow(()=>configureRole(ctx,agent,'worker',{fullAccess:false}));
  assert.doesNotThrow(()=>configureRole(ctx,agent,'manager',{fullAccess:false}));
});

// Exercise the real dispatch branch as well as Config: callers can omit schema parsing.
import {mkdtempSync,realpathSync,rmSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';

for(const fullAccess of [undefined,true,false])test(`Worker dispatch uses native tools unless explicitly restricted (${fullAccess})`,async()=>{
  mkdirSync(resolve('.runtime'),{recursive:true});
  const directory=realpathSync(mkdtempSync(resolve('.runtime/access-dispatch-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'权限回归',instructions:'合成测试'});
  const task=store.createTask('task',{botId:bot.id,goal:'通过 Shell 运行本机 CLI',scope:'任务目录',acceptance:'报告命令输出',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,directory);store.confirmBinding(binding.id,binding.requestedSessionId);
  let mask:unknown,guard:(call:any)=>unknown=()=>{},message:any,finish!:()=>void;
  const hooks=new Map<string,Function>(),presets:string[]=[];
  const idle=new Promise<void>(resolve=>{finish=resolve;});
  const agent:any={id:binding.requestedSessionId,session:{id:binding.requestedSessionId},status:'idle',inbox:{nextTurn:[],nextStep:[],remove:()=>{}},
    ctx:{tools:{restrict:(value:unknown)=>{mask=value;return ()=>{};},guard:(fn:typeof guard)=>{guard=fn;return ()=>{};}},on:(name:string,fn:Function)=>{hooks.set(name,fn);return ()=>{};}},
    followup:(value:any)=>{message=value;agent.status='running';},whenIdle:()=>idle,cancel:()=>{agent.status='idle';finish();}};
  const ctx={permissionPresets:{set:(_session:unknown,preset:string)=>presets.push(preset)},sessionController:{resolveAgent:async()=>({agent})},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},workingDirectory:{get:()=>directory},jobs:{list:()=>[]},agents:{list:()=>[],isOwnedBy:()=>false}} as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess});
  try {
    const version=store.getTask(task.id).rowVersion;
    const run=await execution.dispatch('dispatch',task.id,version);
    assert.equal((await execution.dispatch('dispatch',task.id,version)).id,run.id);
    if(fullAccess===false) {
      assert.deepEqual(mask,{allow:['read','write','edit','super_bot_report']});assert.deepEqual(presets,[]);
      assert.match(String(guard({name:'bash'})),/Only task file tools/);assert.ok(hooks.has('agent/pre-step'));
      assert.match(String(guard({name:'write',arguments:{file_path:resolve(directory,'../outside')}})),/outside|目录/);
      assert.match(message.content[0].text,/Worker 完整权限未开启/);
    }else {
      assert.equal(mask,undefined);assert.deepEqual(presets,['danger-full-access']);assert.equal(hooks.has('agent/pre-step'),false);
      for(const name of ['bash','git','lark-cli','subagent','host_plugin_tool'])assert.equal(guard({name}),undefined);
      assert.match(message.content[0].text,/native Full Access preset/);
    }
    store.controlTask('takeover',task.id,store.getTask(task.id).rowVersion,'manual');
    assert.match(String(guard({name:'bash'})),/no longer/);
  }finally{agent.cancel();await execution.dispose();store.close();rmSync(directory,{recursive:true,force:true});}
});
