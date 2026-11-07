import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm';
import {configureRole} from '../../src/runtime.ts';

test('full roles select independent models and the complete native permission preset',()=>{
  const selected:unknown[]=[],presets:unknown[]=[];
  const session={id:'role-session'};
  const ctx={permissionPresets:{set:(target:unknown,name:string)=>presets.push({target,name})}} as unknown as Context;
  const agent={session,model:{select:(value:unknown)=>selected.push(value)},ctx:new Proxy({}, {get(){throw Error('Native Agent context has no plugin service injection');}})} as unknown as Agent;
  const managerModel={provider:'test',model:'sol',reasoningEffort:ReasoningEffortId('medium')};
  const workerModel={provider:'test',model:'sol',reasoningEffort:ReasoningEffortId('xhigh')};
  configureRole(ctx,agent,'manager',{fullAccess:true,managerModel,workerModel});
  configureRole(ctx,agent,'worker',{fullAccess:true,managerModel,workerModel});
  assert.deepEqual(selected,[managerModel,workerModel]);
  assert.deepEqual(presets,[{target:session,name:'danger-full-access'},{target:session,name:'danger-full-access'}]);
});

test('legacy file roles leave native permissions and existing model selection alone',()=>{
  const agent={} as Agent,ctx={} as Context;
  assert.doesNotThrow(()=>configureRole(ctx,agent,'worker',{}));
  assert.doesNotThrow(()=>configureRole(ctx,agent,'manager',{fullAccess:false}));
});
