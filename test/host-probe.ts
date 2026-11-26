/** Deterministic adapter inside the real, isolated DSH host. Never shipped in lib/. */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter,LlmError, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-commands';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { DshExecution } from '../src/dsh.ts';
import { Managers } from '../src/manager.ts';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type {SessionStore} from '@deepseek-ai/dsh-session';
import { closeTask, ownerAcceptance, ownerAcceptanceConfirm, ownerConfirm, ownerDetach, ownerInspect, ownerNewGoal, ownerOldGoal, ownerPrepare,
  ownerRefuse, ownerRevise, ownerSessionTitle, stageArtifacts, stageGoal, stageRevoke, stageSupplement, stoppableGoal } from './stage-host-fixture.ts';
import { approveFixtureDeployment, approveRelease, confirmReleaseChoice, prepareRelease, releaseFixtureGoal,
  releaseStatusQuestion, restoreReleasePermission } from './gitlab-release-fixture.ts';
import { artifactDeliveryText, artifactEditReply, artifactGoal, artifactLinks, artifactPrimary, artifactPortProbeGoal, artifactPortProbeText, artifactReference,
  artifactRevision, replacementMr, supplementalDoc } from './delivery-link-fixture.ts';
import { deploymentEffectGoal, deploymentEffectRequest, deploymentProbe, deploymentRecoveryGoal, deploymentRecoveryRequest,
  effectRecoveryGoal, effectRecoveryRequest,
  permissionProbe, permissionRecoveryGoal, permissionRecoveryRequest, readRecoveryGoal, readRecoveryRequest,
  recoveryEffectName, recoveryEffectText, recoveryFileName, recoveryGoals } from './recovery-host-fixture.ts';
import { ambiguous, appendixFile, appendixScope, appendixValue, baselineFile, baselineValue, cancelWiring, clarify, imageBlocked, imageGoal, imageRequest, imageResult, imageScope,
  imageVersion, pauseWiring, pendingContinue, pendingGoal, pendingInitial, pendingRequest, pendingResult, pendingScope,
  preflightFile, preflightGoal, preflightRequest, preflightResult, preflightValue, receiptFile, receiptValue,
  req005Goals, startupContinue, startupGoal, startupRequest, startupResult, versionFile,
  wiringCancelled, wiringGoal, wiringPaused, wiringQuestion,
  wiringRequest } from './req005-host-fixture.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'super-bot-probe': { kind: 'super-bot-probe'; inputId: string };
  }
}
export const name = 'super-bot-probe';
export const inject = ['sessionPersistence','sessions','llm','tools','sessionController','workspaceRegistry','connection','agents','jobs','workingDirectory','sessionProjections','sessionTitle'];
const provider = 'super-bot-probe';
const toolName = 'super_bot_probe_report';
const scopedToolName='super_bot_scoped_probe';
type RequestMessage=GenerateOptions['messages'][number];
const messageText=(message:RequestMessage)=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('');
const lateJobGoal='LATE_JOB_RESEARCH_';
const lateJobProgress='已记录现状调研的基线。';
const lateJobReport='已读取原 Job 结果并写出选型报告，旧轮外部效果仍待核实。';
async function* probeText(text:string):AsyncIterable<StreamChunk> {
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text};
  yield {type:'block-end',index:0,block:{type:'text',text}};
  yield {type:'finish',reason:{kind:'stop'}};
}
async function* probeTool(name:string,payload:Record<string,unknown>):AsyncIterable<StreamChunk> {
  const id=ToolCallId(randomUUID()),args=JSON.stringify(payload);
  yield {type:'block-start',index:0,blockType:'tool-call'};
  yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};
  yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};
  yield {type:'finish',reason:{kind:'tool-calls'}};
}
type WorkerInput=Extract<RequestMessage,{role:'user'}> & {source:Extract<UserMessage['source'],{kind:'super-bot'}>};
const isWorkerInput=(message:RequestMessage):message is WorkerInput=>message.role==='user'&&message.source?.kind==='super-bot';

interface WorkerContextObservation {
  runId:string; inputId:string; previousRunIds:string[]; previousFullRunIds:string[];
  characters:number; bytes:number; taskInputBytes:number;
}

class ProbeAdapter extends LlmAdapter {
  calls: {sessionId?: string;purpose?:string;ids:string[];tools:string[];markers:string[]}[] = [];
  workerContexts=new Map<string,Map<string,WorkerContextObservation>>();
  approvalWrites=new Set<string>();
  readyWithJob=new Set<string>();
  scopedAttempts=new Map<string,number>();
  managerAttempts=new Map<string,Record<string,unknown>[]>();
  heldManagerInputs=new Set<string>();
  reliabilityHeld=new Set<string>();
  stalled=new Map<string,{release:()=>void;signal?:AbortSignal}>();
  async listModels() { return [{provider,id:'deterministic',name:'Super Bot 测试模型（无网络）'}]; }
  async resolveModel(p:string,m:string) { return {provider:p,id:m,name:m,context:{contextWindow:200000},defaultMaxTokens:1000}; }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.calls.push({sessionId:options.sessionId,purpose:options.purpose,ids:options.messages.flatMap(m=>m.id?[m.id]:[]),tools:(options.tools??[]).map(t=>t.name),markers:[...new Set(JSON.stringify(options.messages).match(/SB_MATERIAL_[A-Z0-9_]+/g)??[])]});
    if(options.purpose==='compaction') {
      const text='Synthetic checkpoint: earlier local work completed and no external action was requested.';
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};return;
    }
    const scopedInput=options.messages.findLast(message=>message.role==='user'&&(message.source?.kind==='user'||message.source?.kind==='super-bot'));
    if(scopedInput&&options.tools?.some(tool=>tool.name===scopedToolName)&&scopedInput.content.some(block=>block.type==='text'&&block.text.includes('SCOPED_TOOL_PROBE'))&&!options.messages.slice(options.messages.indexOf(scopedInput)+1).some(message=>message.content.some(block=>block.type==='tool-call'&&block.name===scopedToolName))) {
      if(options.sessionId)this.scopedAttempts.set(options.sessionId,(this.scopedAttempts.get(options.sessionId)??0)+1);
      const id=ToolCallId(randomUUID());yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name:scopedToolName,argumentsDelta:'{}'};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:scopedToolName,arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};return;
    }
    if(options.tools?.some(tool=>tool.name==='super_bot_manage')) {
      const trigger=options.messages.findLast(m=>m.role==='user'&&(m.source?.kind==='user'||m.source?.kind==='super-bot-manager'));
      const text=trigger?.content.filter(b=>b.type==='text').map(b=>b.text).join('')??'';
      const lateAppend=trigger?.source?.kind==='user'?text.match(/^LATE_JOB_APPEND ([a-f0-9-]{36}) /):null;
      const later=trigger?options.messages.slice(options.messages.indexOf(trigger)+1):[];
      if(text==='LATE_JOB_MANAGER_HOLD'&&options.sessionId) {
        await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
        this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
        yield* probeText('原生 Manager 测试暂停已解除。');return;
      }
      // These fixtures exercise the actual scoped native executor, not a mocked Shell result.
      const query=trigger?.source?.kind==='user'&&text==='请用 Shell 做一次只读查询，直接告诉我结果，不创建任务。';
      const noWait=trigger?.source?.kind==='user'&&text==='BOT_NOWAIT_PROBE';
      if(query||noWait) {
        const called=later.some(m=>m.content.some(b=>b.type==='tool-call'&&b.name==='bash'));
        const hasBash=options.tools?.some(tool=>tool.name==='bash');
        if(hasBash&&!called) {
          const id=ToolCallId(randomUUID()),args=JSON.stringify({description:'合成 Bot 查询/等待守卫验证',command:noWait?'sleep 1':"printf 'BOT_QUERY_OK\\n'",timeoutMs:1000});
          yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name:'bash',argumentsDelta:args};
          yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'bash',arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}};return;
        }
        const output=later.filter(m=>m.role==='tool').flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n');
        const reply=hasBash?`查询工具实际返回：${output}`:'Bot Shell 与 Worker 完整权限未开启，请将当前 profile 的 Super Bot config.fullAccess 设为 true，空闲后重载插件。';
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:reply};
        yield {type:'block-end',index:0,block:{type:'text',text:reply}};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const calls=later.flatMap(m=>m.content.filter(b=>b.type==='tool-call'&&b.name==='super_bot_manage'));
      const last=calls.at(-1);const prior=last?.type==='tool-call'?JSON.parse(last.arguments) as Record<string,unknown>:null;
      let value:Record<string,any>|undefined;
      for(const message of later.filter(m=>m.role==='tool'))for(const block of message.content)if(block.type==='text')try{value=JSON.parse(block.text);}catch{}
      const lateControl=trigger?.source?.kind==='user'&&/^请(暂停|恢复|关闭)「(LATE_JOB_RESEARCH_[A-Z]+)」的原计划。$/.exec(text);
      if(lateControl) {
        const verb=lateControl[1]!,goal=lateControl[2]!;
        const action=verb==='暂停'?'pause':verb==='恢复'?'resume':'close';
        const target=prior?.action==='list'&&value?.items?.find((item:{goal:string})=>item.goal===goal);
        if(!prior)yield* probeTool('super_bot_manage',{action:'list'});
        else if(target)yield* probeTool('super_bot_manage',{action:'detail',taskId:target.id});
        else if(prior.action==='detail'&&value?.task?.goal===goal)yield* probeTool('super_bot_manage',{
          action,taskId:value.task.id,expectedRowVersion:value.task.rowVersion,userInstruction:text,
        });
        else yield* probeText(value?.task?`已记录${verb}原任务的请求。`:'当前任务控制请求待核对。');
        return;
      }
      if(value?.task?.goal==='MANAGER_MODEL_FAILURE_PROBE')throw new LlmError('Synthetic missing credential; no provider request was made','MISSING_CREDENTIAL');
      if(value?.task?.goal==='MANAGER_TIME_PROBE') {
        await new Promise<void>(resolve=>{if(options.signal?.aborted)resolve();else options.signal?.addEventListener('abort',()=>resolve(),{once:true});});
        options.signal?.throwIfAborted();
      }
      const recoveryNotice=trigger?.source?.kind==='super-bot-manager'&&text.includes('Call inspect-recovery');
      const currentTask=value?.task;
      const recoveryTask=recoveryNotice&&currentTask&&['recovery','blocked'].includes(currentTask.status)
        &&[...recoveryGoals,...req005Goals].includes(currentTask.goal)?currentTask:undefined;
      const continuationNotice=trigger?.source?.kind==='super-bot-manager'&&text.includes('already has a saved owner follow-up');
      const pauseForFixture=recoveryTask&&prior?.action==='detail'&&recoveryGoals.includes(recoveryTask.goal)
        &&recoveryTask.goal!==effectRecoveryGoal;
      const challengeRecoveryScope=recoveryTask?.goal===readRecoveryGoal;
      const holdKey=`${options.sessionId}:${trigger?.id}`;
      if(!this.heldManagerInputs.has(holdKey)&&(pauseForFixture||value?.task?.goal==='MANAGER_HOLD_PROBE'||value?.task?.goal==='MANAGER_STALE_PROBE'||(value?.task?.goal==='MANAGER_STALE_REVIEW_PROBE'&&value.result))) {
        assert.ok(options.sessionId);
        this.heldManagerInputs.add(holdKey);
        await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
        this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
      }
      if(challengeRecoveryScope&&prior?.action==='list'&&!later.some(message=>message.content.some(block=>block.type==='tool-call'&&block.name==='bash'))) {
        const id=ToolCallId(randomUUID()),args=JSON.stringify({description:'合成恢复权限拒绝验证',command:'printf RECOVERY_GUARD_MUST_NOT_EXECUTE > recovery-guard-probe.txt',timeoutMs:1000});
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'tool-call-delta',index:0,id,name:'bash',argumentsDelta:args};
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'bash',arguments:args}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      let plan:Record<string,unknown>|null=null;
      const releaseFollowup=trigger?.source?.kind==='user'&&
        [approveRelease,approveFixtureDeployment,confirmReleaseChoice,releaseStatusQuestion,restoreReleasePermission].includes(text);
      if(releaseFollowup) {
        if(!prior){yield* probeTool('super_bot_manage',{action:'list'});return;}
        if(prior.action==='list') {
          const target=value?.items.find((item:{goal:string})=>item.goal.startsWith(releaseFixtureGoal));
          assert.ok(target);
          yield* probeTool('super_bot_manage',{action:'detail',taskId:target.id});return;
        }
        if(prior.action==='detail'&&value?.stage) {
          if(text===releaseStatusQuestion) {
            if(value.gitLabRelease&&!value.gitLabCurrentStatus&&prior.refreshGitLabRelease!==true) {
              yield* probeTool('super_bot_manage',{action:'detail',taskId:value.task.id,refreshGitLabRelease:true,
                expectedRowVersion:value.task.rowVersion});return;
            }
            yield* probeText(value.gitLabCurrentStatus?.detail??'正在核对阶段，正式作业尚未登记。');
            return;
          }
          const retry=text===restoreReleasePermission;
          const select=text===confirmReleaseChoice;
          const evidence=retry?value.gitLabRelease?.condition:undefined;
          const url=retry?null:new URL(value.stage.evidenceRef);
          const condition=evidence??{kind:'gitlab-merge',sourceOrigin:url!.origin,
            project:url!.pathname.slice(1).split('/-/')[0],number:Number(url!.pathname.split('/').at(-1))};
          yield* probeTool('super_bot_manage',{action:'advance_stage',taskId:value.task.id,runId:value.stage.runId,
            expectedRowVersion:value.task.rowVersion,nextStep:'运行已授权的正式发布作业',condition,userInstruction:text,
            gitLabRelease:{intent:retry?'retry':select?'select':'publish',
              ...(select?{jobName:value.stage.observation.releaseChoices[0]}:{}),
              ...(text===approveFixtureDeployment?{requiresJobName:true}:{})}});
          return;
        }
      }
      const remember=text.match(/^请把「(.+)」保存为以后的默认工作约定。$/);
      const delegate=text.match(/^请写一份合成说明 ([ABC])。(?:这一次请(.+))?$/);
      const workConvention=text.match(/^请核对这项任务的实际工作约定：([a-f0-9-]+)$/);
      const decision=text==='上次为什么选蓝色主题？'||text==='请查另一 Bot 的决策条目。';
      const convention=text==='现在默认工作约定是什么？';
      const editTarget=trigger?.source?.kind==='user'&&text.startsWith('请更新这项交付 ')
        ? text.match(/#super-bot-task=([a-f0-9-]+)&resultId=([a-f0-9-]+)/) : null;
      const namedRequest=trigger?.source?.kind==='user'
        ? [preflightRequest,imageRequest,wiringRequest,startupRequest,pendingRequest].indexOf(text) : -1;
      const stageFollowUp=trigger?.source?.kind==='user'&&(text===stageSupplement?'append':text===stageRevoke?'revoke':undefined);
      const continuationTarget=stageFollowUp?stageGoal:
        new Map([[imageScope,imageGoal],[startupContinue,startupGoal],[pendingContinue,pendingGoal],[pendingScope,pendingGoal],[appendixScope,pendingGoal]]).get(text);
      const namedFollowup=trigger?.source?.kind==='user' && (continuationTarget||[ambiguous,pauseWiring,cancelWiring,closeTask].includes(text));
      const wantedAction=continuationTarget?'continue':text===pauseWiring?'pause':text===closeTask?'close':'cancel';
      const wantedGoal=continuationTarget??(text===closeTask?stoppableGoal:wiringGoal);
      const lastResult=later.findLast(message=>message.role==='tool');
      const successfulTool=lastResult?.role==='tool'&&!lastResult.isError;
      const ownerAction=trigger?.source?.kind==='user'&&new Map([[ownerAcceptance,'accept'],[ownerAcceptanceConfirm,'accept'],[ownerRevise,'revise'],
        [ownerInspect,'session-inspect'],[ownerRefuse,'session-attach'],[ownerConfirm,'session-attach'],
        [ownerDetach,'session-detach'],[ownerPrepare,'session-prepare']]).get(text);
      if(ownerAction&&!prior) {
        plan={action:'list'};
      }else if(ownerAction&&prior?.action==='list') {
        const goal=ownerAction==='accept'?stageGoal:ownerAction==='revise'?ownerOldGoal:ownerNewGoal;
        const tasks=value?.items as {goal:string;id:string;lifecycle:string}[]|undefined;
        const selected=tasks?.find(item=>item.goal===goal&&(ownerAction!=='accept'||item.lifecycle==='review'));
        if(selected)plan={action:'detail',taskId:selected.id};
      }else if(ownerAction&&prior?.action==='detail'&&value?.task) {
        plan={action:ownerAction,taskId:value.task.id,expectedRowVersion:value.task.rowVersion,userInstruction:text,
          ...(ownerAction==='accept'?{resultId:value.result.id}:ownerAction==='revise'?{goal:ownerNewGoal}:
            ownerAction==='session-inspect'?{sessionQuery:ownerSessionTitle}:{})};
      }else if(namedRequest>=0&&!prior) {
        const goal=req005Goals[namedRequest];
        const scope=goal===preflightGoal?'只读 preflight.txt':goal===imageGoal?'当前合成任务目录内核对变更和版本':
          goal===startupGoal?'仅允许合成目录标记一次首启，随后只读核对 fixture 中具名 Deployment':
          goal===pendingGoal?'仅限只读任务目录中的同步基线及现有回执':'当前合成任务目录内核对接线';
        plan={action:'create',goal,scope,acceptance:'在原聊天报告实际状态和剩余阻塞'};
      }else if(namedFollowup&&!prior) {
        plan={action:'list'};
      }else if(namedFollowup&&prior?.action==='list') {
        const tasks=value?.items as {goal:string;id:string;lifecycle:string}[]|undefined;
        if(text===ambiguous) {
          const taskIds=tasks?.filter(item=>[imageGoal,wiringGoal].includes(item.goal)).map(item=>item.id);
          if(taskIds?.length===2)plan={action:'clarify',taskIds,followUp:'continue'};
        }else {
          const target=tasks?.find(item=>item.goal===wantedGoal&&(!stageFollowUp||item.lifecycle==='open'));
          if(target)plan={action:'detail',taskId:target.id};
        }
      }else if(namedFollowup&&prior?.action==='detail'&&value?.task?.goal===wantedGoal) {
        plan={action:wantedAction,taskId:value.task.id,expectedRowVersion:value.task.rowVersion,userInstruction:text,
          ...(stageFollowUp?{stageFollowUp,...(stageFollowUp==='append'?{continuationMode:'read-only'}:{})}:{}),
          ...([imageScope,pendingScope,appendixScope].includes(text)?{continuationMode:'read-only'}:{})};
      }else if(continuationNotice&&prior?.action==='detail'&&currentTask&&req005Goals.includes(currentTask.goal)) {
        plan={action:'continue',taskId:currentTask.id,expectedRowVersion:currentTask.rowVersion};
      }else if(trigger?.source?.kind==='user'&&(remember||delegate||decision||convention||workConvention)) {
        if(!prior) {
          if(remember)plan={action:'memory-save-convention',text:remember[1]};
          else if(delegate)plan={action:'create',goal:`MEMORY_WORK_${delegate[1]}`,...(delegate[2]?{conventionOverride:delegate[2]}:{})};
          else if(workConvention)plan={action:'detail',taskId:workConvention[1]};
          else plan={action:'memory-index'};
        }else if(prior.action==='memory-index') {
          const entry=convention?'work-convention.md':'decisions/theme.md';
          if(value?.markdown?.includes(`](${entry})`)||text==='请查另一 Bot 的决策条目。')plan={action:'memory-read',entry};
        }
        if(!plan) {
          const reply=value?.source?`${value.text}\n\n${value.source}`:JSON.stringify(value?.botContext?.workConvention??value??{});
          yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:reply};
          yield {type:'block-end',index:0,block:{type:'text',text:reply}};yield {type:'finish',reason:{kind:'stop'}};return;
        }
      }else if(challengeRecoveryScope&&prior?.action==='detail') {
        plan={action:'list'};
      }else if(recoveryTask&&['detail','list'].includes(String(prior?.action))) {
        plan={action:'inspect-recovery',taskId:recoveryTask.id};
      }else if(recoveryNotice&&prior?.action==='inspect-recovery'&&value?.status==='eligible') {
        plan={action:'recover-preflight',taskId:value.taskId,expectedRowVersion:value.rowVersion};
      }else if(recoveryNotice&&prior?.action==='recover-preflight'&&value?.status==='readable'&&currentTask?.goal===readRecoveryGoal
        &&calls.filter(call=>call.type==='tool-call'&&JSON.parse(call.arguments).action==='recover-preflight').length===1) {
        plan=prior;
      }else if(value?.task?.goal==='MANAGER_STEP_PROBE')plan={action:'detail',taskId:value.task.id};
      else if(!prior) {
        const foreign=text.match(/CROSS_BOT:([^\s]+)/)?.[1];
        if(lateAppend)plan={action:'detail',taskId:lateAppend[1]};
        else if(trigger?.source?.kind==='user'&&text.startsWith(lateJobGoal))plan={action:'create',goal:text,scope:'核实现状，形成选型报告。只在任务目录写合成报告。',acceptance:'报告来自原 Job 的确切结果和已保存基线。'};
        else if(trigger?.source?.kind==='user'&&text===readRecoveryRequest)plan={action:'create',goal:readRecoveryGoal,scope:`只读当前任务目录的 ${recoveryFileName}`,acceptance:'报告实际读取结果'};
        else if(trigger?.source?.kind==='user'&&text===effectRecoveryRequest)plan={action:'create',goal:effectRecoveryGoal,scope:`写入合成标记 ${recoveryEffectName}，并只读检查 ${recoveryFileName}`,acceptance:'报告已执行操作与实际读取结果'};
        else if(trigger?.source?.kind==='user'&&text===permissionRecoveryRequest)plan={action:'create',goal:permissionRecoveryGoal,scope:'只读核对 Kubernetes context synthetic 的 namespace fixture 中 get persistentvolumeclaims 权限',acceptance:'报告实际共享身份与权限结果'};
        else if(trigger?.source?.kind==='user'&&text===deploymentRecoveryRequest)plan={action:'create',goal:deploymentRecoveryGoal,scope:'只读核对 Kubernetes context synthetic 的 namespace fixture 下 Deployment fixture-deployment',acceptance:'报告实际共享身份与指定 Deployment 的最新状态'};
        else if(trigger?.source?.kind==='user'&&text===deploymentEffectRequest)plan={action:'create',goal:deploymentEffectGoal,scope:`在任务目录写入 ${recoveryEffectName}，并只读核对 Kubernetes context synthetic 的 namespace fixture 下 Deployment fixture-deployment`,acceptance:'报告已执行操作与指定 Deployment 的最新状态'};
        else if(trigger?.source?.kind==='user'&&text.startsWith(prepareRelease))plan={action:'create',
          goal:releaseFixtureGoal+' '+text.slice(prepareRelease.length),scope:'只操作该合成合并请求的发布作业',
          acceptance:'核对合成发布作业，在原聊天报告准确链接和已确认状态'};
        else if(trigger?.source?.kind==='user'&&text===stoppableGoal)plan={action:'create',goal:stoppableGoal,scope:'合成资料任务目录',acceptance:'资料整理完成'};
        else if(trigger?.source?.kind==='user'&&text===stageGoal)plan={action:'create',goal:stageGoal,scope:'在当前任务目录中生成目录、引用、附录和最终说明，只读核对 fixture/docs 的 42 号引用检查流水线',acceptance:'最终说明已生成并回读'};
        else if(foreign)plan={action:'detail',taskId:foreign};
        else if(trigger?.source?.kind==='user'&&text==='请用 Shell 运行本机命令，把合成检查结果保存成文件。')plan={action:'create',goal:'LOCAL_CLI_PROBE',scope:'只在任务目录运行合成 Shell 命令，不访问外部服务',acceptance:'result.md 内容为 LOCAL_CLI_OK'};
        else if(trigger?.source?.kind==='user'&&['DF14_RECEIPT_PROBE','MIRROR_PROGRESS_PROBE'].includes(text))plan={action:'create',goal:text,scope:'专用任务目录，不访问网络',acceptance:'result.md 包含两项合成事实并已回读'};
        else if(trigger?.source?.kind==='user'&&[artifactGoal,artifactPortProbeGoal].includes(text))plan={action:'create',goal:text,scope:'隔离合成链接和本地证据',acceptance:'报告明确的交付物和回读记录'};
        else if(editTarget)plan={action:'detail',taskId:editTarget[1]};
        else if(trigger?.source?.kind==='user'&&text.startsWith('DF14_SHOW_RESULT:'))plan={action:'detail',taskId:text.slice('DF14_SHOW_RESULT:'.length)};
        else if(trigger?.source?.kind==='user'&&(text.includes('MANAGER_PROBE')||text==='请写一份简短的说明，包含两项事实，完成后给我文件。'||text==='请写一份说明，先确认读者。'))plan={action:'create',goal:text.includes('先确认读者')?'ASK_PROBE':'Manager 生成合成说明',scope:'专用任务目录，不访问网络',acceptance:'result.md 包含两项事实并已回读'};
        else if(trigger?.source?.kind==='user'&&(text==='读者是新同事，保持简短。'||text==='再加一句结论。'))plan={action:'list'};
        else if(trigger?.source?.kind==='super-bot-manager'){const target=text.match(/\nTask: ([a-f0-9-]{36})\n/)?.[1];plan=target?{action:'detail',taskId:target}:{action:'list'};}
      }else if(prior.action==='list'&&value?.items) {
        const tasks=value.items as {id:string;rowVersion:number;status:string;controlMode:string;managerReviewed?:boolean}[];
        const feedback=trigger?.source?.kind==='user'&&(text==='读者是新同事，保持简短。'||text==='再加一句结论。');
        const target=feedback?tasks.find(t=>t.status===(text==='再加一句结论。'?'review':'needs-input')):undefined;
        const review=tasks.find(t=>t.status==='review'&&t.controlMode==='auto'&&!t.managerReviewed);
        const queued=tasks.find(t=>t.status==='unscheduled'&&t.controlMode==='auto');
        if(target)plan={action:'detail',taskId:target.id};else if(review)plan={action:'detail',taskId:review.id};else if(queued)plan={action:'dispatch',taskId:queued.id,expectedRowVersion:queued.rowVersion};
      }else if((['create','respond','rework'].includes(String(prior.action))||value?.prepared)&&value?.task&&!value?.run&&!value?.deferred)plan={action:'dispatch',taskId:value.task.id,expectedRowVersion:value.task.rowVersion};
      else if(prior.action==='detail'&&editTarget&&value?.deliveredResult?.id===editTarget[2]) {
        const links=text.includes(supplementalDoc)?{'飞书文档 · 联调纪要':supplementalDoc}:
          text.includes(replacementMr)?{'后端 MR':replacementMr,'飞书文档 · 联调方案':null}:null;
        if(links)plan={action:'update_delivery_links',taskId:value.task.id,resultId:editTarget[2],expectedRowVersion:value.task.rowVersion,links};
      }
      else if(prior.action==='detail'&&value?.task?.controlMode==='auto') {
        if(lateAppend&&value.task.goal.startsWith(lateJobGoal))plan={action:'continue',taskId:value.task.id,
          expectedRowVersion:value.task.rowVersion,userInstruction:text,continuationMode:'authorized-work',lateJobFollowUp:'append'};
        else if(trigger?.source?.kind==='user'&&text==='再加一句结论。'&&value.result)plan={action:'rework',taskId:value.task.id,expectedRowVersion:value.task.rowVersion,resultId:value.result.id};
        else if(trigger?.source?.kind==='user'&&text==='读者是新同事，保持简短。'&&value.pendingQuestions?.[0])plan={action:'respond',taskId:value.task.id,expectedRowVersion:value.task.rowVersion,attentionId:value.pendingQuestions[0].id};
        else if(value.task.goal===stageGoal&&value.stage?.state==='awaiting-decision') {
          const completed=stageArtifacts.find(item=>item.name===value.stage.name);
          assert.ok(completed);
          plan={action:'advance_stage',taskId:value.task.id,runId:value.stage.runId,expectedRowVersion:value.task.rowVersion,nextStep:completed.nextStep,
            ...(completed===stageArtifacts[1]?{condition:{kind:'gitlab-pipeline',sourceOrigin:value.stageObserver.origin,project:'fixture/docs',number:42}}:{})};
        }else if(value.result&&value.task.lifecycle==='review'&&!value.task.managerReviewed) {
          const rework=String(value.task.goal).includes('MANAGER_REWORK_LOOP')||(String(value.task.goal).includes('MANAGER_REWORK_PROBE')&&!JSON.stringify(value.files).includes('修订'));
          plan={action:'review',taskId:value.task.id,expectedRowVersion:value.task.rowVersion,resultId:value.result.id,verdict:rework?'rework':'accept',note:rework?'请补充修订说明后重新提交。':'已通过 detail 读取文件内容：含标题、两项事实，并有回读记录。默认提交用户最终验收。'};
        }else if(value.task.status==='unscheduled')plan={action:'dispatch',taskId:value.task.id,expectedRowVersion:value.task.rowVersion};
      }
      if(prior?.action==='review'&&value?.task?.goal==='DF14_RECEIPT_PROBE') {
        plan={action:'deliver',taskId:prior.taskId,resultId:prior.resultId,text:'已写入并回读合成事实，待你确认。'};
      }
      if(prior?.action==='review'&&[artifactGoal,artifactPortProbeGoal].includes(value?.task?.goal)) {
        const workerSummary=later.filter(m=>m.role==='tool').flatMap(m=>m.content).filter(b=>b.type==='text')
          .map(b=>{try{return JSON.parse(b.text).result?.summary??'';}catch{return '';}}).find(Boolean);
        const held=value?.task?.goal===artifactPortProbeGoal;
        const revised=held&&workerSummary?.startsWith(artifactRevision.text);
        const text=revised?artifactRevision.text:held?artifactPortProbeText:artifactDeliveryText;
        plan={action:'deliver',taskId:prior.taskId,resultId:prior.resultId,text};
      }
      if(plan) {
        if(options.sessionId){const attempts=this.managerAttempts.get(options.sessionId)??[];attempts.push(plan);this.managerAttempts.set(options.sessionId,attempts);}
        const id=ToolCallId(randomUUID()),args=JSON.stringify(plan);
        yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name:'super_bot_manage',argumentsDelta:args};
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'super_bot_manage',arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      const payloads=later.filter(m=>m.role==='tool').flatMap(m=>m.content.filter(b=>b.type==='text')
        .map(b=>{try{return JSON.parse(b.text);}catch{return null;}}));
      const detail=payloads.findLast(v=>v?.delivery);
      const inspected=payloads.findLast(v=>[imageGoal,pendingGoal].includes(v?.task?.goal)&&v.run?.finishedAt!==null);
      const reportSummary=inspected?.events?.filter((event:{kind:string})=>event.kind==='work.report')
        .map((event:{data:string})=>JSON.parse(event.data))
        .find((report:{runId:string})=>report.runId===inspected.run?.id)?.summary;
      const workerQuestion=value?.pendingQuestions?.[0];
      const clarification=value?.attentions?.find((a:any)=>a.kind==='input'&&a.state==='open'&&!a.id.startsWith('run:'));
      let reply='已核对当前状态。';
      if(value?.gitLabRelease)reply=value.gitLabRelease.detail+'\n'+value.gitLabRelease.url;
      else if(value?.task?.goal?.startsWith(releaseFixtureGoal)&&value.stage?.observation?.releaseChoices)reply=value.stage.observation.detail;
      else if(ownerAction&&prior?.action==='session-inspect'&&typeof value?.confirmationText==='string')reply=value.confirmationText;
      else if(ownerAction&&prior?.action===ownerAction&&typeof value?.confirmationText==='string')reply=value.confirmationText;
      else if(ownerAction&&prior?.action===ownerAction&&successfulTool)reply=ownerAction==='accept'?'已接受该成果。':'已完成此次操作。';
      else if(namedFollowup&&prior?.action==='clarify'&&successfulTool)reply=clarify;
      else if(namedFollowup&&prior?.action==='cancel'&&successfulTool&&value?.task?.lifecycle==='cancelled')reply=wiringCancelled;
      else if(namedFollowup&&prior?.action==='pause'&&successfulTool&&value?.task?.controlMode==='paused')reply=wiringPaused;
      else if((namedFollowup||continuationNotice)&&prior?.action==='continue'&&successfulTool)reply=value?.message??reply;
      else if(recoveryNotice&&prior?.action==='recover-preflight'&&successfulTool&&value?.excerpt?.includes(preflightValue))reply=preflightResult;
      else if(recoveryNotice&&prior?.action==='recover-preflight'&&successfulTool&&value?.effectUncertain
        &&value?.observed?.uid==='fixture-deployment-uid'&&value.observed.ready===false)reply=startupResult;
      else if([imageBlocked,imageResult,pendingInitial,pendingResult].includes(reportSummary)&&!namedFollowup)reply=reportSummary;
      else if(value?.task?.goal===wiringGoal&&workerQuestion)reply=workerQuestion.question;
      else if(trigger?.source?.kind==='user'&&text.startsWith('CHAT_LINK_MARKDOWN:'))reply=text.slice('CHAT_LINK_MARKDOWN:'.length);
      else if(trigger?.source?.kind==='user'&&text.startsWith('FEISHU_SMOKE_'))reply=`已收到 ${text}`;
      else if(prior?.action==='deliver'&&prior.text===artifactDeliveryText) {
        reply=later.findLast(m=>m.role==='tool')?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')??'';
      }
      else if(prior?.action==='update_delivery_links'&&value?.links)reply=artifactEditReply;
      else if(prior?.action==='deliver')reply='请查看上面的交付卡片。';
      else if(detail?.delivery&&(prior?.action==='review'||text.startsWith('DF14_SHOW_RESULT:'))) {
        reply=`等待你确认。\n${detail.delivery.chatMarkdown}`;
      }else if(workerQuestion)reply=`${workerQuestion.question}\n${workerQuestion.markdown}`;
      else if(clarification)reply=clarification.question;
      else if(prior?.action==='dispatch'||(prior?.action==='create'&&(value?.run||value?.deferred)))reply='已经开始处理，完成后我会回到这里交付。';
      else if(lateAppend&&prior?.action==='continue')reply=value?.message??reply;
      else if(value?.lateJobRecovery)reply=value.attentions.find((item:any)=>item.kind==='recovery'&&item.state==='open')?.question??reply;
      else if(value?.lateJobPriorEffects)reply=value.lateJobPriorEffects;
      else if(recoveryNotice&&prior?.action==='inspect-recovery'&&value?.status==='needs-human')reply=value.message;
      else if(recoveryNotice&&prior?.action==='recover-preflight') {
        reply=value?.message??value?.result?.message??reply;
        if(value?.effectUncertain)reply+=' 原操作是否产生该效果仍待核对。';
      }
      else if(trigger?.source?.kind==='user')reply='你好，我可以帮你安排文档工作。';
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:reply};
      yield {type:'block-end',index:0,block:{type:'text',text:reply}};yield {type:'finish',reason:{kind:'stop'}};return;
    }
    const latestInput=options.messages.findLast(m=>m.role==='user'&&(m.source?.kind==='super-bot'||m.source?.kind==='user'));
    const reliabilityInput=options.messages.filter(isWorkerInput).findLast(message=>messageText(message).includes('Goal: RELIABILITY_'));
    const workInput=reliabilityInput??(latestInput&&isWorkerInput(latestInput)?latestInput:undefined);
    if(latestInput?.source?.kind==='user'&&latestInput.content.some(block=>block.type==='text'&&block.text.includes('NATIVE_HOLD_PROBE'))) {
      assert.ok(options.sessionId);await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
      this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
    }
    if(workInput) {
      const body=messageText(workInput);
      const { taskId, runId, inputId }=workInput.source;
      const previous=options.messages.slice(0,options.messages.indexOf(workInput)).filter(isWorkerInput)
        .filter(message=>message.source.taskId===taskId);
      const previousFull=previous.filter(message=>/^Goal: /m.test(messageText(message)));
      const fullInput=previousFull.at(-1);
      const context=/^Goal: /m.test(body)?body:fullInput?messageText(fullInput):'';
      const goal=context.match(/^Goal: ([^\n]*)/m)?.[1]??'';
      const revised=body.includes('Additional user input (rework):');
      if(options.sessionId) {
        const observations=this.workerContexts.get(options.sessionId)??new Map<string,WorkerContextObservation>();
        if(!observations.has(runId))observations.set(runId,{runId,inputId,
          previousRunIds:previous.map(message=>message.source.runId),previousFullRunIds:previousFull.map(message=>message.source.runId),
          characters:[...body].length,bytes:Buffer.byteLength(body),taskInputBytes:previous.reduce((sum,message)=>sum+Buffer.byteLength(messageText(message)),Buffer.byteLength(body))});
        this.workerContexts.set(options.sessionId,observations);
      }
      if(goal.startsWith('RELIABILITY_HOLD')&&options.sessionId&&!this.reliabilityHeld.has(options.sessionId)) {
        this.reliabilityHeld.add(options.sessionId);
        await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
        this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
      }
      if(goal.startsWith('RELIABILITY_MISSING_REPORT')) {
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'block-end',index:0,block:{type:'text',text:'No report on purpose.'}};
        yield {type:'finish',reason:{kind:'stop'}};return;
      }
      if(goal.startsWith('MODEL_FAILURE_PROBE'))throw new LlmError('Synthetic missing credential; no provider request was made','MISSING_CREDENTIAL');
      if(goal.startsWith('UNRESPONSIVE_MODEL_PROBE')) {
        assert.ok(options.sessionId);
        await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
        this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
      }
      if(goal.startsWith('STOP_PROBE')) {
        await new Promise<void>(resolve=>{if(options.signal?.aborted)resolve();else options.signal?.addEventListener('abort',()=>resolve(),{once:true});});
        options.signal?.throwIfAborted();
      }
      // The dispatch line may carry a note after the path, e.g. "(private task directory). Work only inside it…".
      const cwd=context.match(/^Working directory: (.+?)(?: \([^)]*\)|\. Work only inside it;|$)/m)?.[1];assert.ok(cwd);
      const later=options.messages.slice(options.messages.indexOf(workInput)+1);
      const calls=later.flatMap(m=>m.content.filter(b=>b.type==='tool-call').map(b=>b.name));
      if(goal.startsWith(releaseFixtureGoal)) {
        const mr=goal.slice(releaseFixtureGoal.length+1);
        if(body.includes('Call super_bot_gitlab_play with no arguments')) {
          assert.ok(options.tools?.some(tool=>tool.name==='super_bot_gitlab_play'));
          assert.ok(!options.tools?.some(tool=>tool.name==='bash'));
          yield* probeTool('super_bot_gitlab_play',{});return;
        }
        const possiblyPlayed=new URL(mr).pathname.endsWith('/14');
        const executeOldShell=new URL(mr).pathname.endsWith('/11')||possiblyPlayed;
        if(executeOldShell&&!calls.includes('bash')) {
          const command=possiblyPlayed?'glab api --method POST projects/914/jobs/214/play':'printf "fixture\\n"';
          yield* probeTool('bash',{description:'普通合成工作',command,timeoutMs:1000});return;
        }
        yield* probeTool('super_bot_report',{kind:'stage',stage:'合成合并请求',evidenceRef:mr,
          summary:'合并请求准备完毕，等待正式发布授权。',checks:'已核对合成 MR 引用。'});return;
      }
      const file=join(cwd,'result.md');
      if(goal.startsWith(lateJobGoal)&&options.sessionId) {
        const latest=options.messages.findLast(message=>message.role==='user'&&
          ['tool-jobs','user','super-bot'].includes(String(message.source?.kind)));
        if(latest&&String(latest.source?.kind)==='tool-jobs') {
          await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
          this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
          yield* probeText('原生通知已消费。');return;
        }
        const marker=join(cwd,'job-marker.txt');
        if(!previous.length) {
          if(!calls.includes('super_bot_report')) {
            yield* probeTool('super_bot_report',{kind:'progress',summary:lateJobProgress});return;
          }
          if(!calls.includes('bash')) {
            yield* probeTool('bash',{description:'合成资料读取等待',run_in_background:true,
              command:"i=0; while [ ! -f release-late-job ]; do i=$((i+1)); [ $i -ge 1000 ] && exit 8; sleep .03; done; printf 'JOB_EFFECT_ONCE\\n' >> job-marker.txt; printf 'BASELINE_NATIVE_RESULT\\n'"});return;
          }
          await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
          this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
          yield* probeText('旧轮测试完成。');return;
        }
        assert.match(body,/effectUncertain":true/);
        assert.ok(body.includes(lateJobProgress));
        if(goal.endsWith('_RESTART'))assert.ok(body.includes('报告附上部署限制'));
        assert.ok(options.messages.some(message=>messageText(message).includes('BASELINE_NATIVE_RESULT')));
        assert.ok(!options.tools?.some(tool=>tool.name==='bash'));
        const folder=JSON.parse(body.split('Earlier attempt and observed facts (use as evidence): ')[1]!.split('\n')[0]!).outputDirectory;
        const output=join(folder,'research-report.md');
        if(!calls.includes('read')){yield* probeTool('read',{file_path:marker});return;}
        const writes=calls.filter(name=>name==='write').length;
        if(writes===0){yield* probeTool('write',{file_path:marker,content:'MUST NOT OVERWRITE'});return;}
        if(writes===1){
          assert.ok(later.some(message=>message.role==='tool'&&message.isError===true));
          yield* probeTool('write',{file_path:output,content:lateJobProgress+'\n'+lateJobReport+'\n'});return;
        }
        if(!calls.includes('super_bot_report')){
          yield* probeTool('super_bot_report',{kind:'ready',summary:lateJobReport,checks:'已回读原资料并生成选型报告。',files:[output]});return;
        }
        yield* probeText(lateJobReport);return;
      }
      if(goal.startsWith('READY_WITH_JOB_PROBE')&&options.sessionId)this.readyWithJob.add(options.sessionId);
      const approvalProbe=goal.startsWith('APPROVAL_PROBE');
      if(approvalProbe&&!calls.includes('write')&&options.sessionId)this.approvalWrites.add(options.sessionId);
      const hasAnswer=revised||[...previous,workInput].some(message=>messageText(message).includes('Additional user input (answer):'));
      const needsAnswer=goal.startsWith('ASK_PROBE')&&!hasAnswer;
      const localCli=goal.startsWith('LOCAL_CLI_PROBE');
      const progressProbe=goal.startsWith('MIRROR_PROGRESS_PROBE');
      const revisedArtifact=goal===artifactPortProbeGoal&&revised;
      const reportedArtifacts=goal===artifactGoal||goal===artifactPortProbeGoal;
      const artifactReport=reportedArtifacts ? (revisedArtifact?artifactRevision.text:'已核对合成交付物。') : null;
      const reportLinks=reportedArtifacts ? (revisedArtifact?artifactRevision.links:artifactLinks) : undefined;
      const revisedReceipt=goal.startsWith('DF14_RECEIPT_PROBE')&&revised;
      const reports=progressProbe?later.flatMap(m=>m.content.flatMap(b=>b.type==='tool-call'&&b.name==='super_bot_report'?[JSON.parse(b.arguments).kind]:[])):[];
      if(req005Goals.includes(goal)&&goal!==startupGoal) {
        let plan:{name:string;args:Record<string,unknown>}|undefined;
        const first=previous.length===0;
        const name=goal===imageGoal?versionFile:goal===pendingGoal?(first?baselineFile:receiptFile):preflightFile;
        const path=join(cwd,name);
        const read=later.flatMap(message=>message.content)
          .find(block=>block.type==='tool-call'&&block.name==='read');
        const receipt=read?.type==='tool-call'
          ? later.find(message=>message.role==='tool'&&message.toolCallId===read.id) : undefined;
        const holdKey=`req005:${options.sessionId}:${runId}`;
        const hold=first&&(([imageGoal,pendingGoal].includes(goal)&&!receipt)||(goal===preflightGoal&&receipt?.role==='tool'&&receipt.isError));
        if(hold&&!this.heldManagerInputs.has(holdKey)) {
          assert.ok(options.sessionId);this.heldManagerInputs.add(holdKey);
          await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
          this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
        }
        if(!calls.includes('super_bot_report')) {
          if(goal===wiringGoal)plan={name:'super_bot_report',args:{kind:'waiting',summary:wiringQuestion}};
          else if(goal===pendingGoal&&first&&process.platform==='darwin'&&!calls.includes('super_bot_query')) {
            plan={name:'super_bot_query',args:{kind:'git-working-tree-status'}};
          }else if(!receipt) {
            if(!first)assert.ok(body.includes(goal===imageGoal?imageScope:pendingScope),body);
            if(!first&&goal===pendingGoal)assert.ok(body.includes(appendixScope),body);
            plan={name:'read',args:{file_path:path}};
          }else {
            assert.ok(receipt.role==='tool');
            const observed=messageText(receipt);
            if(goal===preflightGoal&&first) {
              assert.equal(receipt.isError,true,observed);
              plan={name:'super_bot_report',args:{kind:'failed',summary:'首发预检文件尚不可读，本轮已结束。',checks:observed}};
            }else {
              assert.equal(receipt.isError??false,false,observed);
              const expected=goal===imageGoal?imageVersion:first?baselineValue:receiptValue;
              assert.ok(observed.includes(expected),observed);
              if(goal===pendingGoal&&!first) {
                const appendixRead=later.flatMap(message=>message.content).find(block=>block.type==='tool-call'&&block.name==='read'&&JSON.parse(block.arguments).file_path===join(cwd,appendixFile));
                const appendix=appendixRead?.type==='tool-call'&&later.find(message=>message.role==='tool'&&message.toolCallId===appendixRead.id);
                if(appendix)assert.ok(appendix.role==='tool'&&!appendix.isError&&messageText(appendix).includes(appendixValue));
                else plan={name:'read',args:{file_path:join(cwd,appendixFile)}};
              }
              const summary=goal===imageGoal?(first?imageBlocked:imageResult):(first?pendingInitial:pendingResult);
              plan??={name:'super_bot_report',args:{kind:'blocked',summary,checks:observed}};
            }
          }
        }
        if(!plan) {
          yield {type:'finish',reason:{kind:'stop'}};return;
        }
        const id=ToolCallId(randomUUID()),args=JSON.stringify(plan.args);
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'tool-call-delta',index:0,id,name:plan.name,argumentsDelta:args};
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name:plan.name,arguments:args}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      const recoveryRead=[readRecoveryGoal,effectRecoveryGoal].includes(goal);
      const clusterProbe=goal===permissionRecoveryGoal?permissionProbe:[deploymentRecoveryGoal,deploymentEffectGoal,startupGoal].includes(goal)?deploymentProbe:null;
      const preflightReport=(()=>{
        if(!recoveryRead&&!clusterProbe)return null;
        const tool=clusterProbe?'super_bot_preflight':'read';
        const call=later.flatMap(message=>message.content).findLast(block=>block.type==='tool-call'&&block.name===tool);
        if(!call||call.type!=='tool-call')return null;
        const result=later.find(message=>message.role==='tool'&&message.toolCallId===call.id);
        assert.ok(result?.role==='tool');
        if(clusterProbe)assert.equal(result.isError??false,false,messageText(result));
        else assert.equal(result.isError,true,messageText(result));
        return messageText(result);
      })();
      const beforeStartupReport=goal===startupGoal&&preflightReport&&!calls.includes('super_bot_report');
      const startupBarrier=`req005-startup:${options.sessionId}:${runId}`;
      if(beforeStartupReport&&!this.heldManagerInputs.has(startupBarrier)) {
        assert.ok(options.sessionId);this.heldManagerInputs.add(startupBarrier);
        await new Promise<void>(release=>this.stalled.set(options.sessionId!,{release,signal:options.signal}));
        this.stalled.delete(options.sessionId);options.signal?.throwIfAborted();
      }
      const checkpoint=goal===stageGoal?stageArtifacts[previous.length]:undefined;
      if(goal===stageGoal&&previous.length)assert.ok(body.includes(stageArtifacts[previous.length-1].nextStep),body);
      const checkpointFile=checkpoint?join(cwd,checkpoint.filename):undefined;
      const checkpointCall=later.flatMap(message=>message.content).find(block=>block.type==='tool-call'&&block.name==='read');
      const checkpointRead=checkpointCall?.type==='tool-call'&&later.find(message=>message.role==='tool'&&message.toolCallId===checkpointCall.id);
      const planned=checkpoint&&checkpointFile?
        (!calls.includes('write')?{name:'write',args:{file_path:checkpointFile,content:checkpoint.contents}}:
         !calls.includes('read')?{name:'read',args:{file_path:checkpointFile}}:
         !calls.includes('super_bot_report')&&checkpointRead&&messageText(checkpointRead).includes(checkpoint.contents)?
            {name:'super_bot_report',args:{kind:'stage',stage:checkpoint.name,evidenceRef:checkpoint.filename,
              summary:checkpoint.contents,checks:'已回读 '+checkpoint.filename}}:null):
        [effectRecoveryGoal,deploymentEffectGoal,startupGoal].includes(goal)&&!calls.includes('write')
        ?{name:'write',args:{file_path:join(cwd,recoveryEffectName),content:recoveryEffectText}}
        :clusterProbe&&!preflightReport?{name:'super_bot_preflight',args:clusterProbe}
        :recoveryRead&&!preflightReport?{name:'read',args:{file_path:join(cwd,recoveryFileName)}}
        :preflightReport?(calls.includes('super_bot_report')?null:{name:'super_bot_report',args:{kind:clusterProbe?'blocked':'failed',
          summary:goal===startupGoal?'合成首启等待超时，首次只读回读未找到实例。':'预检未完成，当前轮结束。',checks:preflightReport}})
        :progressProbe&&!reports.includes('progress')?{name:'super_bot_report',args:{kind:'progress',summary:'MIRROR_NATIVE_PROGRESS'}}:
        localCli&&!calls.includes('bash')?{name:'bash',args:{description:"生成本机 Shell 合成检查结果",command:"printf 'LOCAL_CLI_OK\\n' > result.md"}}:goal.startsWith('STEP_BUDGET_PROBE')?{name:'read',args:{file_path:join(cwd,'missing-budget-probe.txt')}}:approvalProbe&&calls.includes('write')&&!existsSync(file)&&!calls.includes('super_bot_report')?{name:'super_bot_report',args:{kind:'failed',summary:'审批路径结束，写入没有生成文件；请核对原生审批结果。'}}:
        needsAnswer&&!calls.includes('super_bot_report')?{name:'super_bot_report',args:{kind:'waiting',summary:'请说明文档面向谁？'}}:
        !localCli&&!calls.includes('write')?{name:'write',args:{file_path:goal.startsWith('RELATIVE_PATH_PROBE')?'result.md':file,content:'# 合成成果\n\n事实一：这份文档由隔离测试模型生成。\n事实二：测试没有访问网络或使用模型凭证。\n'+(revised?'\n修订：已按返工要求补充说明。\n':'')+(goal.startsWith('LARGE_RESULT_PROBE')?'\n'+'x'.repeat(16000):'')+
           (goal.startsWith('MEMORY_WORK_A')?'\n蓝色主题便于区分合成环境。\n合成归档按季度组织。\n':'')}}:
        !calls.includes('read')?{name:'read',args:{file_path:file}}:
        (progressProbe?!reports.includes('ready'):!calls.includes('super_bot_report'))?{name:'super_bot_report',args:{kind:'ready',summary:artifactReport??(localCli?'已执行本机 Shell 并生成合成结果。':revisedReceipt?'已提交合成说明的修订版。':'已生成并回读两项事实的说明文件。'),checks:revisedArtifact?artifactRevision.checks:artifactReport?`已回读合成证据。参考资料：[方案模板](${artifactReference})。`:localCli?'原生 bash 执行后已 read 回读 LOCAL_CLI_OK。':revisedReceipt?'已回读修订版新增的结论。':'result.md 包含标题和两项事实；已用原生 read 工具回读核对。',files:[file],...(reportLinks&&{links:reportLinks}),...(reportedArtifacts&&!revisedArtifact&&{primaryLink:artifactPrimary})}}:null;
      if(planned) {
        const id=ToolCallId(randomUUID()),args=JSON.stringify(planned.args);
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'tool-call-delta',index:0,id,name:planned.name,argumentsDelta:args};
        yield {type:'block-end',index:0,block:{type:'tool-call',id,name:planned.name,arguments:args}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
    }
    const lastUser = options.messages.filter(m=>m.role==='user'&&m.source?.kind==='super-bot-probe').at(-1);
    const text = lastUser?.content.filter(b=>b.type==='text').map(b=>b.text).join('') ?? '';
    const userIndex=options.messages.indexOf(lastUser!);
    const alreadyCalled = options.messages.slice(userIndex+1).some(m=>m.role==='tool');
    if (text.includes('CALL_REPORT') && !alreadyCalled) {
      const id=ToolCallId(randomUUID());
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name:toolName,argumentsDelta:'{}'};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:toolName,arguments:'{}'}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:'Deterministic probe response.'};
    yield {type:'block-end',index:0,block:{type:'text',text:'Deterministic probe response.'}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}

function input(text:string) { return createUserMessage({content:[{type:'text',text}],source:{kind:'super-bot-probe',inputId:randomUUID()}}); }
async function bounded<T>(promise:Promise<T>,label:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timeout: ${label}`)),15000);})]); }
  finally { clearTimeout(timer!); }
}

export function apply(ctx:Context) {
  // This fixture refuses to start under the user's normal home.
  const home=process.env.DSH_HOME;
  if (!home?.endsWith('/super-bot/.runtime/dsh')) throw new Error('Probe requires the dedicated Super Bot test home');
  const adapter=new ProbeAdapter();
  const scopedCalls=new Map<string,number>();
  const crashArms=new Map<string,string>(),crashHeld=new Set<string>();
  // Test-only barrier: the persistence listener still flushes in parallel, but
  // the adapter's awaited flush cannot return before this process is killed.
  ctx.on('session/flush',async session=>{
    if(crashArms.get(session.id)==='end-durable'&&session.snapshotEvents().some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed')) {
      crashHeld.add(session.id);await new Promise<void>(()=>{});
    }
  });
  const readyJobs=new Map<string,{id:ReturnType<Context['jobs']['start']>;finish:(outcome:JobOutcome)=>void}>();
  // The dev home is nested in the source repository. Bound native turn diffs to
  // each synthetic workspace, so concurrent product edits are not attributed to it.
  ctx.on('agent/created',async({agent})=>{
    const cwd=agent.session.header.cwd;
    if(cwd?.startsWith(join(home!,'super-bot')+'/')&&!existsSync(join(cwd,'.git')))await promisify(execFile)('git',['init','--quiet','--template=','--initial-branch=main',cwd],{timeout:5000,maxBuffer:65536});
  });
  ctx.effect(()=>ctx.llm.registerAdapter([provider],adapter));
  ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name==='write'&&exec.agent&&adapter.approvalWrites.delete(exec.agent.id))return {kind:'ask',reason:'Super Bot 合成审批探针：仅在本任务目录写入 result.md，不访问网络。'};
    if(exec.name==='super_bot_report'&&exec.agent&&adapter.readyWithJob.delete(exec.agent.id)) {
      let finish!:(outcome:JobOutcome)=>void;
      const id=ctx.jobs.start({kind:'bash',label:'Ready but background effect unsettled (synthetic, no process)',owner:exec.agent.id,run:()=>({cancel:()=>{},done:new Promise<JobOutcome>(resolve=>{finish=resolve;})})});
      readyJobs.set(exec.agent.id,{id,finish});
    }
    return next();
  });
  const allowed=new Set<string>(); const executed:string[]=[];
  ctx.effect(()=>ctx.tools.register({name:toolName,description:'Synthetic identity probe; no external effects.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>[{type:'text',text:'Probe accepted'}]},
    async execute(_args,exec){assert.ok(exec.agent);assert.ok(allowed.has(exec.agent.id));executed.push(exec.agent.id);exec.concludeTurn();return {ok:true};},
  },{when:({agent})=>allowed.has(agent.id)}));
  let running=false;
  async function run() {
    if(running) throw new Error('Probe already running');
    running=true; const agents:Agent[]=[]; const checks:string[]=[];
    try {
      const cwd=join(home!,'super-bot','contract-probes'); await mkdir(cwd,{recursive:true});
      const workspace=await ctx.workspaceRegistry.create(cwd,'Super Bot 契约探针');
      async function makeAgent() {
        const {sessionId}=await ctx.sessionController.create({workspaceId:workspace.id});
        const resolved=await ctx.sessionController.resolveAgent(sessionId);
        if('error' in resolved) throw new Error(JSON.stringify(resolved.error));
        const agent=resolved.agent;agents.push(agent);agent.model.select({provider,model:'deterministic'});
        // Prevent accidental calls to unrelated tools even if the fixture is edited incorrectly.
        agent.ctx.tools.restrict({allow:[toolName]}); return agent;
      }
      const worker=await makeAgent();allowed.add(worker.id);
      const message=input('Identity roundtrip');
      worker.send(message,'next-turn',false);
      assert.equal(worker.inbox.nextTurn[0]?.id,message.id);
      assert.equal(worker.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===message.id).length,0);
      checks.push('queued input is not consumed');
      // Wake through a distinct message: the parked message must retain its original identity.
      worker.followup(input('Wake queued input'));
      await bounded(worker.whenIdle(),'identity roundtrip');
      const consumed=worker.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===message.id);
      assert.equal(consumed.length,1);
      assert.deepEqual(consumed[0]?.data,message);
      assert.ok(adapter.calls.some(c=>c.sessionId===worker.id&&c.ids.includes(message.id)));
      checks.push('message id and source survive inbox, session log, and model request');
      worker.followup(input('CALL_REPORT'));await bounded(worker.whenIdle(),'worker report');
      assert.equal(executed.filter(id=>id===worker.id).length,1);
      assert.ok(adapter.calls.some(c=>c.sessionId===worker.id&&c.tools.includes(toolName)));
      checks.push('worker tool executes with native agent identity');
      const outsider=await makeAgent();outsider.followup(input('CALL_REPORT'));
      await bounded(outsider.whenIdle(),'unauthorized tool attempt');
      assert.ok(adapter.calls.some(c=>c.sessionId===outsider.id), JSON.stringify(outsider.session.snapshotEvents()));
      assert.ok(adapter.calls.filter(c=>c.sessionId===outsider.id).every(c=>!c.tools.includes(toolName)));
      assert.equal(executed.filter(id=>id===outsider.id).length,0);
      assert.ok(outsider.session.snapshotEvents().some(e=>e.type==='tool/result'), JSON.stringify(outsider.session.snapshotEvents()));
      checks.push('another session cannot see or dispatch the worker tool');
      const child=await worker.ctx.agents.create({sessionId:SessionId(`session-${randomUUID()}`),parentAgent:worker,meta:{cwd,parentSession:worker.id,origin:'subagent',delegationDepth:1},agentOptions:{provider,model:'deterministic'}});
      try {
        assert.equal(ctx.agents.isOwnedBy(child.agent.id,worker),true);
        child.agent.followup(input('CALL_REPORT'));await bounded(child.agent.whenIdle(),'child unauthorized report');
        assert.ok(adapter.calls.some(c=>c.sessionId===child.agent.id));
        assert.ok(adapter.calls.filter(c=>c.sessionId===child.agent.id).every(c=>!c.tools.includes(toolName)));
        assert.equal(executed.filter(id=>id===child.agent.id).length,0);
        checks.push('child agent inherits restrictions but cannot acquire root report authority');
      }finally{await child.dispose();}
      let finishJob!:(result:JobOutcome)=>void;let cancelRequested=false;
      const jobId=ctx.jobs.start({kind:'bash',label:'Synthetic deferred settlement (no process)',owner:worker.id,
        run:()=>({cancel:()=>{cancelRequested=true;},done:new Promise<JobOutcome>(resolve=>{finishJob=resolve;})})});
      try {
        await worker.whenIdle();assert.equal(ctx.jobs.get(jobId,worker.id).status,'running');
        assert.equal(ctx.jobs.kill(jobId,worker.id,'probe'),'requested');assert.equal(cancelRequested,true);
        assert.equal(ctx.jobs.get(jobId,worker.id).status,'stopping');
        finishJob({status:'killed'});assert.equal((await ctx.jobs.wait(jobId,1000,worker.id)).status,'killed');
        checks.push('agent idle and job cancel receipt do not imply background work has settled');
      }finally{finishJob({status:'killed'});}
      const paused=await makeAgent();
      let entered!:()=>void;const atPreparation=new Promise<void>(resolve=>{entered=resolve;});
      const unhook=paused.ctx.on('agent/pre-step',async(payload,next)=>{
        entered();await new Promise<void>(resolve=>{if(payload.signal.aborted)resolve();else payload.signal.addEventListener('abort',()=>resolve(),{once:true});});
        payload.signal.throwIfAborted();return next();
      });
      const preparing=input('Cancel while preparing');paused.followup(preparing);
      await bounded(atPreparation,'preparation entry');
      const queued=input('Pending plugin input');const human=input('Preserve other producer input');
      paused.send(queued,'next-turn',false);paused.send(human,'next-turn',false);
      paused.cancel({kind:'user'},{keepInbox:true});await bounded(paused.whenIdle(),'preparation cancellation');unhook();
      assert.equal(paused.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===preparing.id).length,0);
      // rc.1 removes the claimed ordinary input before pre-step and does NOT restore it.
      // Absence from inbox therefore cannot mean consumed, even with keepInbox=true.
      assert.equal([...paused.inbox.nextTurn,...paused.inbox.nextStep].some(m=>m.id===preparing.id),false);
      assert.ok(paused.inbox.nextTurn.some(m=>m.id===queued.id));
      checks.push('LIMITED: cancelled claimed input is absent from inbox and has no user/message; recovery must not infer consumption');
      assert.equal(paused.inbox.remove(queued.id),true);
      assert.ok(paused.inbox.nextTurn.some(m=>m.id===human.id));
      checks.push('targeted input removal preserves unrelated input');
      // The test has no reason to execute this remaining synthetic message.
      paused.inbox.remove(human.id);
      const ledgerPath=join(home!,'super-bot',`binding-probe-${randomUUID()}.sqlite`);
      let ledger=new Store(ledgerPath);
      try {
        const bot=ledger.createBot('b',{name:'Contract probe',instructions:'Synthetic only'});
        const task=ledger.createTask('t',{botId:bot.id,goal:'Lost session receipt',scope:'probe directory',acceptance:'one session',reviewPolicy:'human'});
        const binding=ledger.beginBinding('prepare',task.id,1,cwd);
        assert.equal(ledger.claimBindingCreation(binding.id),true);
        const created=await ctx.sessionController.create({workspaceId:workspace.id,sessionId:SessionId(binding.requestedSessionId)});
        assert.equal(created.sessionId,binding.requestedSessionId);
        // Deliberately drop the successful receipt before persisting it, then reopen the ledger.
        ledger.close();ledger=new Store(ledgerPath);
        assert.equal(ledger.claimBindingCreation(binding.id),false);
        const execution=new DshExecution(ctx,ledger,join(home!,'super-bot'),{fullAccess:false});
        const recovered=await execution.reconcileBinding(binding.id);
        assert.equal(recovered.sessionId,created.sessionId);assert.equal(recovered.state,'ready');
        assert.deepEqual(await execution.reconcileBinding(binding.id),recovered);
        assert.equal(ledger.db.prepare('SELECT count(*) AS n FROM bindings').get()?.n,1);
        checks.push('lost session-create receipt reconciles the preassigned session after ledger restart');
      }finally{ledger.close();}
      const faultLedger=new Store(join(home!,'super-bot',`receipt-probe-${randomUUID()}.sqlite`));
      let calls=0;let execution:DshExecution|undefined;
      try {
        const bot=faultLedger.createBot('b',{name:'Receipt loss',instructions:'Synthetic only'});
        const task=faultLedger.createTask('t',{botId:bot.id,goal:'Receipt loss probe',scope:'Dedicated files only',acceptance:'Do not duplicate delivery',reviewPolicy:'human'});
        const facade=new Proxy(ctx,{get(target,key){
          if(key==='sessionController')return new Proxy(target.sessionController,{get(controller,method){
            if(method==='resolveAgent')return async(id:SessionId)=>{
              const resolved=await controller.resolveAgent(id);if('error' in resolved)return resolved;
              return {agent:new Proxy(resolved.agent,{get(agent,field){
                if(field==='followup')return (message:Parameters<Agent['followup']>[0])=>{calls++;agent.followup(message);throw new Error('Synthetic receipt lost after acceptance');};
                const value=Reflect.get(agent,field,agent);return typeof value==='function'?value.bind(agent):value;
              }})};
            };
            const value=Reflect.get(controller,method,controller);return typeof value==='function'?value.bind(controller):value;
          }});
          return Reflect.get(target,key,target);
        }});
        execution=new DshExecution(facade,faultLedger,join(home!,'super-bot','receipt-probes'),{fullAccess:false});
        const binding=await execution.prepareSession('prepare',task.id,task.rowVersion);
        const resolved=await ctx.sessionController.resolveAgent(SessionId(binding.sessionId!));assert.ok('agent' in resolved);resolved.agent.model.select({provider,model:'deterministic'});
        const version=faultLedger.getTask(task.id).rowVersion;
        await assert.rejects(execution.dispatch('dispatch',task.id,version),/receipt lost/);
        await bounded(resolved.agent.whenIdle(),'receipt-loss cancellation');
        const first=faultLedger.latestRun(task.id)!;assert.equal(first.state,'interrupted');assert.equal(faultLedger.heldRuns().length,1);
        assert.equal((await execution.dispatch('dispatch',task.id,version)).id,first.id);assert.equal(calls,1);
        assert.equal(resolved.agent.inbox.nextTurn.length,0);
        checks.push('real inbox acceptance followed by lost receipt cancels owned input and replay never sends twice');
      }finally{await execution?.dispose();faultLedger.close();}
      const managerLedger=new Store(join(home!,'super-bot',`manager-receipt-${randomUUID()}.sqlite`));
      const managerAgents:Agent[]=[];const wakeCalls=new Map<string,number>();let failedSession='',lostSession='';
      const managerFacade=new Proxy(ctx,{get(target,key){
        if(key==='sessionController')return new Proxy(target.sessionController,{get(controller,method){
          if(method==='resolveAgent')return async(id:SessionId)=>{
            if(id===failedSession)throw new Error('Synthetic manager unavailable');
            const resolved=await controller.resolveAgent(id);if('error' in resolved)return resolved;
            return {agent:new Proxy(resolved.agent,{get(agent,field){
              if(field==='followup')return (message:Parameters<Agent['followup']>[0])=>{wakeCalls.set(agent.id,(wakeCalls.get(agent.id)??0)+1);agent.followup(message);if(agent.id===lostSession)throw new Error('Synthetic manager receipt loss');};
              const value=Reflect.get(agent,field,agent);return typeof value==='function'?value.bind(agent):value;
            }})};
          };
          const value=Reflect.get(controller,method,controller);return typeof value==='function'?value.bind(controller):value;
        }});
        return Reflect.get(target,key,target);
      }});
      const managerExecution=new DshExecution(managerFacade,managerLedger,join(home!,'super-bot','manager-fault'),{fullAccess:false});
      const managers=new Managers(managerFacade,managerLedger,managerExecution,join(home!,'super-bot','manager-fault'),()=>'',{fullAccess:false});
      const observe=ctx.on('session/event',(session,event)=>{
        if(event.type==='user/message'&&event.data.source.kind==='super-bot-manager'&&managerLedger.managerForSession(session.id))managerLedger.managerEventEntered(event.data.source.eventId,event.data.id);
      });
      try {
        const bots=[];
        for(let n=0;n<3;n++) {
          const bot=managerLedger.createBot(`bot-${n}`,{name:`Manager fault ${n}`,instructions:'Synthetic notification receipt only'});bots.push(bot);
          const binding=await managers.prepare(`prepare-${n}`,bot.id);managerLedger.enqueueManager(bot.id,`synthetic-${n}`,'Synthetic notification failure probe',null);const resolved=await ctx.sessionController.resolveAgent(SessionId(binding.sessionId!));assert.ok('agent' in resolved);
          resolved.agent.model.select({provider,model:'deterministic'});managerAgents.push(resolved.agent);
        }
        failedSession=managerAgents[0]!.id;lostSession=managerAgents[1]!.id;
        // Trigger the actual pump without registering a second global management tool.
        await (managers as unknown as {pump():Promise<void>}).pump();
        await bounded(Promise.all(managerAgents.map(agent=>agent.whenIdle())),'manager receipt fault');
        assert.equal(wakeCalls.get(failedSession)??0,0);assert.equal(wakeCalls.get(lostSession),1);assert.equal(wakeCalls.get(managerAgents[2]!.id),1);
        assert.equal(managerLedger.managerInfo(bots[0]!.id).pending,1);assert.ok(managerLedger.managerInfo(bots[0]!.id).problem);
        assert.equal(managerLedger.managerInfo(bots[1]!.id).uncertain,1);assert.ok(managerLedger.managerInfo(bots[1]!.id).problem);
        assert.equal(managerLedger.managerInfo(bots[2]!.id).pending,0);assert.equal(managerLedger.managerInfo(bots[2]!.id).problem,null);
        await (managers as unknown as {pump():Promise<void>}).pump();assert.equal(wakeCalls.get(lostSession),1);
        assert.equal(managerAgents[1]!.inbox.nextTurn.length,0);assert.equal(managerLedger.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n,0);
        checks.push('one unavailable manager does not block others; lost notification receipt cancels and never resends');
      }finally{observe();await managers.dispose();await managerExecution.dispose();managerLedger.close();}
      const result={ok:true,checks,sessionIds:agents.map(a=>a.id),at:new Date().toISOString()};
      await writeFile(join(home!,'super-bot','contract-probe-result.json'),JSON.stringify(result,null,2));
      return result;
    } finally {for(const agent of agents){allowed.delete(agent.id);agent.cancel({kind:'user'},{keepInbox:true});}running=false;}
  }
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/super-bot-probe',methods:['POST'],requestBody:'buffered',
    fetch:async request=>{try{
      const body=await request.json() as {action?:string;sessionId?:string;text?:string;itemId?:string};
      if(body.action==='late-job-events'||body.action==='late-job-abort'||body.action==='late-job-duplicate-terminal') {
        assert.ok(body.sessionId);const agent=ctx.agents.get(SessionId(body.sessionId));assert.ok(agent);
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        if(body.action==='late-job-abort') {
          agent.cancel({kind:'user'},{keepInbox:true});
          adapter.stalled.get(agent.id)?.release();
        }
        const events=agent.session.snapshotEvents();
        if(body.action==='late-job-duplicate-terminal') {
          const terminal=events.findLast(event=>event.type==='job/settled');assert.ok(terminal);
          agent.session.append('job/settled',terminal.data);
        }
        return Response.json({ok:true,status:agent.status,stalled:adapter.stalled.has(agent.id),events});
      }
      if(body.action==='ready-job-status'||body.action==='ready-job-cancel'||body.action==='ready-job-finish') {
        assert.ok(body.sessionId);const job=readyJobs.get(body.sessionId);assert.ok(job);
        if(body.action==='ready-job-cancel')ctx.jobs.kill(job.id,SessionId(body.sessionId),'Synthetic late settlement');
        if(body.action==='ready-job-finish'){job.finish({status:'killed'});await ctx.jobs.wait(job.id,1000,SessionId(body.sessionId));}
        return Response.json({ok:true,status:ctx.jobs.get(job.id,SessionId(body.sessionId)).status});
      }
      if(body.action==='queue-native'||body.action==='attempt-scoped-probe') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);const agent=resolved.agent;
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));assert.equal(agent.model.current()?.provider,provider);
        if(body.action==='queue-native') {
          assert.ok(body.text&&body.text.length<=500);await ctx.sessionController.prompt({requestId:randomUUID() as SessionRequestId,sessionId:agent.id,mode:'queue',content:[{type:'text',text:body.text}]},new AbortController().signal);
        }else await ctx.tools.execute({agent,signal:new AbortController().signal,calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name:scopedToolName,arguments:'{}'}]});
        return Response.json({ok:true,scopedProbeCalls:scopedCalls.get(agent.id)??0});
      }
      if(body.action==='arm-crash'||body.action==='crash-inspect') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);const agent=resolved.agent;
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));assert.equal(agent.model.current()?.provider,provider);
        if(body.action==='arm-crash') {
          assert.ok(body.text);crashArms.set(agent.id,body.text);
          if(body.text==='ready-before-end')agent.ctx.on('agent/turn-stopping',async()=>{crashHeld.add(agent.id);await new Promise<void>(()=>{});});
          if(body.text==='pending-input') {
            const followup=agent.followup.bind(agent);
            agent.followup=message=>{agent.followup=followup;agent.send(message,'next-turn',false);agent.send(createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'Retained synthetic human input'}]}),'next-turn',false);};
          }
          if(body.text==='receipt-loss') {
            const followup=agent.followup.bind(agent);
            agent.followup=message=>{agent.followup=followup;followup(message);throw new Error('Synthetic receipt loss after real inbox acceptance');};
          }
          return Response.json({ok:true});
        }
        const handle=await ctx.sessionPersistence.open(agent.id,'read');
        try {const events=(await handle.read()).events;return Response.json({ok:true,held:crashHeld.has(agent.id),end:events.findLast(e=>e.type==='turn/end')??null,inputs:events.filter(e=>e.type==='user/message'&&e.data.source.kind==='super-bot').length,modelCalls:adapter.calls.filter(c=>c.sessionId===agent.id).length});}
        finally{await handle.close();}
      }
      if(body.action==='checkpoint-session') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);
        assert.ok(resolved.agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        assert.equal(await (ctx.sessions as unknown as SessionStore).flush(resolved.agent.session),true);return Response.json({ok:true});
      }
      if(body.action==='promote-steer') {
        assert.ok(body.sessionId&&body.itemId);
        const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);
        assert.ok(resolved.agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        assert.equal(resolved.agent.model.current()?.provider,provider);
        await ctx.sessionController.updateQueue({sessionId:resolved.agent.id,itemId:body.itemId as ReturnType<typeof createUserMessage>['id'],action:{kind:'steer'}});
        return Response.json({ok:true});
      }
      if(body.action==='release-stalled-model') {
        assert.ok(body.sessionId);adapter.stalled.get(body.sessionId)?.release();return Response.json({ok:true});
      }
      if(body.action==='create-attach-session') {
        const cwd=join(home!,'super-bot','existing-session-probes',randomUUID());await mkdir(cwd,{recursive:true});
        const workspace=await ctx.workspaceRegistry.create(cwd,'已有会话授权探针');const created=await ctx.sessionController.create({workspaceId:workspace.id});
        const resolved=await ctx.sessionController.resolveAgent(created.sessionId);assert.ok('agent' in resolved);const agent=resolved.agent;
        agent.model.select({provider,model:'deterministic'});
        const history=input('已有会话的合成历史材料：只供当前授权关联测试，不访问网络。');agent.followup(history);await bounded(agent.whenIdle(),'attachment history');
        if(body.text===ownerSessionTitle)ctx.sessionTitle.rename(agent.session,ownerSessionTitle);
        if(body.text==='fork') {
          const fork=await ctx.sessionController.fork({sessionId:agent.id});return Response.json({ok:true,sessionId:fork.sessionId,cwd,historyMessageId:history.id});
        }
        if(body.text==='pending')agent.send(input('ATTACH_PENDING_PROBE'),'next-turn',false);
        return Response.json({ok:true,sessionId:agent.id,cwd,historyMessageId:history.id});
      }
      if(body.action==='clear-attach-pending') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);
        assert.ok(resolved.agent.session.header.cwd?.startsWith(join(home!,'super-bot','existing-session-probes')+'/'));
        for(const message of [...resolved.agent.inbox.nextTurn,...resolved.agent.inbox.nextStep])if(message.source.kind==='super-bot-probe'&&message.content.some(block=>block.type==='text'&&block.text==='ATTACH_PENDING_PROBE'))resolved.agent.inbox.remove(message.id);
        return Response.json({ok:true});
      }
      if(body.action==='install-scoped-probe') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);const agent=resolved.agent;
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));assert.equal(agent.model.current()?.provider,provider);
        if(!scopedCalls.has(agent.id)) {
          scopedCalls.set(agent.id,0);
          agent.ctx.tools.register({name:scopedToolName,description:'Synthetic scoped capability probe, with no external effects.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{ok:{type:'boolean'}}},render:()=>[{type:'text',text:'Scoped probe executed'}]},execute:async()=>{scopedCalls.set(agent.id,(scopedCalls.get(agent.id)??0)+1);return {ok:true};}});
        }
        return Response.json({ok:true});
      }
      if(['change-test-directory','restore-test-directory','clear-directory-notices'].includes(body.action??'')) {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);const agent=resolved.agent;
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));assert.equal(agent.model.current()?.provider,provider);
        if(body.action==='clear-directory-notices') {
          for(const message of [...agent.inbox.nextTurn,...agent.inbox.nextStep])if(message.source.kind==='working-directory')agent.inbox.remove(message.id);
        }else {
          const cwd=body.action==='restore-test-directory'?agent.session.header.cwd!:join(home!,'super-bot','directory-probes',agent.id);
          await mkdir(cwd,{recursive:true});await ctx.workingDirectory.set(agent,cwd);
        }
        return Response.json({ok:true,cwd:ctx.workingDirectory.get(agent.session),status:agent.status});
      }
      if(body.action==='compact-worker-context') {
        assert.ok(body.sessionId&&body.text);
        const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);
        const { agent }=resolved;
        assert.ok(agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        assert.equal(agent.model.current()?.provider,provider);
        await bounded(agent.whenIdle(),'Worker before context compaction');
        const original=agent.session.snapshotEvents().find(event=>event.type==='user/message'&&isWorkerInput(event.data)
          &&event.data.source.runId===body.text&&/^Goal: ASK_PROBE$/m.test(messageText(event.data)));
        assert.ok(original);
        const commands=ctx.get('commands');assert.ok(commands,'native host command registry');
        const command=await bounded(commands.execute(agent,'/compact',[],AbortSignal.timeout(12000)),'Worker context compaction');
        assert.equal(command?.result.kind,'success',command?.result.text);
        const summary=agent.session.snapshotEvents().findLast(event=>event.type==='compaction/summary');
        assert.ok(summary?.type==='compaction/summary'&&summary.data.shadowedSeqs.includes(original.seq),command?.result.text);
        assert.ok(!agent.session.deriveMessages().some(message=>isWorkerInput(message)&&message.source.runId===body.text));
        return Response.json({ok:true,shadowed:summary.data.shadowedSeqs.length,compactionId:summary.data.compactionId});
      }
      if(body.action==='inspect-session') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));assert.ok('agent' in resolved);
        assert.ok(resolved.agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        return Response.json({ok:true,events:resolved.agent.session.snapshotEvents().filter(e=>['turn/start','turn/end','user/message','agent/inbox/spliced'].includes(e.type)).map(e=>({seq:e.seq,type:e.type,data:e.data})),pendingItems:[...resolved.agent.inbox.nextTurn.map(m=>({id:m.id,target:'next-turn'})),...resolved.agent.inbox.nextStep.map(m=>({id:m.id,target:'next-step'}))],sessionId:resolved.agent.id,status:resolved.agent.status,pending:resolved.agent.inbox.nextTurn.length+resolved.agent.inbox.nextStep.length,stalled:adapter.stalled.has(resolved.agent.id),workerContexts:[...adapter.workerContexts.get(resolved.agent.id)?.values()??[]],stalledAborted:adapter.stalled.get(resolved.agent.id)?.signal?.aborted??false,managerAttempts:adapter.managerAttempts.get(resolved.agent.id)??[],materialMarkers:adapter.calls.filter(call=>call.sessionId===body.sessionId&&(!call.purpose||call.purpose==='conversation')).at(-1)?.markers??[],assistantTexts:resolved.agent.session.snapshotEvents().filter(event=>event.type==='assistant/message').map(event=>event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('')),historyMessageIds:resolved.agent.session.snapshotEvents().filter(event=>event.type==='user/message').map(event=>event.data.id),modelSteps:adapter.calls.filter(call=>call.sessionId===body.sessionId&&(!call.purpose||call.purpose==='conversation')).length,scopedProbeCalls:scopedCalls.get(resolved.agent.id)??0,scopedProbeAttempts:adapter.scopedAttempts.get(resolved.agent.id)??0,
          toolResults:resolved.agent.session.snapshotEvents().filter(event=>event.type==='tool/result').map(event=>event.data),modelTools:adapter.calls.filter(call=>call.sessionId===body.sessionId&&(!call.purpose||call.purpose==='conversation')).at(-1)?.tools??[],executedTools:resolved.agent.session.snapshotEvents().filter(event=>event.type==='tool/call').map(event=>event.data.name),
          productTools:ctx.tools.definitions().map(tool=>tool.name).filter(name=>['super_bot_report','super_bot_manage'].includes(name))});
      }
      if(body.action==='select-test-model'||body.action==='native-prompt') {
        assert.ok(body.sessionId);const resolved=await ctx.sessionController.resolveAgent(SessionId(body.sessionId));
        assert.ok('agent' in resolved);assert.ok(resolved.agent.session.header.cwd?.startsWith(join(home!,'super-bot')+'/'));
        if(body.action==='native-prompt') {
          assert.equal(resolved.agent.model.current()?.provider,provider);assert.ok(body.text&&body.text.length<=500);
          await ctx.sessionController.prompt({requestId:randomUUID() as SessionRequestId,sessionId:resolved.agent.id,mode:'queue',content:[{type:'text',text:body.text}]},new AbortController().signal);
          await bounded(resolved.agent.whenIdle(),'native synthetic prompt');
          return Response.json({ok:true,tools:adapter.calls.filter(c=>c.sessionId===body.sessionId&&!c.purpose).at(-1)?.tools,
            callKinds:adapter.calls.filter(c=>c.sessionId===body.sessionId).slice(-5).map(c=>({purpose:c.purpose??'conversation',tools:c.tools})),
            refused:resolved.agent.session.snapshotEvents().some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('只能查看或管理自己负责的任务'))});
        }
        resolved.agent.model.select({provider,model:'deterministic'});return Response.json({ok:true});
      }
      return Response.json(await run());
    }catch(error){return Response.json({ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined},{status:500});}},
  }));
}
