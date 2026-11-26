import {inspectPriorTools,type ProbeEvidence,type ProbeResult,type PriorTools,type ReadProbe} from './read-only-recovery.ts';
/** The only execution adapter. Product state never depends on a DSH object. */
import {symbols,type Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId } from '@deepseek-ai/dsh-jobs';
import {carrierKeyOf} from '@deepseek-ai/dsh-scope';
import {ChildWaitObservation,type NativeChildEdge} from './dsh-child-wait.ts';
import { randomUUID } from 'node:crypto';
import { parseClusterProbe,prepareClusterProbe } from './kubernetes-preflight.ts';
import {GIT_STATUS_QUERY,WORKER_QUERY_TOOL,gitWorkingTreeStatus,parseGitStatusQuery} from './git-status-query.ts';
import { freezeMessage,ToolCallId,type UserMessage } from '@deepseek-ai/dsh-llm';
import type {Session,SessionStore} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import {verifyRunTurn} from './run-proof.ts';
import {verifyLateJobs,verifyLateJobScope} from './dsh-late-job-proof.ts';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { realpath } from 'node:fs/promises';
import { lstatSync,mkdirSync,realpathSync,statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join,isAbsolute,basename } from 'node:path';
import {cleanupWorkdir,provisionWorkdir,workdirPolicy,type WorkdirPolicy,type WorkdirRequest} from './workdir.ts';
import {nameAutomaticSession,workerTitle} from './sidebar.ts';
import { AppError,requiredText,optionalText,type Binding,type Run,type Task,type WorkReport,type ExistingSessionGrant,type ExistingSessionPreview } from './model.ts';
import type { ChildWaitDetail,ChildWaitMember,RecoveryContinuation,RecoveryDetail,RecoveryInput,RecoveryInputKind,
  RecoveryWorkContext,RunChildWait,RunModels,RunTurn,WorkerModelPreview } from './model.ts';
import { actualModelRequests,modelRoute,nativeModel,observeNativeModel,readModelLog,workerModelPlan } from './dsh-model.ts';
import type { Store } from './store.ts';
import { captureEvidence,containedPath,verifyEvidence,evidencePaths,type CapturedEvidence } from './evidence.ts';
import {configureRole,fullAccessEnabled,type RuntimeOptions} from './runtime.ts';
import { createWorkerRunMessage,registerWorkerContext,workerPromptPlan,workerStandingPrompt } from './worker-prompt.ts';
import { ReloadAdmission } from './reload-admission.ts';
import { gitLabReader, glabGitLab } from './gitlab-client.ts';
import { exactJobStatus, GITLAB_PLAY_TOOL, releaseJobPath, releaseReadback, type ReleaseTarget } from './gitlab-release.ts';

/** Host defaults are not a model selection made for this conversation. */
export function selectedModel(ctx:Context,agent:Agent) {
  return nativeModel(ctx,agent.session);
}
export function modelFailureNote(code:string):string {
  if(code==='MISSING_CREDENTIAL')return '模型缺少登录或 API Key。请打开原生会话配置模型账号，再核对并继续；本次没有自动重试。';
  if(['INVALID_CREDENTIAL','AUTHENTICATION','AUTH'].includes(code))return '模型认证失败。请在原生会话检查模型账号，再核对并继续；本次没有自动重试。';
  if(['QUOTA','ACCOUNT_QUOTA'].includes(code))return '模型账号额度不足。请检查原生模型设置与额度；本次没有自动重试。';
  if(code==='NO_ADAPTER')return '所选模型提供方当前不可用。请打开原生会话重新选择模型；本次没有自动重试。';
  return '原生模型执行失败。请打开对应会话查看错误、核对文件与执行状态后再继续；本次没有自动重试。';
}

function originalService(tree:NativeSubagents|undefined):NativeSubagents|undefined {
  // Cordis traces each ctx.get through a new wrapper around the same service.
  return tree&&(Reflect.get(tree,symbols.original)??tree);
}

function unknownPriorEffects(checks:PriorTools|null,unboundCluster:boolean,inherited=false):string {
  const notes:string[]=[];
  if(!checks)notes.push('缺少可核对的原轮工具记录。');
  else {
    if(checks.incomplete)notes.push('原轮工具调用与结果记录不完整。');
    if(checks.potentialEffects.length) {
      const tools=[...new Set(checks.potentialEffects.map(item=>item.tool.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80)))].slice(0,5).join('、');
      notes.push(`原轮工具 ${tools||'（名称无法核实）'} 缺少可信的只读或外部操作回执。`);
    }
  }
  if(unboundCluster)notes.push('原轮 Kubernetes 查询缺少匹配的宿主回执。');
  if(inherited)notes.push('此前执行仍有待核对的外部效果。');
  return notes.join(' ');
}

function recoveryInputs(agent:Agent):RecoveryInput[] {
  const counts=new Map<string,RecoveryInput>();
  for(const [queue,messages] of [['next-turn',agent.inbox.nextTurn],['next-step',agent.inbox.nextStep]] as const) {
    for(const {source} of messages) {
      let kind:RecoveryInputKind='other';
      switch(String(source.kind)) {
        case 'user':kind='human';break;
        case 'super-bot':kind='task';break;
        case 'tool-jobs':if('form' in source&&source.form==='notice')kind='job-result';break;
        case 'subagent-settled':kind='child-result';break;
      }
      const key=`${queue}:${kind}`,count=counts.get(key);
      if(count)count.count++;
      else counts.set(key,{queue,kind,count:1});
    }
  }
  return [...counts.values()];
}

function hasPendingChildResult(agent:Agent):boolean {
  return agent.inbox.nextStep.some(message=>String(message.source.kind)==='subagent-settled');
}

type NativeAgentRegistry=Pick<Context['agents'],'list'>&{isOwnedBy?:(id:Agent['id'],owner:Agent)=>boolean};

interface NativeSubagents {
  rootOf?(member:Agent):Agent;
  waitForTreeWork?(root:Agent):Promise<boolean>;
  waitForChildren?(parent:Agent):Promise<boolean>;
  interrupt?(childId:Agent['id'],authority:{kind:'ancestor';agent:Agent}):void;
}
interface TreeCheck {
  agent:Agent;
  revision:number;
  reportRevision?:number;
  active:Map<string,{edge:NativeChildEdge;owner:Agent;member?:ChildWaitMember}>;
  ended:Set<string>;
  waits:Map<string,ChildWaitObservation>;
  pendingWaits:number;
  service?:NativeSubagents;
  waitFailed?:boolean;
  releaseEvents?:()=>void;
}

export class DshExecution {
  private creating=new Map<string,Promise<Binding>>();
  private running=new Map<string,{agent:Agent;release:()=>void;done:Promise<void>;finishTurn:(endSeq?:number,endKind?:string,endTime?:number,endNote?:string)=>void}>();
  private autoTurns=new Set<string>();
  private treeChecks=new Map<string,TreeCheck>();
  private turnStarts=new WeakMap<Session,{turn:number;seq:number}>();
  private finishing=new Map<string,Promise<void>>();
  private lateJobTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private lateJobChecks=new Map<string,Promise<void>>();
  private closing=new Map<string,Promise<void>>();
  private pendingHuman=new Map<string,string[]>();
  private recoveryTreeChecks=new WeakMap<Agent,Promise<boolean>>();
  private deletedRuns=new Map<string,AbortController>();
  private disposed=false;
  readonly policy:WorkdirPolicy;
  constructor(private ctx:Context,private store:Store,private dataDir:string,private options:RuntimeOptions={},
    private reloadAdmission=new ReloadAdmission()) {this.policy=workdirPolicy(options,dataDir);}

  reloadBlockers(): string[] {
    const blockers = new Map<string, string>();
    for (const run of this.store.heldRuns()) {
      blockers.set(run.id, `Worker task ${run.taskId}, run ${run.id}, session ${run.sessionId} (${run.state}, resource held)`);
    }
    for (const [id, active] of this.running) {
      if (!blockers.has(id)) blockers.set(id, `Worker run ${id}, session ${active.agent.id} (native work still tracked)`);
    }
    for (const id of this.finishing.keys()) {
      if (!blockers.has(id)) blockers.set(id, `Worker run ${id} (settlement in progress)`);
    }
    for (const agent of this.ctx.agents.list()) {
      const taskId = this.store.workerTaskForSession(agent.id);
      if (!taskId) continue;
      try { this.assertQuiet(agent); }
      catch (error) {
        blockers.set(agent.id, `Worker task ${taskId}, session ${agent.id}: ${error instanceof Error ? error.message : 'native activity unknown'}`);
      }
    }
    return [...blockers.values()];
  }

  install():void {
    this.ctx.effect(()=>this.ctx.tools.register({name:'super_bot_report',description:'Report progress, a completed stage, a question, a blockage, failure, or the overall ready result. Ready requires files and acceptance checks for the whole task. Stage requires a distinct name, stable evidenceRef, and checks.',
      parameters:{type:'object',properties:{kind:{type:'string',enum:['progress','stage','waiting','ready','blocked','failed']},summary:{type:'string'},checks:{type:'string'},files:{type:'array',items:{type:'string'},maxItems:10},
        stage:{type:'string',description:'Stage only. Specific milestone reached while another authorized step remains.'},
        evidenceRef:{type:'string',description:'Stage only. Stable identifier for the new evidence, e.g. exact CI run URL, merge commit, or deployment receipt.'},
        links:{type:'object',additionalProperties:{type:'string'},description:'Ready only. Map a distinct display name to the full HTTP(S) URL of each actual external deliverable. Use files for local evidence and keep reference links in the report.'},
        primaryLink:{type:'string',description:'Ready only. Exact display name in links of the one main deliverable the user should open next.'},
      },required:['kind','summary'],additionalProperties:false},
      output:{schema:{type:'object',properties:{accepted:{type:'boolean'},resultId:{type:'string'},reason:{type:'string'},next:{type:'string'}},required:['accepted'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const run=this.store.heldRuns().find(r=>r.sessionId===exec.agent?.id&&r.finishedAt===null);
        if(!run||this.finishing.has(run.id))throw new AppError('report-scope','当前会话没有可报告的执行。');
        const data=args as Record<string,unknown>;const binding=this.store.getBinding(run.bindingId);
        const report:WorkReport={kind:data.kind as WorkReport['kind'],summary:requiredText(data.summary,'报告内容'),checks:optionalText(data.checks,'验收说明'),links:data.links as WorkReport['links'],primaryLink:data.primaryLink as WorkReport['primaryLink'],
          stage:data.stage as WorkReport['stage'],evidenceRef:data.evidenceRef as WorkReport['evidenceRef']};
        if((report.kind==='ready'||report.kind==='stage')&&this.store.recoveryWorkPlan(run.id)?.context.mode==='read-only') {
          throw new AppError('continuation-scope','本次只读核对只覆盖指定的后续步骤。请用 blocked 或 waiting 报告实际观察及余下事项。');
        }
        if(this.store.recoveryWorkPlan(run.id)?.context.lateJobs&&
          (this.store.getTask(run.taskId).controlMode!=='auto'||report.kind==='stage')) {
          throw new AppError('continuation-scope','后台恢复续轮只报告已核实的本地成果或具体缺口。');
        }
        if(report.kind==='ready') {
          report.requestedFiles=evidencePaths(data.files);
          if(this.store.recoveryWorkPlan(run.id)?.context.lateJobs) {
            const folder=join(binding.cwd,`.super-bot-reports-${run.id}`);
            for(const path of report.requestedFiles)containedPath(folder,path);
          }
        }
        exec.signal.throwIfAborted();
        const receipt=this.store.workerReportReceipt(run.id,exec.callId,report);
        const treeCheck=this.treeChecks.get(run.id);
        const assertCurrent=()=>{
          exec.signal.throwIfAborted();
          const current=this.store.getRun(run.id);
          if(this.disposed||this.finishing.has(run.id)||current.finishedAt!==null||current.state==='cancelling'||
            this.store.isBotDeleted(this.store.getTask(run.taskId).botId)) {
            throw new AppError('report-stale','当前执行授权已结束或正在停止。');
          }
        };
        let captured: CapturedEvidence[] | undefined;
        if(report.kind==='ready'||report.kind==='stage') {
          const agent=exec.agent!,revision=treeCheck?.revision;
          let joined=await this.waitForTreeWork(agent,exec.signal,treeCheck,this.childWait(run,agent,'ready'));
          assertCurrent();
          this.assertChildrenQuiet(agent);
          this.assertObservedTreeQuiet(treeCheck);
          if(report.kind==='ready'&&!joined&&treeCheck?.revision===revision&&!hasPendingChildResult(agent)&&!receipt) {
            captured=await captureEvidence(binding.cwd,report.requestedFiles);
            // File I/O yields. Require a fresh native observation before using the evidence.
            joined=await this.waitForTreeWork(agent,exec.signal,treeCheck,this.childWait(run,agent,'ready'));
            assertCurrent();
            this.assertChildrenQuiet(agent);
            this.assertObservedTreeQuiet(treeCheck);
          }
          if(joined||treeCheck?.revision!==revision||hasPendingChildResult(agent)) {
            if(receipt)throw new AppError('report-stale','已提交候选后又有子树活动，请核对，不能重用旧报告。');
            return {accepted:false,reason:'subtree-joined',next:`已等待子 Agent 树收敛。本次未提交报告，父轮次继续占用执行名额。请核对子 Agent 结果及证据，再在本轮重新调用 ${report.kind}。`};
          }
        }
        assertCurrent();
        if(receipt) {
          if(report.kind!=='progress'&&treeCheck&&treeCheck.reportRevision!==treeCheck.revision) {
            throw new AppError('report-stale','最终报告后子树已改变，不能重用旧候选。');
          }
          if(report.kind!=='progress')exec.concludeTurn();
          return receipt;
        }
        const result=this.store.workerReport(run.id,exec.callId,report,captured);
        if(report.kind!=='progress') {
          if(treeCheck)treeCheck.reportRevision=treeCheck.revision;
          exec.concludeTurn();
        }
        return result;
      },
    },{when:({agent})=>this.store.heldRuns().some(r=>r.sessionId===agent.id&&r.finishedAt===null&&
      !this.store.isBotDeleted(this.store.getTask(r.taskId).botId))}));
    if(fullAccessEnabled(this.options))this.ctx.effect(()=>this.ctx.tools.register({
      name:'super_bot_preflight',
      description:'Read-only Kubernetes preflight under an existing authorized shared identity. Use when the original task authorizes checking an explicit Kubernetes context and namespace. Verify permission via SelfSubjectAccessReview or read one named Deployment/PVC. Never use this to apply changes, impersonate another identity, change auth, or guess a context. Report the returned status, then use blocked if a prerequisite failed.',
      parameters:{type:'object',properties:{
        kind:{type:'string',enum:['permission','deployment-state','volume-state']},
        context:{type:'string'},namespace:{type:'string'},
        name:{type:'string',description:'Exact object name, or an empty string for a namespace-level permission check.'},
        verb:{type:'string',description:'For a permission check only. The verb is queried, never performed.'},
        resource:{type:'string',description:'For a permission check only. Kubernetes resource such as deployments.apps or persistentvolumeclaims.'},
      },required:['kind','context','namespace','name'],additionalProperties:false},
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const run=this.store.heldRuns().find(r=>r.sessionId===exec.agent?.id&&r.state==='running'&&r.finishedAt===null);
        if(!run||!this.autoTurns.has(run.id)||!this.store.runTurn(run.id)?.inputSeq||!exec.agent) {
          throw new AppError('preflight-scope','没有绑定到此会话与轮次的任务授权。');
        }
        const probe=parseClusterProbe(args),binding=this.store.getBinding(run.bindingId),task=this.store.getTask(run.taskId);
        const work=this.store.recoveryWorkPlan(run.id);
        const scoped=work?.context.mode==='read-only'?work.authorizedProbes.find(item=>JSON.stringify(item.probe)===JSON.stringify(probe)):undefined;
        if(work?.context.mode==='read-only'&&!scoped)throw new AppError('preflight-scope','后续指示只能核对上一轮已有授权和身份回执的目标。');
        const authorize=()=>{
          exec.signal.throwIfAborted();
          const current=this.store.getRun(run.id),latest=this.store.getTask(task.id);
          if(this.disposed||current.state!=='running'||current.finishedAt!==null||latest.rowVersion!==task.rowVersion||
            latest.controlMode!=='auto'||this.store.isBotDeleted(task.botId)||this.store.activeBinding(task.id)?.id!==binding.id||
            this.store.finalReport(run.id))throw new AppError('preflight-scope','原任务或当前工具授权已改变。');
          this.assertDirectory(exec.agent!,binding.cwd);
        };
        authorize();
        const signal=AbortSignal.any([exec.signal,AbortSignal.timeout(17000)]);
        const prior=this.store.preflightReceipt(run.id,exec.callId);
        if(prior) {
          if(JSON.stringify(probe)!==JSON.stringify(prior.probe))throw new AppError('idempotency-conflict','此预检工具调用已用于其他参数。');
          return prior.result;
        }
        let auth:string|null=null,result:ProbeResult;
        try {
          const prepared=await prepareClusterProbe(probe,signal,scoped?.auth,authorize);
          authorize();
          auth=prepared.auth;result=await prepared.check();
        }catch(error){
          result={status:'unavailable',message:error instanceof AppError?error.message:'Kubernetes 未返回可验证的预检结果。'};
        }
        authorize();
        this.store.recordPreflightReceipt(run.id,exec.callId,probe,auth,result);
        return result;
      },
    },{when:({agent})=>this.store.heldRuns().some(run=>run.sessionId===agent.id&&run.finishedAt===null&&
      !this.store.isBotDeleted(this.store.getTask(run.taskId).botId))}));
    if(fullAccessEnabled(this.options))this.ctx.effect(()=>this.ctx.tools.register({
      name:GITLAB_PLAY_TOOL,
      description:'Execute the one already authorized GitLab manual job for this run, or follow the same job by readback. Host verifies the saved target and reports the actual outcome. No arguments.',
      parameters:{type:'object',properties:{},additionalProperties:false},
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const agent=exec.agent,run=agent&&this.store.heldRuns().find(item=>item.sessionId===agent.id&&item.state==='running');
        if(!agent||!run||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length||
          !this.autoTurns.has(run.id)||this.store.runTurn(run.id)?.inputSeq==null) {
          throw new AppError('gitlab-release-scope','没有与本轮 Worker 绑定的正式 GitLab 作业授权。');
        }
        const binding=this.store.getBinding(run.bindingId);
        let confirmedPreset:string|undefined;
        const authorize=()=>{
          exec.signal.throwIfAborted();
          const current=this.store.getRun(run.id),task=this.store.getTask(run.taskId);
          if(this.disposed||!this.autoTurns.has(run.id)||current.state!=='running'||task.controlMode!=='auto'||
            this.store.activeBinding(task.id)?.id!==binding.id||this.store.finalReport(run.id)||
            agent.inbox.nextStep.length||agent.inbox.nextTurn.length||!this.store.gitLabReleaseForRun(run)||
            (confirmedPreset&&this.ctx.permissionPresets.current(agent.session)!==confirmedPreset)) {
            throw new AppError('gitlab-release-stale','Worker 轮次或原任务授权已改变。');
          }
          this.assertDirectory(agent,binding.cwd);
          this.assertExternalQuiet(agent);
        };
        authorize();
        const receipt=await this.runGitLabRelease(agent,run,exec.signal,authorize,async target=>{
          const preset=this.ctx.permissionPresets.current(agent.session);
          if(preset==='custom')return false;
          const permission=this.ctx.permissionPresets.resolve(preset);
          if(permission.approval!=='ask') {
            if(permission.sandbox!=='danger-full-access'||preset==='auto')return false;
            confirmedPreset=preset;return true;
          }
          const approval=this.ctx.get?.('approval');
          const outcome=await approval?.request({agent,signal:exec.signal,callId:exec.callId,toolName:GITLAB_PLAY_TOOL,
            reason:`允许当前 Worker 启动 ${target.project} 流水线 #${target.pipelineId} 的作业 #${target.jobId}？`});
          if(outcome!=='allowed-once')return false;
          confirmedPreset=preset;return true;
        });
        authorize();
        const treeCheck=this.treeChecks.get(run.id);
        this.assertObservedTreeQuiet(treeCheck);
        if(hasPendingChildResult(agent))throw new AppError('gitlab-release-stale','原生子任务结果等待处理，已保留发布作业的实际回执。');
        this.store.workerReport(run.id,exec.callId,{ kind:'stage',stage:'GitLab 正式作业',
          summary:receipt.detail,evidenceRef:receipt.url,checks:`GitLab 流水线 #${receipt.target.pipelineId}，作业 #${receipt.target.jobId}，${receipt.state}` });
        if(treeCheck)treeCheck.reportRevision=treeCheck.revision;
        exec.concludeTurn();
        return receipt;
      },
    },{when:({agent})=>this.store.heldRuns().some(run=>run.sessionId===agent.id&&!!this.store.gitLabReleaseForRun(run))}));
    if(fullAccessEnabled(this.options))this.ctx.effect(()=>this.ctx.tools.register({
      name:WORKER_QUERY_TOOL,
      description:'Read-only Git working tree status in the bound task directory. Reports available HEAD and staged, unstaged and untracked paths. Use for the opening Git baseline and working tree checks. No shell, path or flags.',
      parameters:{type:'object',properties:{kind:{type:'string',enum:[GIT_STATUS_QUERY]}},required:['kind'],additionalProperties:false},
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const agent=exec.agent;
        const run=agent&&this.store.heldRuns().find(item=>item.sessionId===agent.id&&item.finishedAt===null&&item.state==='running');
        const proof=run&&this.store.runTurn(run.id);
        if(!agent||!run||!this.autoTurns.has(run.id)||proof?.turn==null||proof.inputSeq==null) {
          throw new AppError('query-scope','没有绑定到此会话与轮次的任务授权。');
        }
        const {kind}=parseGitStatusQuery(args);
        const binding=this.store.getBinding(run.bindingId);
        const authorize=()=>{
          exec.signal.throwIfAborted();
          const current=this.store.getRun(run.id),task=this.store.getTask(run.taskId);
          if(this.disposed||!this.autoTurns.has(run.id)||current.state!=='running'||current.finishedAt!==null||
            task.taskRevision!==run.taskRevision||task.controlMode==='manual'||this.store.isBotDeleted(task.botId)||
            this.store.activeBinding(task.id)?.id!==binding.id||this.store.finalReport(run.id)) {
            throw new AppError('query-scope','原任务或当前工具授权已改变。');
          }
          this.assertDirectory(agent,binding.cwd);
        };
        authorize();
        const identity={kind,cwd:binding.cwd,turn:proof.turn,inputSeq:proof.inputSeq};
        const prior=this.store.readQueryReceipt(run.id,exec.callId);
        if(prior) {
          if(prior.kind!==kind||prior.cwd!==identity.cwd||prior.turn!==identity.turn||prior.inputSeq!==identity.inputSeq) {
            throw new AppError('idempotency-conflict','此只读工具调用已绑定到其他执行坐标。');
          }
          return prior.result;
        }
        const result=await gitWorkingTreeStatus(binding.cwd,exec.signal,authorize);
        authorize();
        this.store.recordReadQueryReceipt(run.id,exec.callId,{...identity,result});
        return result;
      },
    },{when:({agent})=>this.store.heldRuns().some(run=>run.sessionId===agent.id&&run.finishedAt===null&&
      !this.store.isBotDeleted(this.store.getTask(run.taskId).botId))}));
    this.ctx.on('agent/created',({agent})=>{
      if(this.disposed)return;
      for(const run of this.store.heldRuns())if(run.sessionId===agent.id&&!this.running.has(run.id))this.withdrawWorkerInput(run,agent);
      for(const run of this.store.deletedWorkerRunsForSession(agent.id))this.withdrawWorkerInput(run,agent);
    });
    this.ctx.on('session/event',(session,event)=>{
      if(this.disposed)return;
      if(event.type==='turn/start')this.turnStarts.set(session,{turn:event.data.turn,seq:event.seq});
      if(!fullAccessEnabled(this.options)&&event.type==='working-directory/change') {
        const run=this.store.heldRuns().find(r=>r.sessionId===session.id&&r.finishedAt===null);
        if(run&&!this.store.isBotDeleted(this.store.getTask(run.taskId).botId)&&event.data.cwd!==this.store.getBinding(run.bindingId).cwd) {
          this.store.runRecovery(run.id,'原生会话工作目录已改变，当前执行授权停止。请核对文件和原生会话。');
          this.running.get(run.id)?.agent.cancel({kind:'user'},{keepInbox:true});
        }
      }
      if(event.type==='approval/asked') {
        const run=this.store.heldRuns().find(r=>r.sessionId===session.id&&r.finishedAt===null);
        if(run)this.store.nativeApprovalAsked(run.id,event.data.id,event.data.toolName,event.data.reason??'');
      }
      if(event.type==='approval/decided') {
        this.store.nativeApprovalDecided(session.id,event.data.id,event.data.outcome);
        const taskId=this.store.workerTaskForSession(session.id);
        if(taskId)void this.advanceClose(taskId,true);
      }
      if(event.type==='user/message'&&event.data.source.kind==='super-bot') {
        const source=event.data.source;
        const run=this.store.heldRuns().find(r=>r.id===source.runId&&r.finishedAt===null);
        const check=run&&this.treeChecks.get(run.id);
        if(run&&check?.agent.session===session&&run.sessionId===session.id&&run.inputId===source.inputId&&
          run.taskId===source.taskId&&run.taskRevision===source.taskRevision&&run.generation===source.generation&&
          this.store.getRunInput(run.id).messageId===event.data.id&&!this.store.runTurn(run.id)?.turn) {
          this.store.inputEntered(run.id,event.data.id,event.seq);
          const start=this.turnStarts.get(session);
          if(start)this.store.associateRunTurn(run.id,start.turn,start.seq,event.seq);
          this.autoTurns.add(run.id);
        }
      }
      if(event.type==='turn/end') {
        for(const run of this.store.heldRuns()) {
          const active=this.running.get(run.id);
          if(active?.agent.session!==session||!this.autoTurns.has(run.id)||this.store.runTurn(run.id)?.turn!==event.data.turn)continue;
          const note=event.data.reason.kind==='error'?modelFailureNote(event.data.reason.error.code):undefined;
          active.finishTurn(event.seq,event.data.reason.kind,event.time,note);
        }
        if(this.turnStarts.get(session)?.turn===event.data.turn)this.turnStarts.delete(session);
      }
      if(event.type==='job/settled'||event.type==='turn/end')this.scheduleLateJobForSession(session.id);
      // Queue/steer must not look like takeover. Only a human user/message that
      // starts a new turn while no automatic turn is running marks intervention.
      // Do not cancel: that would abort the user's own turn. Release immediately;
      // whenIdle() may follow the new driver, so the idle listener would be late.
      if(event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId' in event.data.source) {
        const previous=this.store.heldRuns().find(run=>run.sessionId===session.id&&run.finishedAt===null);
        if(previous&&this.autoTurns.has(previous.id))return;
        if(previous&&this.finishing.has(previous.id)){const ids=this.pendingHuman.get(previous.id)??[];ids.push(event.data.id);this.pendingHuman.set(previous.id,ids);return;}
        const changed=this.store.nativeIntervention(session.id,event.data.id);
        if(changed&&previous){this.running.get(previous.id)?.release();this.running.delete(previous.id);}
      }
    });
    this.ctx.on('agent/status',({agent,status})=>{
      if(status==='idle')this.scheduleLateJobForSession(agent.id);
    });
    // Startup checks durable facts without opening or waking any Agent.
    for(const run of this.store.heldRuns())if(!this.store.isBotDeleted(this.store.getTask(run.taskId).botId)) {
      const proof=this.store.runTurn(run.id);
      if(run.finishedAt===null) {
        if(!proof?.quiet||proof.endSeq===null)this.store.runRecovery(run.id,proof?'重启后缺少原进程的归属结束/后台收敛证据，保留占用；没有自动重投。':'旧版 Run 没有持久轮次证据，请人工核对；没有自动重投。',false);
        else this.scheduleReconciliation(run.id);
      }
      this.scheduleLateJobCheck(run.id);
    }
    for(const taskId of this.store.pendingTaskCloses()) {
      const runId=this.store.taskClose(taskId)?.runId;
      if(!runId||!this.finishing.has(runId))void this.advanceClose(taskId,true,true);
    }
    this.stopDeletedBot();
  }
  /** Useful to callers/tests before inspecting startup reconciliation; never executes model work. */
  async whenReconciled():Promise<void> {await Promise.all([...this.finishing.values(),...this.closing.values()]);}
  private scheduleReconciliation(runId:string,session?:Session):void {
    const done=Promise.resolve().then(()=>this.reconcileRun(runId,session)).catch(error=>{
      if(!this.disposed)this.store.runRecovery(runId,error instanceof AppError?error.message:'持久执行证据无法读取，请人工核对；没有重投。',!!session);
    }).finally(async()=>{
      if(!this.disposed)for(const id of this.pendingHuman.get(runId)??[])this.store.nativeIntervention(this.store.getRun(runId).sessionId,id);
      this.pendingHuman.delete(runId);this.finishing.delete(runId);
      const agent=!this.disposed&&session&&this.ctx.agents.get?.(session.id);
      if(!this.disposed&&(!agent||agent.status==='idle'))await this.advanceClose(this.store.getRun(runId).taskId,true);
    });
    this.finishing.set(runId,done);
  }
  private async reconcileRun(runId:string,session?:Session):Promise<void> {
    const run=this.store.getRun(runId);if(run.finishedAt!==null||this.disposed)return;
    const proof=this.store.runTurn(runId);if(!proof)throw new AppError('run-proof','旧版执行没有可归属的持久证据。');
    const followups=verifyRunTurn(run,this.store.getRunInput(runId),proof,await this.readRunEvents(run,session));
    const current=this.store.getRun(runId);
    if(this.disposed||current.finishedAt!==null||this.store.isBotDeleted(this.store.getTask(run.taskId).botId))return;
    if(current.state!=='cancelling'&&(!proof.reportId||this.store.finalReport(runId)?.id!==proof.reportId))throw new AppError('run-proof','没有绑定到结束边界的最终报告；不会推断完成。');
    const task=this.store.getTask(run.taskId),binding=this.store.activeBinding(run.taskId);
    if(task.taskRevision!==run.taskRevision||binding?.id!==run.bindingId||binding.generation!==run.generation||binding.sessionId!==run.sessionId)throw new AppError('run-proof','任务或会话绑定已改变，不能补结算。');
    // No awaits between settlement and native takeover: later human work cannot
    // become an automatic scheduling/review opportunity in between these writes.
    if(current.state==='cancelling')this.store.settleCancelled(runId,!!session);else this.store.settleRun(runId,!!session);
    for(const id of followups)this.store.nativeIntervention(run.sessionId,id);
  }
  private async readRunEvents(run:Run,session?:Session) {
    if(session&&!await (this.ctx.sessions as unknown as SessionStore).flush(session))throw new AppError('run-proof','宿主未确认轮次持久保存，保留占用。');
    const handle=await this.ctx.sessionPersistence.open(SessionId(run.sessionId),'read');
    try {
      if(handle.header.id!==run.sessionId)throw new AppError('run-proof','持久会话身份不符。');
      return (await handle.read()).events;
    }finally{await handle.close();}
  }
  private scheduleLateJobForSession(sessionId:string):void {
    if(this.disposed)return;
    const taskId=this.store.workerTaskForSession(sessionId);
    const run=taskId?this.store.latestRun(taskId):null;
    if(run?.sessionId===sessionId)this.scheduleLateJobCheck(run.id);
  }
  private scheduleLateJobCheck(runId:string,waitMs=0):void {
    if(this.disposed||this.store.lateJobRecovery(runId)?.state!=='waiting'||this.lateJobChecks.has(runId))return;
    clearTimeout(this.lateJobTimers.get(runId));
    const timer=setTimeout(()=>{
      this.lateJobTimers.delete(runId);
      const checking=this.inspectLateJob(runId).catch(()=>{}).finally(()=>{
        this.lateJobChecks.delete(runId);
        if(!this.disposed&&this.store.lateJobTarget(runId,true))this.scheduleLateJobCheck(runId,30000);
      });
      this.lateJobChecks.set(runId,checking);
    },waitMs);
    timer.unref();this.lateJobTimers.set(runId,timer);
  }
  private async inspectLateJob(runId:string):Promise<void> {
    const target=this.store.lateJobTarget(runId,true);
    if(!target||target.pending.state!=='waiting')return;
    const {run,proof,pending}=target;
    const agent=this.ctx.agents.get(SessionId(run.sessionId));
    let reason:string;
    try {
      const events=await this.readRunEvents(run,agent?.session);
      if(this.disposed||!this.store.lateJobTarget(runId,true))return;
      const late=verifyLateJobs(run,this.store.getRunInput(run.id),proof,pending.ids,events);
      verifyLateJobScope(events,proof);
      if(late) { this.store.updateLateJob(runId,{proof:late});return; }
      const terminal=new Set<string>(events.flatMap(event=>event.type==='job/settled'&&event.seq>proof.endSeq!
        ?[event.data.jobId]:[]));
      if(pending.ids.every(id=>terminal.has(id))) {
        this.store.observeLateJobTerminal(runId);
        reason='旧轮的 Job 已进入终态，缺少独立原生轮次消费结果的回执。可以在原聊天请 Bot 核对该 Job 的输出和报告余项。';
      }else reason='旧轮已结束，仍缺少对应 Job 的生产者终态回执。可以在原聊天请 Bot 核对原作业状态。';
    }catch(error) {
      if(this.disposed)return;
      if(error instanceof AppError&&error.code==='late-job-unproven') {
        this.store.updateLateJob(runId,{reason:error.message});return;
      }
      reason='宿主无法读取旧轮的 Job 与通知回执。可以在原聊天请 Bot 核对原生会话访问状态。';
    }
    if(!this.disposed&&Date.now()>=pending.deadline&&this.store.lateJobTarget(runId))this.store.updateLateJob(runId,{reason});
  }
  async continueLateJob(runId:string,manager:Agent,authorize:()=>void):Promise<void> {
    await this.reloadAdmission.run(`late Job continuation ${runId}`,async()=>{
      const target=this.store.lateJobTarget(runId);
      if(!target||target.pending.state!=='ready'||!this.store.lateJobCanDispatch(runId))return;
      const {run,binding,pending,proof,task}=target;
      const validate=()=>{
        authorize();
        if(this.disposed||!this.store.lateJobCanDispatch(runId)||this.store.botForSession(manager.id)?.id!==task.botId) {
          throw new AppError('recovery-stale','任务授权或执行名额已变更。');
        }
      };
      try {
        validate();
        const resolved=await this.ctx.sessionController.resolveAgent(SessionId(run.sessionId));
        validate();
        if('error' in resolved||resolved.agent.id!==binding.sessionId)throw new AppError('session-unavailable','无法检查原 Worker 会话。');
        const agent=resolved.agent,tree=originalService(this.nativeSubagents());
        this.assertRecoveryQuiet(agent,run.id);this.assertDirectory(agent,binding.cwd);
        await this.confirmRecoveryTree(agent);
        const events=await this.readRunEvents(run,agent.session);
        validate();
        this.assertRecoveryQuiet(agent,run.id);this.assertDirectory(agent,binding.cwd);
        if(tree!==originalService(this.nativeSubagents()))throw new AppError('child-unknown','子树服务已变更。');
        const fresh=verifyLateJobs(run,this.store.getRunInput(run.id),proof,pending.ids,events);
        if(JSON.stringify(fresh)!==JSON.stringify(pending.proof))throw new AppError('late-job-unproven','签收 Job 结果后出现了新的会话活动。');
        verifyLateJobScope(events,proof);
        const model=selectedModel(this.ctx,agent);
        const inherited=!this.options.workerModel&&!model?selectedModel(this.ctx,manager):undefined;
        const plan=workerModelPlan(model?modelRoute(model):null,this.options.workerModel,
          inherited?{sessionId:manager.id,model:modelRoute(inherited)}:undefined);
        if(!plan)throw new AppError('model-required','原 Worker 缺少可核实的模型。');
        const next=this.store.reserveLateJobContinuation(runId,pending.proof,plan);
        try {
          configureRole(this.ctx,agent,'worker',this.options);
          if(inherited)agent.model.select(inherited);
          this.deliverRun(next,agent,binding);
        }catch{this.store.runRecovery(next.id,'续轮投递待核对，保留占用。');}
      }catch(error) {
        if(this.disposed)return;
        if(!(error instanceof AppError))throw error;
        if(error.code==='late-job-unproven'||Date.now()>=pending.deadline) {
          this.store.updateLateJob(runId,{reason:`${error.message} 原任务仍待继续，Bot 保留原执行占用。`});
        } else if(!['recovery-stale','capacity'].includes(error.code)) {
          this.store.deferManagerEvent(`manager-event:late-job-ready:${runId}`,error.message,Date.now()+30000);
        }
      }
    });
  }
  private async priorGitLabTools(agent:Agent,run:Run):Promise<boolean> {
    const release=this.store.gitLabReleaseForRun(run);
    if(!release)return false;
    try {
      const events=await this.readRunEvents(run,agent.session);
      const here=this.store.runTurn(run.id);
      if(here?.startSeq==null)return false;
      const history=this.store.taskRuns(run.taskId).filter(item=>item.id!==run.id&&item.taskRevision===run.taskRevision);
      for(const previous of history) {
        if(previous.sessionId!==run.sessionId||previous.bindingId!==run.bindingId)return false;
        const proof=this.store.runTurn(previous.id);
        if(!proof||proof.startSeq==null||proof.endSeq==null||proof.endSeq>=here.startSeq)return false;
        if(verifyRunTurn(previous,this.store.getRunInput(previous.id),proof,events.slice(0,here.startSeq),true).length)return false;
        if(release.target.newAfterMerge&&release.stage.releaseOpenedAt!==undefined&&
          previous.finishedAt!==null&&previous.finishedAt<=release.stage.releaseOpenedAt)continue;
        const segment=events.slice(proof.startSeq+1,proof.endSeq);
        if(segment.some(event=>event.type==='job/registered'||event.type==='working-directory/change'||
          event.type==='user/message'&&event.seq!==proof.inputSeq&&
          !['runtime-context','time-context','skill-catalog'].includes(event.data.source?.kind)))return false;
        const calls=segment.filter(event=>event.type==='tool/call');
        const results=segment.filter(event=>event.type==='tool/result');
        if(calls.length!==results.length)return false;
        for(const call of calls) {
          const matches=results.filter(result=>result.seq>call.seq&&result.data.step===call.data.step&&
            result.data.message?.toolCallId===call.data.callId);
          if(matches.length!==1)return false;
          const {name}=call.data;
          if(['super_bot_report','read','write','edit',WORKER_QUERY_TOOL].includes(name))continue;
          const formal=name===GITLAB_PLAY_TOOL&&release.plan.retryTarget&&this.store.gitLabReleaseForRun(previous);
          const receipt=formal&&this.store.gitLabReleaseReceipt(formal.stage.runId);
          if(receipt&&['unsubmitted','needs-permission'].includes(receipt.state))continue;
          return false;
        }
      }
      return history.some(item=>item.id===release.stage.runId);
    } catch {return false;}
  }
  private async runGitLabRelease(agent:Agent,run:Run,signal:AbortSignal,authorize:()=>void,
    permitted:(target:ReleaseTarget)=>Promise<boolean>) {
    let receipt=this.store.beginGitLabRelease(run.id);
    const path=releaseJobPath(receipt.target);
    const reader=await gitLabReader(receipt.target.origin,this.options.gitLabObserverOrigin,signal);
    const response=await reader(path,signal);
    authorize();
    let outcome=releaseReadback(receipt,response);
    if(outcome.state!=='unsubmitted'||outcome.nextCheckAt!==null)return this.store.recordGitLabRelease(receipt,outcome,true);
    if(!await this.priorGitLabTools(agent,run)) {
      authorize();
      outcome=releaseReadback({...receipt,state:'unknown'},response);
      return this.store.recordGitLabRelease(receipt,{...outcome,
        detail:`无法排除旧轮中可能影响 ${receipt.target.project} 发布作业 #${receipt.target.jobId} 的外部操作。将只读跟踪原作业。`},true);
    }
    authorize();
    const writer=await glabGitLab(receipt.target.origin,signal);
    const missing=(detail:string)=>this.store.recordGitLabRelease(receipt,{...receipt,state:'needs-permission',detail},true);
    if(!writer)return missing(`当前 Worker 缺少 ${receipt.target.origin} 的同实例 glab 登录，无法运行作业 #${receipt.target.jobId}。请由有权运行该作业的人恢复本机 Worker 登录。`);
    if(!await permitted(receipt.target)) {
      return missing(`当前 Worker 的原生权限或审批未允许启动作业 #${receipt.target.jobId}。请在原生审批入口处理这个作业。`);
    }
    const lastRead=await writer(path,signal);
    authorize();
    if([401,403,404].includes(lastRead.code))return missing(`GitLab 无法以 Worker 身份访问作业 #${receipt.target.jobId}（HTTP ${lastRead.code}）。请由项目负责人核对访问权限。`);
    if(exactJobStatus(lastRead.data,receipt.target)!=='manual') {
      return this.store.recordGitLabRelease(receipt,releaseReadback(receipt,lastRead),true);
    }
    if(!this.store.claimGitLabRelease(run.id)) {
      receipt=this.store.gitLabReleaseReceipt(receipt.stageRunId)??receipt;
      return this.store.recordGitLabRelease(receipt,releaseReadback({...receipt,state:'unknown'},lastRead),true);
    }
    receipt=this.store.gitLabReleaseReceipt(receipt.stageRunId)!;
    const submitted=await writer(path+'/play',signal,'POST');
    const result=releaseReadback(receipt,submitted,true);
    if(result.state==='unknown'&&submitted.code>=200&&submitted.code<300&&!signal.aborted) {
      // The play endpoint may omit the pipeline coordinates. Use its exact
      // job GET representation rather than inferring status from the write.
      const readback=await reader(path,signal);
      return this.store.recordGitLabRelease(receipt,releaseReadback(receipt,readback),true);
    }
    return this.store.recordGitLabRelease(receipt,result,true,true);
  }
  private nativeSubagents():NativeSubagents|undefined {
    return this.ctx.get?.('subagents') as NativeSubagents|undefined;
  }
  private ownedChildEdge(run:Run,check:TreeCheck,carrier:unknown,edge:NativeChildEdge,ending:boolean):void {
    if(this.disposed||!edge?.runId||!edge.id||typeof edge.local!=='boolean'||!edge.provider)return;
    const {agent}=check,owner=carrierKeyOf(carrier) as Agent|undefined;
    const tree=this.nativeSubagents(),usesRoot=!!tree?.waitForTreeWork;
    if(!owner||!tree||originalService(tree)!==check.service||edge.id===agent.id)return;
    const current=check.active.get(edge.runId);
    if(ending&&current) {
      if(current.owner!==owner||current.edge.id!==edge.id||current.edge.local!==edge.local||
        current.edge.provider!==edge.provider||current.edge.parentSessionId!==edge.parentSessionId)return;
      check.active.delete(edge.runId);
      check.ended.add(edge.runId);
      check.revision++;
      if(current.member) {
        const member={...current.member,endedAt:Date.now(),stopReason:edge.stopReason??null};
        for(const wait of check.waits.values())wait.observe(member);
      }
      return;
    }
    if(current||check.ended.has(edge.runId))return;
    const parentSessionId=usesRoot?edge.parentSessionId:owner.id;
    if(!parentSessionId||usesRoot&&owner!==agent)return;
    const sameTurnParent=[...check.active.values()].some(({member})=>member?.sessionId===parentSessionId);
    if(!usesRoot&&owner!==agent&&(!sameTurnParent||this.loadedChild(parentSessionId)!==owner))return;
    if(parentSessionId===edge.id)return;
    const child=edge.local?this.loadedChild(edge.id):undefined;
    try {
      if(usesRoot) {
        const creator=parentSessionId===agent.id?agent:this.loadedChild(parentSessionId);
        if((child&&tree.rootOf?.(child)!==agent)||(creator&&tree.rootOf?.(creator)!==agent))return;
      }else {
        const registry=this.ctx.agents as NativeAgentRegistry;
        if(child&&registry.isOwnedBy&&!registry.isOwnedBy(child.id,owner))return;
      }
    }catch{return;}
    if(ending) {
      // An epoch already resident at dispatch can still invalidate the quiet boundary.
      // Without its paired start it cannot add or update a member in this Run's history.
      check.ended.add(edge.runId);
      check.revision++;
      return;
    }
    const member=this.ownedRunTurn(run,agent)&&(parentSessionId===agent.id||sameTurnParent)
      ?{nativeRunId:edge.runId,childId:edge.id,parentSessionId,sessionId:edge.local?edge.id:null,
        startedAt:Date.now(),endedAt:null,stopReason:null}:undefined;
    check.active.set(edge.runId,{edge,owner,member});
    check.revision++;
    if(member)for(const wait of check.waits.values())wait.observe(member);
  }
  private loadedChild(id:string):Agent|undefined {
    return this.ctx.agents.get?.(SessionId(id))??this.ctx.agents.list().find(child=>child.id===id);
  }
  private ownedRunTurn(run:Run,agent:Agent) {
    const turn=this.turnStarts.get(agent.session),proof=this.store.runTurn(run.id);
    if(turn&&proof?.turn===turn.turn&&proof.startSeq===turn.seq&&proof.inputSeq!==null&&
      this.autoTurns.has(run.id)&&this.store.getRun(run.id).finishedAt===null) {
      return {runId:run.id,turn:turn.turn,startSeq:turn.seq,inputSeq:proof.inputSeq};
    }
  }
  private childWait(run:Run,agent:Agent,source:RunChildWait['source']) {
    const check=this.treeChecks.get(run.id);
    const boundary=check?.agent===agent&&this.ownedRunTurn(run,agent);
    if(!check||!boundary)return;
    const members=[...check.active.values()].flatMap(({member})=>member?[member]:[]);
    return new ChildWaitObservation({...boundary,source},members,(edge,wait)=>{
      try {this.store.recordChildWait(run.taskId,edge,wait);return true;}
      catch {
        // Display evidence is best effort. It never decides whether native work can settle.
        this.ctx.logger?.warn(`[super-bot] Could not record child wait ${wait.id} (${edge}) for run ${run.id}`);
        return false;
      }
    });
  }
  childWaitDetails(taskId:string):ChildWaitDetail[] {
    const now=Date.now(),service=originalService(this.nativeSubagents());
    return this.store.taskChildWaits(taskId).map(wait=>{
      if(wait.outcome==='waiting'||wait.outcome==='checking') {
        const check=this.treeChecks.get(wait.runId);
        if(!check?.waits.has(wait.id)||!service||check.service!==service||this.store.getRun(wait.runId).finishedAt!==null) {
          return {...wait,outcome:'unknown',elapsedMs:null};
        }
        return {...wait,elapsedMs:Math.max(0,now-wait.startedAt)};
      }
      return {...wait,elapsedMs:wait.endedAt===null?null:Math.max(0,wait.endedAt-wait.startedAt)};
    });
  }
  /** rc.1/rc.5 own admission, draining and result delivery. */
  private async waitForTreeWork(agent:Agent,signal:AbortSignal,check?:TreeCheck,observation?:ChildWaitObservation):Promise<boolean> {
    signal.throwIfAborted();
    const tree=this.nativeSubagents();
    if(!tree&&!check?.service)return false;
    const identity=originalService(tree);
    if(check?.service&&check.service!==identity)throw new AppError('child-unknown','原生子树服务已改变，不能证明收敛。');
    if(check)check.service=identity;
    const wait=tree?.waitForTreeWork??tree?.waitForChildren;
    if(!wait)throw new AppError('child-unknown','原生子树等待能力不可用，不能证明收敛。');
    let abort!:()=>void;
    const cancelled=new Promise<never>((_resolve,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
    });
    if(check)check.pendingWaits++;
    // The caller can abort immediately. Until the native wait settles, an invisible
    // external child or a materialization can still be live at the parent's end.
    const work=(async()=>{
      const joined=await wait.call(tree,agent);
      if(typeof joined!=='boolean')throw new AppError('child-unknown','原生子树等待未返回可核对状态。');
      if(originalService(this.nativeSubagents())!==identity)throw new AppError('child-unknown','原生子树服务已改变，不能证明收敛。');
      if(check)check.waitFailed=false;
      return joined;
    })().catch(error=>{
      if(check)check.waitFailed=true;
      throw error;
    }).finally(()=>{if(check)check.pendingWaits--;});
    // Allow an already-clear native wait to return false without leaving a history row.
    // An unresolved call with no published members is shown as checking, with an unknown count.
    const present=observation&&setImmediate(()=>observation.publish());
    if(observation)check?.waits.set(observation.id,observation);
    try {
      const joined=await Promise.race([work,cancelled]);
      signal.throwIfAborted();
      const outcome=check?.active.size?'unknown':joined?'converged':'clear';
      observation?.finish(outcome,Date.now(),joined);
      return joined;
    }catch(error) {
      observation?.finish(signal.aborted&&!this.disposed?'cancelled':'unknown',this.disposed?null:Date.now());
      throw error;
    }finally{
      if(present)clearImmediate(present);
      if(observation)check?.waits.delete(observation.id);
      signal.removeEventListener('abort',abort);
    }
  }
  private assertObservedTreeQuiet(check?:TreeCheck):void {
    if(check?.pendingWaits||check?.active.size)throw new AppError('child-active','子 Agent 树仍有活动或清理未完成，保留执行名额。');
    if(check?.service) {
      const tree=this.nativeSubagents();
      if(check.waitFailed||originalService(tree)!==check.service||(!tree?.waitForTreeWork&&!tree?.waitForChildren)) {
        throw new AppError('child-unknown','原生子树状态不可核对，保留执行名额。');
      }
    }
  }
  private assertQuiet(agent:Agent):void {
    if(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)throw new AppError('session-busy','任务会话有活动或待处理输入，请先在原生会话核对。');
    this.assertExternalQuiet(agent);
  }
  private assertExternalQuiet(agent:Agent):void {
    if(this.ctx.jobs.list(agent.id).some(job=>job.owner===agent.id&&['running','stopping'].includes(job.status)))throw new AppError('job-active','后台工作尚未停止，不能开始或确认执行结束。');
    this.assertChildrenQuiet(agent);
  }
  private assertChildrenQuiet(agent:Agent):void {
    const children=this.ctx.agents.list().filter(child=>child!==agent);
    if(!children.length)return;
    const registry=this.ctx.agents as NativeAgentRegistry;
    const tree=registry.isOwnedBy?undefined:this.nativeSubagents();
    if(!registry.isOwnedBy&&!tree?.rootOf)throw new AppError('child-unknown','无法核对子 Agent 的归属与运行状态。');
    const activeChild=children.some(child=>{
      if(registry.isOwnedBy)return registry.isOwnedBy(child.id,agent);
      if(tree!.rootOf!(child)!==agent)return false;
      return child.status!=='idle'||child.inbox.nextTurn.length>0||child.inbox.nextStep.length>0||this.ctx.jobs.list(child.id).some(job=>job.owner===child.id&&['running','stopping'].includes(job.status));
    });
    if(activeChild)throw new AppError('child-active','会话仍有子 Agent，需要先核对。');
  }
  private assertDirectory(agent:Agent,cwd:string):void {
    let current:string;try{current=realpathSync(this.ctx.workingDirectory.get(agent.session));}catch{throw new AppError('working-directory-unavailable','原生会话目录不可用，请先恢复目录或解除关联后准备新会话。');}
    if(current!==cwd)throw new AppError('working-directory-changed','原生会话当前目录已改变。请在原生会话恢复任务目录，或解除关联后准备新会话。');
  }
  async inspectExistingSession(taskId:string,sessionId:string):Promise<ExistingSessionPreview> {
    this.store.assertSessionAttachable(taskId,sessionId);
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
    if('error' in resolved)throw new AppError('session-unavailable','找不到可关联的原生会话。请核对 Session ID。');
    const agent=resolved.agent;
    if(agent.session.header.origin==='subagent')throw new AppError('session-child','子 Agent 会话不能作为独立任务会话关联。');
    let cwd:string;try{cwd=await realpath(this.ctx.workingDirectory.get(agent.session));}catch{throw new AppError('working-directory-unavailable','会话当前目录不可用，暂不能关联。');}
    try{this.assertQuiet(agent);}catch(error){return {sessionId,cwd,quiet:false,reason:error instanceof AppError?error.message:'会话活动暂无法确认。'};}
    return {sessionId,cwd,quiet:true,reason:''};
  }
  async attachExistingSession(requestId:string,grant:ExistingSessionGrant,authorize=()=>{}):Promise<Binding> {
    authorize();
    const receipt=this.store.commandReceipt<Binding>(requestId,'session.attach',grant);
    if(receipt)return this.store.getBinding(receipt.id);
    if(grant.fullHistoryApproved!==true||grant.directoryApproved!==true)throw new AppError('confirmation-required','请明确授权读取整个会话历史，以及在所示目录内执行文件任务。');
    const preview=await this.inspectExistingSession(grant.taskId,grant.sessionId);
    if(!preview.quiet)throw new AppError('session-busy',preview.reason);
    if(preview.cwd!==grant.cwd)throw new AppError('working-directory-changed','会话当前目录已改变，请重新检查后授权。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(grant.sessionId));
    authorize();
    if('error' in resolved)throw new AppError('session-unavailable','会话暂不可用。');
    this.assertQuiet(resolved.agent);this.assertDirectory(resolved.agent,grant.cwd);
    return this.store.attachExistingSession(requestId,grant);
  }
  async dispatch(requestId:string,taskId:string,rowVersion:number,authorize:()=>void=()=>{},manager?:Agent):Promise<Run> {
    if(this.disposed)throw new AppError('unavailable','插件正在退出。');
    const receipt=this.store.commandReceipt<Run>(requestId,'task.dispatch',{taskId,expectedRowVersion:rowVersion});
    if(receipt)return this.store.getRun(receipt.id);
    return this.reloadAdmission.run(`Worker task ${taskId} dispatch preflight`,()=>this.dispatchRun(requestId,taskId,rowVersion,authorize,manager));
  }
  private async dispatchRun(requestId:string,taskId:string,rowVersion:number,authorize:()=>void,manager?:Agent):Promise<Run> {
    const task=this.store.getTask(taskId);
    if(task.status==='recovery')throw new AppError('recovery-required','请先在任务详情完成恢复核对。');
    if(task.status==='blocked')throw new AppError('work-blocked','上一轮已结束，仍有任务前置或下一步需要核对。');
    const b=this.store.activeBinding(taskId);if(!b?.sessionId||b.state!=='ready')throw new AppError('not-ready','请先准备执行会话。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(b.sessionId));
    if(this.disposed)throw new AppError('unavailable','插件正在退出。');
    if('error' in resolved||resolved.agent.id!==b.sessionId)throw new AppError('session-unavailable','执行会话暂不可用，请核对。');
    authorize();
    // The same command may have completed as the native Session was resolving.
    const receipt=this.store.commandReceipt<Run>(requestId,'task.dispatch',{taskId,expectedRowVersion:rowVersion});
    if(receipt)return this.store.getRun(receipt.id);
    if(this.store.activeBinding(taskId)?.id!==b.id||this.store.getTask(taskId).rowVersion!==rowVersion)
      throw new AppError('version-conflict','任务已经更新，请刷新后再执行。');
    const agent=resolved.agent;this.assertQuiet(agent);this.assertDirectory(agent,b.cwd);
    const current=selectedModel(this.ctx,agent);
    const inherited=!this.options.workerModel&&!current&&manager&&this.store.botForSession(manager.id)?.id===task.botId
      ?selectedModel(this.ctx,manager):undefined;
    const plan=workerModelPlan(current?modelRoute(current):null,this.options.workerModel,
      inherited&&manager?{sessionId:manager.id,model:modelRoute(inherited)}:undefined);
    if(!plan)throw new AppError('model-required','请先打开任务会话，明确选择并配置模型，再回来开始执行。宿主默认路由不算已选择。');
    const run=this.store.reserveRun(requestId,taskId,rowVersion,plan);
    try {
      configureRole(this.ctx,agent,'worker',this.options,!!this.store.gitLabReleaseForRun(run));
      if(inherited)agent.model.select(inherited);
    } catch {
      this.store.runRecovery(run.id,'配置本次执行会话时失败，尚未投递。请核对原生会话。');
      return this.store.getRun(run.id);
    }
    return this.deliverRun(run,agent,b);
  }
  private deliverRun(run:Run,agent:Agent,b:Binding,recovery?:{note:string|null}):Run {
    if(this.running.has(run.id)||run.finishedAt!==null)return this.store.getRun(run.id);
    const taskId=run.taskId,task=this.store.getTask(taskId);
    const work=this.store.recoveryWorkPlan(run.id);
    const readOnly=work?.context.mode==='read-only';
    const nativeFullAccess=fullAccessEnabled(this.options),lateContinuation=!!work?.context.lateJobs;
    const fullAccess=nativeFullAccess&&!lateContinuation;
    const standing=workerStandingPrompt(task,b,this.store.taskBotContext(taskId),nativeFullAccess);
    const folder=lateContinuation?join(b.cwd,`.super-bot-reports-${run.id}`):undefined;
    if(folder)mkdirSync(folder,{mode:0o700});
    let input=this.store.getRunInput(run.id);
    const previous=this.store.previousWorkerInputs(run);
    if(!input.messageJson) {
      const prompt=workerPromptPlan(agent,run,standing,previous);
      const context=folder?{...work!.context,outputDirectory:folder}:work?.context;
      const message=createWorkerRunMessage(run,input,standing,prompt,recovery,context);
      input=this.store.saveRunMessage(run.id,message.id,JSON.stringify(message));
    }
    const releaseAction=this.store.gitLabReleaseForRun(run);
    const allowed=releaseAction?[GITLAB_PLAY_TOOL,'super_bot_report']:readOnly?['read','super_bot_report',...(fullAccess?[WORKER_QUERY_TOOL]:[]),
      ...(work.authorizedProbes.length?['super_bot_preflight']:[])]:['read','write','edit','super_bot_report'];
    const releaseMask=fullAccess&&!readOnly&&!releaseAction?()=>{}:agent.ctx.tools.restrict({allow:allowed});
    const releaseGuard=agent.ctx.tools.guard(exec=>{
      const current=this.store.getRun(run.id);
      if(current.finishedAt!==null||current.state==='cancelling'||this.store.getTask(taskId).controlMode==='manual'||this.store.isBotDeleted(task.botId))return 'This automatic run no longer has task authority.';
      if(lateContinuation&&(this.store.getTask(taskId).controlMode!=='auto'||this.store.getTask(taskId).taskRevision!==run.taskRevision))return 'This continuation no longer has task authority.';
      if(exec.name!=='super_bot_report'&&this.store.finalReport(run.id))return 'A final report has been submitted; no new tool work is authorized in this run.';
      if(releaseAction&&!allowed.includes(exec.name))return 'Only the verified GitLab action and reporting are authorized for this stage.';
      if(readOnly&&(this.store.getTask(taskId).controlMode!=='auto'||!allowed.includes(exec.name)))return 'This continuation authorizes only the available read-only checks and a report.';
      if(!fullAccess&&!allowed.includes(exec.name))return 'Only task file tools and super_bot_report are authorized for this run.';
      if(fullAccess&&!readOnly)return;
      try{this.assertDirectory(agent,b.cwd);}catch(error){return error instanceof Error?error.message:'Working directory changed';}
      if(!['read','write','edit'].includes(exec.name))return;
      try {
        const {file_path:path}=exec.arguments as {file_path?:unknown};
        if(typeof path!=='string'||!isAbsolute(path))return 'Use an absolute file_path inside the task working directory.';
        const canonical=containedPath(b.cwd,path);
        if(folder&&exec.name==='read'&&!statSync(canonical).isFile())return 'Read only regular files.';
        if(folder&&exec.name!=='read') {
          if(realpathSync(folder)!==folder||containedPath(folder,path)!==path||canonical!==path) {
            return 'Write only new report files in the isolated report directory.';
          }
          const current=lstatSync(path,{throwIfNoEntry:false});
          if(current&&(!current.isFile()||current.nlink!==1))return 'The report must be a regular single-link file.';
        }
      }catch(error){return error instanceof Error?error.message:'File path refused';}
    });
    let steps=0;let deadline:ReturnType<typeof setTimeout>|undefined;
    const releaseBudget=fullAccess&&!readOnly?()=>{}:agent.ctx.on('agent/pre-step',async(_payload,next)=>{
      if(++steps>40){await this.stopForBudget(run.id,'steps');throw new AppError('run-budget','执行达到步数上限。');}
      return next();
    });
    let released=false;
    let releaseContext=()=>{};
    const release=()=>{
      if(released)return;
      released=true;clearTimeout(deadline);
      releaseContext();
      releaseStatus();releaseStopping();
      if(!this.deletedRuns.has(run.id))treeCheck.releaseEvents?.();
      for(const wait of treeCheck.waits.values())wait.finish('unknown',null);
      treeCheck.waits.clear();
      releaseBudget();releaseGuard();releaseMask();
    };
    // The next queued human turn can start without an idle transition. Only
    // this run's turn/end can certify closure. Idle is the failure fallback.
    let finalized=false,stoppingProof:{turn:number;revision:number}|undefined;
    const treeCheck:TreeCheck={agent,revision:0,active:new Map(),ended:new Set(),waits:new Map(),
      pendingWaits:0,service:originalService(this.nativeSubagents())};
    this.treeChecks.set(run.id,treeCheck);
    // Both versions bind the native owner as `this`. A scoped listener may also receive descendant carriers.
    const treeEvents=agent.ctx as unknown as {on:(event:string,listener:(this:unknown,info:NativeChildEdge)=>void)=>()=>void};
    const execution=this;
    const releaseTreeStart=treeEvents.on('subagent/start',function(info){execution.ownedChildEdge(run,treeCheck,this,info,false);});
    const releaseTreeEnd=treeEvents.on('subagent/end',function(info){execution.ownedChildEdge(run,treeCheck,this,info,true);});
    treeCheck.releaseEvents=()=>{releaseTreeStart();releaseTreeEnd();this.treeChecks.delete(run.id);};
    const releaseStopping=agent.ctx.on('agent/turn-stopping',async({agent:subject,turn,signal})=>{
      // This scoped hook is awaited by the native loop BEFORE it rechecks nextStep.
      // Never hold an unrelated turn/driver, or repair an already ended Run here.
      if(subject!==agent||!this.autoTurns.has(run.id)||this.store.getRun(run.id).finishedAt!==null||this.store.runTurn(run.id)?.turn!==turn)return;
      stoppingProof=undefined;
      try {
        const joined=await this.waitForTreeWork(agent,signal,treeCheck,this.childWait(run,agent,'turn-stopping'));
        signal.throwIfAborted();
        if(this.store.finalReport(run.id)&&(joined||treeCheck.reportRevision!==treeCheck.revision||hasPendingChildResult(agent))) {
          throw new AppError('report-stale','最终报告之后仍有子树工作；旧证据不能补成功，请核对。');
        }
        this.assertChildrenQuiet(agent);
        this.assertObservedTreeQuiet(treeCheck);
        stoppingProof={turn,revision:treeCheck.revision};
      }catch(error) {
        if(!signal.aborted)this.store.runRecovery(run.id,error instanceof AppError?error.message:'子树收敛无法证明，请核对原生会话，保留占用。');
        throw error;
      }
    });
    const finishTurn=(endSeq?:number,endKind?:string,endTime?:number,endNote?:string)=>{
      if(finalized||this.disposed)return;
      finalized=true;this.autoTurns.delete(run.id);
      try {
        for(const wait of treeCheck.waits.values())wait.finish(endKind==='aborted'?'cancelled':'unknown',endTime??null);
        let quiet=true,note='',jobIds:string[]|undefined;
        try {
          this.assertChildrenQuiet(agent);
          this.assertObservedTreeQuiet(treeCheck);
          if(endKind==='completed'&&(treeCheck.service||this.nativeSubagents())&&
            (!stoppingProof||stoppingProof.turn!==this.store.runTurn(run.id)?.turn||stoppingProof.revision!==treeCheck.revision)) {
            throw new AppError('child-unknown','原进程结束前没有同轮子树安静证明；不会用稍后空闲补成功。');
          }
          const activeJobs=this.ctx.jobs.list(agent.id).filter(job=>job.owner===agent.id&&['running','stopping'].includes(job.status));
          if(activeJobs.length) {
            jobIds=activeJobs.map(job=>job.id);
            throw new AppError('job-active','后台工作尚未停止，不能开始或确认执行结束。');
          }
        }catch(error){quiet=false;note=error instanceof AppError?error.message:'后台效果尚未核对。';}
        if(endSeq!==undefined&&endKind)this.store.observeRunEnd(run.id,endSeq,endKind,quiet,jobIds);
        if(this.store.getRun(run.id).finishedAt!==null||this.store.isBotDeleted(task.botId))return;
        if(!quiet)throw new AppError('run-proof',note);
        if(endNote)throw new AppError('run-proof',endNote);
        if(endSeq===undefined)throw new AppError('run-proof','没有可归属的自动轮次结束事件；仅会话空闲不足以补成功。');
        this.scheduleReconciliation(run.id,agent.session);
      }catch(error){this.store.runRecovery(run.id,error instanceof AppError?error.message:'执行状态待核对，请打开原生会话检查。');}
      finally{release();this.running.delete(run.id);}
    };
    const releaseStatus=agent.ctx.on('agent/status',({agent:subject,status})=>{
      if(subject===agent&&status==='idle')finishTurn();
    });
    try {
      const message=freezeMessage(JSON.parse(input.messageJson!) as UserMessage);
      releaseContext=registerWorkerContext(agent,run,standing,message,previous,
        ()=>this.store.runTurn(run.id)?.turn!=null,
        ()=>{
          const active=this.store.getRun(run.id),current=this.store.getTask(taskId);
          return !this.disposed&&active.finishedAt===null&&active.state!=='cancelling'&&current.taskRevision===run.taskRevision
            &&current.controlMode!=='manual'&&this.store.activeBinding(taskId)?.id===b.id&&!this.store.isBotDeleted(task.botId);
        });
      if(!this.store.claimDispatch(run.id)){release();this.store.runRecovery(run.id,'投递记录已经发出，但回执不完整。没有重复投递，请核对原生会话。');return this.store.getRun(run.id);}
      agent.followup(message);
      this.autoTurns.add(run.id);
      this.store.inputEnqueued(run.id);
      if(!fullAccess||readOnly){deadline=setTimeout(()=>{void this.stopForBudget(run.id,'time');},10*60*1000);deadline.unref();}
      const done=agent.whenIdle().then(()=>{
        if(this.disposed||finalized)return;
        this.assertQuiet(agent);finishTurn();
      }).catch(error=>{if(!this.disposed&&!finalized)this.store.runRecovery(run.id,error instanceof AppError?error.message:'执行状态待核对，请打开原生会话检查。');}).finally(()=>{
        this.autoTurns.delete(run.id);release();this.running.delete(run.id);
        if(!this.disposed)void Promise.resolve(this.finishing.get(run.id)).then(()=>this.advanceClose(taskId,true));
      });
      this.running.set(run.id,{agent,release,done,finishTurn});
      return this.store.getRun(run.id);
    }catch(error){
      // A throw may happen AFTER the inbox accepted the message. Keep the mask until idle.
      try{this.store.runRecovery(run.id,'输入投递未能确认，没有自动重投。请核对原生会话。');}
      finally {
        if(input.messageId)agent.inbox.remove(input.messageId as UserMessage['id']);
        agent.cancel({kind:'user'},{keepInbox:true});
        const done=agent.whenIdle().catch(()=>{}).finally(()=>{release();this.running.delete(run.id);});
        this.running.set(run.id,{agent,release,done,finishTurn});
      }
      throw error;
    }
  }
  private async stopForBudget(runId:string,kind:'steps'|'time'):Promise<void> {
    try {
      if(!this.store.recordRunBudget(runId,kind))return;
      const run=this.store.getRun(runId),task=this.store.getTask(run.taskId);
      await this.stop(`budget-stop:${runId}`,task.id,task.rowVersion);
    }catch{this.store.runRecovery(runId,'执行预算已用尽，停止结果需要核对；没有自动重试。');}
  }
  async accept(requestId:string,taskId:string,rowVersion:number,resultId:string,authorize?:()=>void,source?:import('./model.ts').ChatSource) {
    authorize?.();
    const receipt=this.store.commandReceipt<Task>(requestId,'result.accept',{taskId,expectedRowVersion:rowVersion,resultId,...(source?{source}:{})});
    if(receipt)return receipt;
    await this.verifyResult(taskId,resultId);
    authorize?.();
    const task=this.store.acceptResult(requestId,taskId,rowVersion,resultId,source);
    await this.autoCleanup(taskId);return task;
  }
  /** Removes a finished task's provisioned directory. Existing directories and running tasks are refused. */
  async cleanupWorkdir(taskId:string,authorize=()=>{}):Promise<Binding> {
    authorize();
    const task=this.store.getTask(taskId),binding=this.store.latestBinding(taskId);
    if(!binding)throw new AppError('not-found','任务还没有工作目录。');
    if(!['completed','cancelled'].includes(task.lifecycle)&&binding.state!=='released')throw new AppError('task-active','任务结束（完成或取消）或解除会话关联后才能清理工作目录。');
    if(this.store.heldRuns().some(run=>run.taskId===taskId))throw new AppError('run-active','执行尚未收敛，不能清理。');
    const info=binding.workdir??{mode:'existing' as const,state:'provisioned' as const};
    return this.store.setBindingWorkdir(binding.id,await cleanupWorkdir(binding.cwd,info,taskId,this.policy));
  }
  private async autoCleanup(taskId:string):Promise<void> {
    if(this.policy.cleanup!=='on-complete')return;
    const mode=this.store.latestBinding(taskId)?.workdir?.mode;
    if(!mode||mode==='existing'||mode==='default'||(mode==='hook'&&!this.policy.hook?.remove))return;
    try{await this.cleanupWorkdir(taskId);}
    catch(error){this.store.note('workdir.cleanup-failed',taskId,{message:error instanceof Error?error.message.slice(0,500):'unknown'});}
  }
  async verifyResult(taskId:string,resultId:string) {
    const detail=this.store.taskDetail(taskId);
    if(detail.task.status==='recovery')throw new AppError('recovery-required','请先在任务详情完成恢复核对。');
    if(!detail.result||detail.result.id!==resultId||!detail.binding?.sessionId)throw new AppError('result-stale','当前成果不存在或已经改变。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(detail.binding.sessionId));
    if('error' in resolved)throw new AppError('session-unavailable','无法核对原生会话，暂未验收。');
    this.assertQuiet(resolved.agent);await verifyEvidence(detail.binding.cwd,detail.result.evidence);this.assertQuiet(resolved.agent);
    return detail;
  }
  async stop(requestId:string,taskId:string,rowVersion:number,expectedRunId?:string,authorize=()=>{}) {
    authorize();
    const exact=expectedRunId?this.store.latestRun(taskId):null;
    if(exact&&exact.id===expectedRunId&&this.finishing.has(exact.id)) {
      // A repeat may read its receipt, but a fresh stop must not change ongoing settlement.
      const prior=this.store.commandReceipt<ReturnType<Store['requestStop']>>(requestId,'task.stop',
        {taskId,expectedRowVersion:rowVersion,expectedRunId});
      if(prior)return prior;
      throw new AppError('run-finishing','这次执行正在结算，请等待结算回执。');
    }
    const receipt=this.store.requestStop(requestId,taskId,rowVersion,expectedRunId);
    if(exact?.id===receipt.runId&&exact.state==='cancelling')return receipt;
    this.sendStop(receipt.runId);
    return receipt;
  }
  private sendStop(runId:string):void {
    const run=this.store.getRun(runId);
    if(run.finishedAt!==null||this.finishing.has(runId))return;
    const active=this.running.get(runId);
    if(!active){this.store.runRecovery(runId,'停止请求已记录，但当前宿主没有这个执行句柄，请核对原生会话。');return;}
    try {
      const input=this.store.getRunInput(runId);
      if(input.messageId)active.agent.inbox.remove(input.messageId as UserMessage['id']);
      active.agent.cancel({kind:'user'},{keepInbox:true});
      for(const job of this.liveWorkerJobs(active.agent.id))this.ctx.jobs.kill(job.id,active.agent.id,'Super Bot stop');
    }catch {
      this.store.runRecovery(runId,'停止请求已记录，但宿主停止操作未能确认，请核对原生会话与后台工作。');
      return;
    }
    const timeout=setTimeout(()=>{
      if(this.disposed||this.store.getRun(runId).finishedAt!==null)return;
      this.store.runRecovery(runId,'停止已请求，但 10 秒内未确认收敛。请核对原生会话与后台工作。');
      void this.advanceClose(run.taskId,true);
    },10000);timeout.unref();
    void active.done.finally(()=>clearTimeout(timeout));
  }
  private withdrawWorkerInput(run:Run,agent:Agent):boolean {
    const id=this.store.getRunInput(run.id).messageId;
    for(const message of [...agent.inbox.nextTurn,...agent.inbox.nextStep]) {
      const source=message.source;
      if(message.id===id&&source.kind==='super-bot'&&source.runId===run.id&&source.inputId===run.inputId&&
        source.taskId===run.taskId&&source.taskRevision===run.taskRevision&&source.generation===run.generation) {
        return agent.inbox.remove(message.id);
      }
    }
    return false;
  }
  private liveWorkerJobs(id:Agent['id']) {
    return this.ctx.jobs.list(id).filter(job=>job.owner===id&&(job.status==='running'||job.status==='stopping'));
  }
  /** The tombstone and dispatch withdrawal have already committed. */
  stopDeletedBot(botId?:string):void {
    for(const run of this.store.deletedBotRuns(botId)) {
      if(this.disposed||this.deletedRuns.has(run.id))continue;
      const controller=new AbortController();
      this.deletedRuns.set(run.id,controller);
      void this.stopDeletedWorker(run,controller.signal).catch(()=>{
        if(!controller.signal.aborted)this.store.runRecovery(run.id,'强制删除已撤销 Bot，Worker 停止结果待核对。',false);
      }).finally(()=>{
        controller.abort();this.deletedRuns.delete(run.id);
        if(!this.running.has(run.id))this.treeChecks.get(run.id)?.releaseEvents?.();
      });
    }
  }
  private async stopDeletedWorker(run:Run,signal:AbortSignal):Promise<void> {
    const id=SessionId(run.sessionId),tracked=this.running.get(run.id),check=this.treeChecks.get(run.id);
    const agent=tracked?.agent??this.ctx.agents.get?.(id);
    const proof=this.store.runTurn(run.id),input=this.store.getRunInput(run.id);
    const ownsTurn=()=>{
      if(!agent||agent.status!=='running')return false;
      const coordinates=this.turnStarts.get(agent.session),current=this.store.runTurn(run.id);
      if(current?.turn!=null)return current.endSeq===null&&coordinates?.turn===current.turn&&coordinates.seq===current.startSeq;
      // A Super Bot wake can be running pre-step before it durably enters a turn.
      return this.running.get(run.id)===tracked&&!!tracked&&this.autoTurns.has(run.id);
    };
    const ownAtDeletion=ownsTurn(),withdrawn=agent&&this.withdrawWorkerInput(run,agent);
    const stoppedJobs=new Set<JobId>(),knownJobs=new Map<JobId,Agent['id']>();
    const interruptedChildren=new Set<Agent['id']>();
    const treeCheck:{state:'not-observed'|'pending'|'quiet'|'unknown'}={state:'not-observed'};
    const requestJobStops=(owner:Agent['id'],jobs:ReturnType<DshExecution['liveWorkerJobs']>)=>{
      for(const job of jobs) {
        knownJobs.set(job.id,owner);
        if(stoppedJobs.has(job.id)||job.status==='stopping')continue;
        try {this.ctx.jobs.kill(job.id,owner,'Super Bot force delete');stoppedJobs.add(job.id);}
        catch { /* Keep capacity while the observed job is still live. */ }
      }
    };
    const stopChildren=()=>{
      let live=false;
      const tree=this.nativeSubagents();
      for(const {member,edge} of check?.active.values()??[]) {
        if(!member||!agent)continue;
        const childId=SessionId(edge.id);
        const local=edge.local?this.loadedChild(childId):undefined;
        live ||= local?.status==='running'||(treeCheck.state!=='quiet'&&Boolean(tree&&originalService(tree)===check?.service));
        if(!interruptedChildren.has(childId)) {
          try {
            tree?.interrupt?.(childId,{kind:'ancestor',agent});
            interruptedChildren.add(childId);
          }catch { /* Retry while the exact child can still be observed. */ }
        }
        if(edge.local)requestJobStops(childId,this.liveWorkerJobs(childId));
      }
      return live;
    };
    if(ownAtDeletion&&agent) {
      requestJobStops(id,this.liveWorkerJobs(id));stopChildren();
      try {agent.cancel({kind:'user'},{keepInbox:true});}
      catch { /* The running turn still has to converge before release. */ }
      treeCheck.state='pending';
      void this.waitForTreeWork(agent,signal).then(()=>{treeCheck.state='quiet';},()=>{treeCheck.state='unknown';});
    }
    // Recovery may have lost its process-local Run handle while leaving a known
    // job executing. Only interrupt jobs whose registration was in this Run's turn.
    let durableQuiet=false;
    if(!ownAtDeletion&&proof?.inputSeq!=null) {
      try {
        const events=await this.readRunEvents(run,agent?.session);
        signal.throwIfAborted();
        const entered=events[proof.inputSeq],source=entered?.type==='user/message'?entered.data.source:undefined;
        if(entered?.type==='user/message'&&entered.data.id===input.messageId&&source?.kind==='super-bot'&&
          source.runId===run.id&&source.inputId===run.inputId&&source.taskId===run.taskId&&
          source.taskRevision===run.taskRevision&&source.generation===run.generation) {
          const tail=events.slice(proof.inputSeq+1),boundary=tail.findIndex(event=>event.type==='turn/end'||event.type==='turn/start');
          const jobIds=new Set(tail.slice(0,boundary<0?undefined:boundary)
            .flatMap(event=>event.type==='job/registered'&&event.data.owner===id?[event.data.jobId]:[]));
          requestJobStops(id,this.liveWorkerJobs(id).filter(job=>jobIds.has(job.id)));
        }
        if(proof.quiet) {
          verifyRunTurn({...run,state:'cancelling'},input,proof,events);
          durableQuiet=true;
        }
      } catch { /* Missing durable evidence is recorded as unknown if no live observation can settle it. */ }
    }
    while(!signal.aborted) {
      const parentLive=ownsTurn();
      if(parentLive)requestJobStops(id,this.liveWorkerJobs(id));
      const childLive=stopChildren();
      const owners=new Set(knownJobs.values());
      let jobsLive=false;
      for(const owner of owners) {
        const jobs=this.liveWorkerJobs(owner).filter(job=>knownJobs.has(job.id));
        requestJobStops(owner,jobs);jobsLive ||= jobs.length>0;
      }
      const nextTurn=!parentLive&&agent?.status==='running'&&this.turnStarts.has(agent.session);
      if(!parentLive&&!jobsLive&&!childLive&&(treeCheck.state!=='pending'||nextTurn))break;
      await delay(250,undefined,{signal,ref:false});
    }
    signal.throwIfAborted();
    const confirmed=durableQuiet||(ownAtDeletion?treeCheck.state==='quiet':withdrawn===true&&proof?.inputSeq==null);
    this.store.finishDeletedRun(run.id,confirmed,confirmed?'已核对强制删除时撤销或结束的 Worker 执行。':
      '强制删除已撤销执行授权并释放调度名额；历史执行或外部效果仍未核对。');
  }
  async modelPreview(botId:string,taskId?:string,managerAgent?:Agent):Promise<WorkerModelPreview> {
    const binding=taskId?this.store.activeBinding(taskId):null;
    const workerId=binding?.state==='ready'?binding.sessionId:null;
    const observe=(id:string,active?:Agent)=>{
      const agent=active?.id===id&&active.session?active:this.ctx.agents.get?.(SessionId(id));
      return observeNativeModel(this.ctx,id,agent?.session);
    };
    const current=workerId?await observe(workerId):null;
    const manager=this.store.activeManager(botId);
    const managerId=manager?.state==='ready'&&manager.sessionId&&this.store.botForSession(manager.sessionId)?.id===botId
      ?manager.sessionId:null;
    const inherited=managerId&&!current&&!this.options.workerModel
      ? {sessionId:managerId,model:await observe(managerId,managerAgent)}:undefined;
    return {current,expected:workerModelPlan(current,this.options.workerModel,inherited)};
  }

  async modelHistory(taskId:string):Promise<RunModels[]> {
    const logs=new Map<string,ReturnType<typeof readModelLog>>();
    const readLog=(id:string)=>{
      const previous=logs.get(id);if(previous)return previous;
      const next=readModelLog(this.ctx,id);logs.set(id,next);return next;
    };
    return Promise.all(this.store.taskRuns(taskId).map(async run=>{
      const input=this.store.getRunInput(run.id),proof=this.store.runTurn(run.id),expected=this.store.runModelPlan(run.id);
      return {runId:run.id,sessionId:run.sessionId,createdAt:run.createdAt,expected,
        actual:input.messageId?actualModelRequests(await readLog(run.sessionId),run,input,proof):[]};
    }));
  }

  recoveryDetail(detail:ReturnType<Store['taskDetail']>):RecoveryDetail|null {
    if(detail.task.status!=='recovery')return null;
    let attentionId:string|null=null,canContinue=false;
    try {
      const target=this.store.recoveryTarget(detail.task.id,detail.task.rowVersion);
      attentionId=target.attentions[0]!;
      canContinue=!detail.closeRequest&&!!target.binding&&target.task.lifecycle==='open'&&!!target.task.scope&&!!target.task.acceptance;
    }catch(error){if(!(error instanceof AppError))throw error;}
    const b=detail.binding,task=detail.task;
    const sessionId=b?.state==='ready'&&b.taskRevision===task.taskRevision&&b.sessionId===task.sessionId?b.sessionId:null;
    const agent=sessionId?this.ctx.agents.get(SessionId(sessionId)):undefined;
    const {jobs,subtree}=this.observeRecoveryActivity(sessionId,agent,detail.run?.bindingId===b?.id?detail.run?.id:undefined);
    return {attentionId,canContinue,jobs,subtree,worker:sessionId?{
      sessionId,status:agent?.status??null,inputs:agent?recoveryInputs(agent):null,
    }:null};
  }
  private observeRecoveryActivity(sessionId:string|null,agent?:Agent,runId?:string):Pick<RecoveryDetail,'jobs'|'subtree'> {
    const children:Agent[]=[];
    const tree=this.nativeSubagents();
    let known=!!agent;
    if(agent) {
      try {
        const registry=this.ctx.agents as NativeAgentRegistry;
        const agents=registry.list().filter(child=>child!==agent);
        // The native registry in rc.1 tracks direct creators; rc.5 exposes tree roots.
        if(registry.isOwnedBy) {
          const parents=[agent];
          for(const parent of parents)for(const child of agents) {
            if(!children.includes(child)&&registry.isOwnedBy(child.id,parent)){children.push(child);parents.push(child);}
          }
        } else if(tree?.rootOf) {
          for(const child of agents) {
            try {if(tree.rootOf(child)===agent)children.push(child);}
            catch {known=false;} // An unowned live entry does not invalidate known descendants.
          }
        } else known=agents.length===0;
      }catch{known=false;}
    }
    let jobs:RecoveryDetail['jobs']=null;
    if(sessionId) {
      try {
        jobs=[sessionId,...children.map(child=>child.id)].flatMap(owner=>this.ctx.jobs.list(SessionId(owner))
          .filter(job=>job.owner===owner).map(job=>({id:job.id,sessionId:owner,status:job.status})));
      }catch{/* The native Job registry could not answer this observation. */}
    }
    const check=runId?this.treeChecks.get(runId):undefined;
    const childActive=children.length>0||!!check?.active.size||!!check?.pendingWaits;
    const state=childActive?'active':!known||tree||check?.service?'unknown':'clear';
    return {jobs,subtree:{state,children:children.map(child=>({sessionId:child.id,status:child.status}))}};
  }
  private assertRecoveryQuiet(agent:Agent,runId?:string):void {
    if(this.ctx.agents.get(agent.id)!==agent)throw new AppError('session-unavailable','执行会话已离开原生运行时，请重新核对。');
    if(runId&&(this.running.has(runId)||this.finishing.has(runId)))throw new AppError('run-active','旧执行仍在清理或结算，请稍后核对。');
    if(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length) {
      throw new AppError('session-busy','任务会话有活动或待处理输入，请先在原生会话核对。');
    }
    const {jobs,subtree}=this.observeRecoveryActivity(agent.id,agent,runId);
    if(!jobs)throw new AppError('job-unknown','原生 Job 状态无法确认，保留执行占用。');
    if(jobs.some(job=>job.status==='running'||job.status==='stopping'))throw new AppError('job-active','后台工作尚未停止，不能核对或继续。');
    if(subtree.state==='active')throw new AppError('child-active','会话仍有子 Agent 或子树清理，请先通过原生会话核对。');
    this.assertObservedTreeQuiet(runId?this.treeChecks.get(runId):undefined);
    if(subtree.state==='unknown'&&!this.nativeSubagents())throw new AppError('child-unknown','原生子树归属无法确认，保留执行占用。');
  }
  private async confirmRecoveryTree(agent:Agent):Promise<void> {
    if(!this.nativeSubagents())return;
    let pending=this.recoveryTreeChecks.get(agent);
    if(!pending) {
      pending=this.waitForTreeWork(agent,new AbortController().signal).finally(()=>this.recoveryTreeChecks.delete(agent));
      this.recoveryTreeChecks.set(agent,pending);
    }
    // Native wait also sees materializing and external children that have no live Agent.
    // An interactive check only accepts a tree that is already quiet. Leave native work alone.
    const outcome=await Promise.race([pending.then(joined=>joined?'worked':'quiet',()=> 'unknown'),
      new Promise<'unknown'>(resolve=>setImmediate(()=>resolve('unknown')))]);
    if(outcome!=='quiet')throw new AppError('child-unknown','原生子树仍在活动或无法确认，请核对后再试。');
  }
  private async readRecoveryTools(run:Run,cwd:string,proof:RunTurn,agent?:Agent,closing=false) {
    const events=await this.readRunEvents(run,agent?.session);
    const later=verifyRunTurn(run,this.store.getRunInput(run.id),proof,events,true);
    if(later.length||events.some(event=>event.seq>proof.endSeq!&&
      ['turn/start','turn/end','user/message','tool/call','tool/result','approval/asked','working-directory/change'].includes(event.type))) {
      throw new AppError('recovery-new-input','旧轮结束后已有新的会话活动。请按最新会话状态决定下一步。');
    }
    const segment=events.slice(proof.startSeq!+1,proof.endSeq!);
    if(segment.some(event=>{
      if(event.type==='working-directory/change'||!closing&&event.type==='approval/asked')return true;
      if(event.type!=='user/message'||event.seq===proof.inputSeq)return false;
      const source=event.data.source as {kind:string;form?:unknown};
      return !((source?.kind==='runtime-context'||source?.kind==='time-context')&&source.form==='snapshot'||
        source?.kind==='skill-catalog'&&source.form==='catalog');
    })) {
      throw new AppError('recovery-scope-changed','原轮包含额外输入、目录变化或审批，无法证明同一操作授权。');
    }
    if(closing) {
      const settledJobs=new Set(segment.flatMap(event=>event.type==='job/settled'&&event.data.status==='completed'&&
        event.data.producerReported===true?[event.data.jobId]:[]));
      const job=segment.find(event=>event.type==='job/registered'&&!settledJobs.has(event.data.jobId));
      if(job)throw new AppError('effect-uncertain','原生后台作业已停止或缺少成功回执，其外部效果尚未确认。请检查 Worker 会话中的作业结果。');
    }
    return inspectPriorTools(events,cwd,proof.turn!,proof.startSeq!,proof.endSeq!,call=>{
      const receipt=this.store.readQueryReceipt(run.id,call.callId);
      if(!receipt||receipt.cwd!==cwd||receipt.turn!==proof.turn||receipt.inputSeq!==proof.inputSeq||call.callSeq<=proof.inputSeq!)return null;
      try {
        const {kind}=parseGitStatusQuery(JSON.parse(call.args));
        if(receipt.kind===kind&&call.resultText===JSON.stringify(receipt.result))return receipt;
      }catch{/* A host receipt must match the durable call and exact result. */}
      return null;
    });
  }
  private boundPreflightReceipts(runId:string,clusters:PriorTools['clusters']) {
    return clusters.map(call=>{
      const receipt=this.store.preflightReceipt(runId,call.callId);
      try {
        if(receipt&&JSON.stringify(parseClusterProbe(JSON.parse(call.args)))===JSON.stringify(receipt.probe))return {...call,receipt};
      }catch{/* Invalid arguments cannot establish a matching authorized probe. */}
      return {...call,receipt:null};
    });
  }
  /** The Manager may inspect this notice's exact prior Run without replaying Worker work. */
  private async readAutoRecovery(taskId:string,rowVersion:number,runId:string,managerId:string,authorize:()=>void) {
    const identity={taskId,runId,rowVersion};
    const refused=(message:string,extra:Record<string,unknown>={})=>({status:'needs-human' as const,...identity,message,...extra});
    authorize();
    const previous=this.store.recoveryCheck(runId);
    if(previous) {
      const detail=this.store.taskDetail(taskId),{task,run,binding}=detail;
      if(previous.managerId!==managerId||task.controlMode!=='auto'||task.lifecycle!=='open'||
        run?.id!==runId||binding?.id!==run.bindingId||binding?.sessionId!==run.sessionId||binding?.generation!==run.generation||
        run.taskRevision!==task.taskRevision||task.rowVersion!==(previous.resolution&&!previous.effectUncertain&&
          previous.resolution.status!=='unavailable'?previous.rowVersion+1:previous.rowVersion)||
        ![task.rowVersion,previous.rowVersion].includes(rowVersion)) {
        return refused('核对记录所属的任务、执行或授权版本已变更。请查看当前状态。');
      }
      if(previous.resolution)return {status:'already-checked' as const,...identity,result:previous.resolution};
      return refused('已有一次只读核对登记，但缺少结果。请检查这次核对记录并决定是否安排新检查。');
    }
    const validate=()=>{
      authorize();
      if(this.disposed)throw new AppError('unavailable','插件正在退出。');
      return this.store.autoRecoveryTarget(taskId,rowVersion,runId,managerId);
    };
    let target:ReturnType<Store['autoRecoveryTarget']>;
    try{target=validate();}
    catch(error){if(error instanceof AppError)return refused(error.message);throw error;}
    const {run,binding,proof}=target;
    const report=this.store.finalReport(runId);
    const settledFailure=run.state==='failed'&&!!report&&proof.reportId===report.id&&['failed','blocked'].includes(report.kind);
    if(!settledFailure&&run.state!=='interrupted') {
      return refused('没有已结束且可归属的失败或中断执行。请核对上轮的具体外部效果，再决定如何继续。');
    }
    const readEvidence=(agent?:Agent)=>this.readRecoveryTools(run,binding.cwd,proof,agent);
    // Inspect the persisted evidence before resolving the Worker. Unsupported and ambiguous
    // cases remain passive even if the Worker is currently cold.
    let checks:PriorTools;
    try {checks=await readEvidence();validate();}
    catch(error){if(error instanceof AppError)return refused(error.message);throw error;}
    const sessions=this.boundPreflightReceipts(runId,checks.clusters);
    const receipts=[...new Map(sessions.filter(call=>call.receipt).map(call=>
      [JSON.stringify([call.receipt!.probe,call.receipt!.auth]),call])).values()];
    const observed=receipts.flatMap(call=>call.receipt&&call.receipt.auth&&call.receipt.result.status!=='unavailable'?
      [{probe:call.receipt.probe,result:call.receipt.result,callSeq:call.callSeq,resultSeq:call.resultSeq}]:[]);
    const uncertainty=unknownPriorEffects(checks,sessions.some(call=>!call.receipt),
      this.store.recoveryWorkPlan(runId)?.context.effectUncertain===true);
    const effectUncertain=!!uncertainty;
    const candidates:{evidence:ProbeEvidence;known?:ProbeResult}[]=effectUncertain?[]:[...checks.files];
    if(fullAccessEnabled(this.options))for(const {receipt,callId,callSeq,resultSeq} of receipts)if(receipt?.auth) {
      const stateInquiry=receipt.probe.kind==='deployment-state'||receipt.probe.kind==='volume-state';
      if(effectUncertain&&stateInquiry||!effectUncertain&&(
        ['unavailable','missing','denied'].includes(receipt.result.status)||
        receipt.result.status==='present'&&receipt.result.observed?.ready===false)) {
        candidates.push({evidence:{probe:receipt.probe,auth:receipt.auth,callId,callSeq,resultSeq},
          ...(receipt.result.status==='denied'?{known:receipt.result}:{})});
      }
    }
    const blockers={observed,priorTools:checks.potentialEffects,priorReadQueries:checks.queries,priorReport:this.store.runFinalReport(runId),
      ...(candidates.length>1?{competingChecks:candidates.map(({evidence,known})=>
        ({probe:evidence.probe,...(known?{result:known}:{})}))}:{})};
    if(candidates.length!==1) {
      if(!effectUncertain&&!candidates.length) {
        return {status:'blocked' as const,...identity,...blockers,settled:true,
          message:'上一轮执行已经结束。报告所列的前置仍需处理，账本没有可以自动继续的同范围核对。'};
      }
      return refused(effectUncertain?
        `${uncertainty} 请对照已核实的目标状态或原操作回执，决定是否仍需行动。`:
        '原轮没有单一可按同一授权核对的只读失败证据。请根据报告核对具体的前置条件或所需动作。',blockers);
    }
    const {evidence,known}=candidates[0]!;
    try {
      const resolved=await this.ctx.sessionController.resolveAgent(SessionId(binding.sessionId));
      validate();
      if('error' in resolved||resolved.agent.id!==binding.sessionId)throw new AppError('session-unavailable','无法确认原生 Worker 的活动状态。');
      const agent=resolved.agent;
      this.assertRecoveryQuiet(agent,runId);
      this.assertDirectory(agent,binding.cwd);
      const tree=originalService(this.nativeSubagents());
      await this.confirmRecoveryTree(agent);
      const fresh=await readEvidence(agent);
      validate();
      this.assertRecoveryQuiet(agent,runId);
      this.assertDirectory(agent,binding.cwd);
      if(tree!==originalService(this.nativeSubagents())||JSON.stringify(checks)!==JSON.stringify(fresh)) {
        throw new AppError('recovery-stale','核对时发现原工具证据或后台服务发生变化。');
      }
      return {status:'eligible' as const,...identity,evidence,known,agent,tree,cwd:binding.cwd,effectUncertain,...blockers};
    }catch(error){if(error instanceof AppError)return refused(error.message);throw error;}
  }
  async inspectAutoRecovery(taskId:string,rowVersion:number,runId:string,managerId:string,authorize:()=>void) {
    const checked=await this.readAutoRecovery(taskId,rowVersion,runId,managerId,authorize);
    if(checked.status!=='eligible')return checked;
    const {evidence}=checked;
    return {status:'eligible',taskId,runId,rowVersion,probe:evidence.probe,...(checked.known?{known:checked.known}:{}),
      effectUncertain:checked.effectUncertain,observed:checked.observed,priorTools:checked.priorTools,
      message:checked.effectUncertain?
        '上轮已经结束，但原操作是否产生外部效果仍待确认。现有授权仅允许核对同一资源的状态。':
        '已核实上轮结束，当前没有新的输入或未结算后台活动。可以核对同一只读目标。'};

  }
  /** A pending owner instruction waits quietly while native activity is observable. */
  canWakeRecoveryContinuation(taskId:string):boolean {
    const run=this.store.latestRun(taskId),binding=this.store.activeBinding(taskId);
    if(!run||run.finishedAt===null||this.running.has(run.id)||this.finishing.has(run.id))return false;
    if(this.store.lateJobTarget(run.id))return false;
    if(this.store.verifiedBlocker(run)&&this.store.dispatchBlocker(taskId))return false;
    if(!binding?.sessionId)return true;
    const agent=this.ctx.agents.get(SessionId(binding.sessionId));
    if(agent&&(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length))return false;
    const activity=this.observeRecoveryActivity(binding.sessionId,agent,run.id);
    return activity.subtree.state!=='active'&&!activity.jobs?.some(job=>job.status==='running'||job.status==='stopping');
  }
  async continueRecovery(taskId:string,rowVersion:number,managerId:string,authorize:()=>void,manager?:Agent) {
    type Outcome={status:'started'|'already-started'|'waiting'|'blocked';message:string;run?:Run};
    return this.reloadAdmission.run(`Worker task ${taskId} continuation`,async():Promise<Outcome>=>{
      const validate=()=>{
        authorize();
        if(this.disposed)throw new AppError('unavailable','插件正在退出。');
        return this.store.continuationTarget(taskId,rowVersion,managerId);
      };
      authorize();
      const saved=this.store.recoveryInstruction(taskId);
      if(!saved)return {status:'blocked',message:'上一轮状态已记录，当前没有新的已授权后续指示。'};
      if(saved.runId)return {status:'already-started',run:this.store.getRun(saved.runId),message:'这条用户指示已有执行记录。'};
      if(this.store.lateJobTarget(saved.priorRunId))return {
        status:'waiting',message:'后台 Job 的原生结果仍在核对或等待接续，Bot 会继续跟进。',
      };
      try {
        const {task,run,binding,instruction}=validate();
        const resolved=await this.ctx.sessionController.resolveAgent(SessionId(binding.sessionId));
        validate();
        if('error' in resolved||resolved.agent.id!==binding.sessionId)throw new AppError('session-unavailable','无法确认原生 Worker 的活动状态。');
        const agent=resolved.agent,tree=originalService(this.nativeSubagents());
        this.assertRecoveryQuiet(agent,run.id);
        this.assertDirectory(agent,binding.cwd);
        await this.confirmRecoveryTree(agent);
        validate();
        const proof=this.store.runTurn(run.id);
        const checks=proof?.quiet&&proof.endSeq!==null?await this.readRecoveryTools(run,binding.cwd,proof,agent):null;
        validate();
        this.assertRecoveryQuiet(agent,run.id);
        this.assertDirectory(agent,binding.cwd);
        if(tree!==originalService(this.nativeSubagents()))throw new AppError('child-unknown','原生子树服务已变更，请重新核对。');
        const receipts=(checks?this.boundPreflightReceipts(run.id,checks.clusters):[]).map(call=>call.receipt);
        const priorCheck=this.store.recoveryCheck(run.id);
        const priorWork=this.store.recoveryWorkPlan(run.id);
        const uncertainty=unknownPriorEffects(checks,receipts.some(item=>!item),
          priorCheck?.effectUncertain===true||priorWork?.context.effectUncertain===true);
        const effectUncertain=!!uncertainty;
        if(!this.store.verifiedBlocker(run)) {
          if(!checks||run.state!=='interrupted')throw new AppError('recovery-unproven','尚未找到可归属的旧轮结束或后台收敛证据，保留旧轮占用。');
          if(effectUncertain)throw new AppError('effect-uncertain',`原轮还有未确认的外部效果，保留旧轮占用。${uncertainty} 请核对操作回执或按现有授权查询目标状态。`);
          this.store.verifyInterruptedEnd(taskId,rowVersion,managerId);
          rowVersion=this.store.getTask(taskId).rowVersion;
          validate();
        }
        const byProbe=<T extends {probe:ReadProbe|ReturnType<typeof parseClusterProbe>}>(items:T[]):T[]=>
          [...new Map(items.map(item=>[JSON.stringify(item.probe),item])).values()];
        const authorizedProbes=fullAccessEnabled(this.options)?byProbe([
          ...(priorWork?.authorizedProbes??[]),...receipts.flatMap(item=>item?.auth?[{probe:item.probe,auth:item.auth}]:[]),
        ]):[];
        const observations=byProbe([...(priorWork?.context.observations??[]),...receipts.flatMap(item=>
          item?.auth&&item.result.status!=='unavailable'?[{probe:item.probe,result:item.result}]:[]),
          ...(priorCheck?.resolution&&priorCheck.resolution.status!=='unavailable'&&priorCheck.evidence.probe.kind!=='file'?
            [{probe:priorCheck.evidence.probe,result:priorCheck.resolution}]:[])]);
        const mode=instruction.mode;
        if(!mode||mode==='authorized-work'&&effectUncertain) {
          const detail=observations.at(-1)?.result.message;
          return {status:'blocked',message:[detail,effectUncertain?
            `${uncertainty} 现有记录只支持已有授权的具体只读核对。`:
            '旧轮已结束。请按已有证据核对缺失的前置或具体有授权的下一步。'].filter(Boolean).join(' ')};
        }
        if(this.store.dispatchBlocker(taskId)) {
          this.store.recordCapacityWait(`continuation:${instruction.id}:${rowVersion}`,taskId,rowVersion);
          return {status:'waiting',message:'已保存用户指示，等待此 Bot 的 Worker 执行名额。'};
        }
        const work:RecoveryWorkContext={priorRunId:run.id,mode,priorReport:this.store.runFinalReport(run.id),
          priorCheck:priorCheck?.resolution??priorWork?.context.priorCheck,effectUncertain,
          priorDirections:instruction.directions?.filter(direction=>direction.id!==instruction.id)
            .map(({id,source})=>({id,text:source.text})),
          directionIds:instruction.directions?.map(direction=>direction.id),
          priorReadQueries:checks?.queries,probes:authorizedProbes.map(({probe})=>probe),observations};
        const current=selectedModel(this.ctx,agent);
        const inherited=!this.options.workerModel&&!current&&manager&&this.store.botForSession(manager.id)?.id===task.botId
          ?selectedModel(this.ctx,manager):undefined;
        const plan=workerModelPlan(current?modelRoute(current):null,this.options.workerModel,
          inherited&&manager?{sessionId:manager.id,model:modelRoute(inherited)}:undefined);
        if(!plan)throw new AppError('model-required','Worker 缺少可核实的模型选择，后续指示已保留。');
        validate();
        const next=this.store.reserveRecoveryContinuation(taskId,rowVersion,managerId,
          {context:work,authorizedProbes},plan);
        try {
          configureRole(this.ctx,agent,'worker',this.options);
          if(inherited)agent.model.select(inherited);
          const launched=this.deliverRun(next,agent,binding);
          if(launched.state!=='interrupted') {
            const entered=this.store.getRunInput(next.id).state==='entered';
            return {status:'started',run:launched,message:entered?'已进入原任务的 Worker。':
              '已排入原任务的下一轮，等待 Worker 读取指示。'};
          }
        }catch {
          this.store.runRecovery(next.id,'后续执行的投递待核对，已保存原指示并保留占用。');
        }
        return {status:'blocked',run:this.store.getRun(next.id),message:'后续执行的投递待核对，已保留原指示。'};
      }catch(error) {
        if(!(error instanceof AppError)||['manager-scope','recovery-scope'].includes(error.code))throw error;
        const waiting=['run-active','session-busy','job-active','child-active','capacity'].includes(error.code);
        return {status:waiting?'waiting':'blocked',message:error.code==='run-active'?
          '已记下指示，将在原任务的下一轮处理。':error.message};
      }
    });
  }
  async performAutoRecovery(taskId:string,rowVersion:number,runId:string,managerId:string,signal:AbortSignal,authorize:()=>void) {
    return this.reloadAdmission.run(`Manager read-only recovery ${taskId}`,async()=>{
      const checked=await this.readAutoRecovery(taskId,rowVersion,runId,managerId,authorize);
      if(checked.status!=='eligible')return checked;
      const {evidence,known,agent,tree,cwd,effectUncertain}=checked;
      const validate=()=>{
        authorize();
        this.store.autoRecoveryTarget(taskId,rowVersion,runId,managerId);
        this.assertRecoveryQuiet(agent,runId);
        this.assertDirectory(agent,cwd);
        if(tree!==originalService(this.nativeSubagents()))throw new AppError('recovery-stale','后台服务已变更。');
      };
      validate();
      if(!this.store.claimRecoveryCheck(taskId,runId,managerId,rowVersion,evidence,effectUncertain)) {
        return {status:'already-checked',taskId,runId,result:this.store.recoveryCheck(runId)?.resolution??null};
      }
      let result:ProbeResult,excerpt:string|undefined;
      let performed=false;
      if(known)result=known;
      else if(evidence.probe.kind==='file') {
        const checked=await this.retryNativeRead(evidence.probe,cwd,agent,signal,validate);
        ({result,excerpt}=checked);performed=true;
      } else {
        try {
          if(!evidence.auth)throw new AppError('kube-identity-unproven','没有先前共享身份的回执。');
          const prepared=await prepareClusterProbe(evidence.probe,
            AbortSignal.any([signal,AbortSignal.timeout(17000)]),evidence.auth,validate);
          validate();
          result=await prepared.check();performed=true;
        }catch(error){
          result={status:'unavailable',message:error instanceof AppError?error.message:'Kubernetes 未返回可验证的预检结果。'};
        }
      }
      validate();
      this.store.finishRecoveryCheck(taskId,runId,managerId,result,performed);
      return {...result,taskId,runId,effectUncertain,task:this.store.getTask(taskId),...(excerpt!==undefined?{excerpt}:{})};
    });
  }
  private async retryNativeRead(probe:ReadProbe,cwd:string,agent:Agent,signal:AbortSignal,validate:()=>void):Promise<{result:ProbeResult;excerpt?:string}> {
    const callId=ToolCallId(`super-bot-recovery-${randomUUID()}`);
    const controller=new AbortController();
    const releaseApproval=this.ctx.on('session/event',(session,event)=>{
      if(session===agent.session&&event.type==='approval/asked')controller.abort();
    });
    const releaseGuard=agent.ctx.on('tools/execute',(exec,next)=>{
      if(exec.callId===callId) {
        validate();
        if(containedPath(cwd,probe.path)!==probe.path)throw new AppError('path-changed','原读取目标路径已变更。');
      }
      return next();
    });
    try {
      const response=await this.ctx.tools.execute({
        agent,signal:AbortSignal.any([signal,controller.signal,AbortSignal.timeout(5000)]),
        calls:[{type:'tool-call',id:callId,name:'read',arguments:JSON.stringify({
          file_path:probe.path,...(probe.offset!==undefined?{offset:probe.offset}:{}),...(probe.limit!==undefined?{limit:probe.limit}:{}),
        })}],
      });
      const value=response.results.find(item=>item.callId===callId)?.result;
      if(value?.isError===false) {
        const verified=value.value as {path?:unknown;offset?:unknown;lines?:unknown}|null;
        if(!verified||verified.path!==probe.path||verified.offset!==(probe.offset??1)||!Array.isArray(verified.lines)) {
          return {result:{status:'unavailable',message:'原生读取结果的路径或读取范围不匹配。'}};
        }
        const excerpt=value.content.filter(item=>item.type==='text').map(item=>item.text).join('\n').slice(0,8000);
        return {result:{status:'readable',message:'原生 Worker 身份已读取同一路径和范围。'},excerpt};
      }
      const code=value?.error.info?.code;
      if(code==='FS_NOT_FOUND')return {result:{status:'missing',message:'原路径仍无该文件，需要提供或生成该文件。'}};
      if(code==='FS_PERMISSION_DENIED') {
        return {result:{status:'denied',message:'原生 Worker 缺少此文件的读取权限。'}};
      }
      if(controller.signal.aborted) {
        return {result:{status:'unavailable',message:'原生审批策略要求审批此文件读取，自动核对已停止。'}};
      }
      return {result:{status:'unavailable',message:'原生 Worker 未返回可验证的读取结果。'}};
    }finally{releaseGuard();releaseApproval();}
  }
  async recover(requestId:string,taskId:string,rowVersion:number,acknowledged:unknown,continuation?:RecoveryContinuation,
    authorize=()=>{},source?:import('./model.ts').ChatSource) {
    if(acknowledged!==true)throw new AppError('confirmation-required','请先检查原生会话、文件和外部效果，再确认核对完成。');
    const action=continuation?'run.continue-recovery':'run.resolve-recovery';
    const payload={taskId,expectedRowVersion:rowVersion,...continuation,...(source?{source}:{})};
    const receipt=()=>{
      const saved=this.store.commandReceipt<Task|Run>(requestId,action,payload);
      if(!saved||'inputId' in saved)return saved;
      const current=this.store.getTask(taskId);
      return current.lifecycle==='cancelled'?current:saved;
    };
    authorize();
    const prior=receipt();
    if(prior)return 'inputId' in prior?this.store.getRun(prior.id):prior;
    const target=this.store.recoveryTarget(taskId,rowVersion,continuation);
    return this.reloadAdmission.run(`Worker task ${taskId} recovery`,async()=>{
      const binding=target.binding;
      if(!binding?.sessionId) {
        this.store.resolveRunRecovery(requestId,taskId,rowVersion,source);
        await this.advanceClose(taskId,true);
        return this.store.getTask(taskId);
      }
      const sessionId=SessionId(binding.sessionId);
      const validate=()=>{
        if(this.disposed)throw new AppError('unavailable','插件正在退出。');
        authorize();
        const duplicate=receipt();
        if(duplicate)return 'inputId' in duplicate?this.store.getRun(duplicate.id):duplicate;
        const current=this.store.recoveryTarget(taskId,rowVersion,continuation);
        if(current.binding?.id!==binding.id||current.binding.generation!==binding.generation||current.run?.id!==target.run?.id||
          current.attentions.join()!==target.attentions.join())throw new AppError('recovery-stale','恢复事项或会话关联已经改变，请刷新后核对。');
      };
      const resolved=await this.ctx.sessionController.resolveAgent(sessionId);
      const duplicate=validate();if(duplicate)return duplicate;
      if('error' in resolved||resolved.agent.id!==sessionId)throw new AppError('session-unavailable','无法读取原生会话，暂未释放执行占用。');
      const agent=resolved.agent;
      this.assertRecoveryQuiet(agent,target.run?.id);
      const tree=originalService(this.nativeSubagents());
      await this.confirmRecoveryTree(agent);
      const retry=validate();if(retry)return retry;
      if(tree!==originalService(this.nativeSubagents()))throw new AppError('child-unknown','原生子树服务已改变，请重新核对。');
      this.assertRecoveryQuiet(agent,target.run?.id);
      if(!continuation) {
        this.store.resolveRunRecovery(requestId,taskId,rowVersion,source);
        await this.advanceClose(taskId,true);
        return this.store.getTask(taskId);
      }
      this.assertDirectory(agent,binding.cwd);
      const modelRequired=()=>new AppError('model-required','请先在原生会话明确选择模型，再核对并继续。');
      const selected=selectedModel(this.ctx,agent);
      const plan=workerModelPlan(selected?modelRoute(selected):null,this.options.workerModel);
      if(!plan)throw modelRequired();
      const run=this.store.continueRunRecovery(requestId,taskId,rowVersion,continuation,plan,source);
      try {
        configureRole(this.ctx,agent,'worker',this.options);
        if(!selectedModel(this.ctx,agent))throw modelRequired();
        this.assertRecoveryQuiet(agent,target.run?.id);
        return this.deliverRun(run,agent,binding,{note:target.run?.note??null});
      }catch{
        // The new Run is already reserved. Preserve its receipt and quarantine any unknown delivery.
        this.store.runRecovery(run.id,'新执行未能确认开始。请检查原生会话；没有自动重投。');
        return this.store.getRun(run.id);
      }
    });
  }
  async closeTask(requestId:string,taskId:string,rowVersion:number,authorize=()=>{}) {
    authorize();
    if(this.disposed)throw new AppError('unavailable','插件正在退出。');
    const run=this.store.latestRun(taskId);
    const previous=this.store.commandReceipt(requestId,'task.close',{taskId,expectedRowVersion:rowVersion});
    if(!previous) {
      const receipt=this.store.requestTaskClose(requestId,taskId,rowVersion,run&&this.finishing.has(run.id)?run.id:undefined);
      if(receipt.stopRunId)this.sendStop(receipt.stopRunId);
    }
    await this.advanceClose(taskId,false,true);
    return {task:this.store.getTask(taskId),run:this.store.latestRun(taskId),closeRequest:this.store.taskClose(taskId)};
  }
  private advanceClose(taskId:string,notify:boolean,resolve=false):Promise<void>|undefined {
    if(this.disposed||!this.store.taskClose(taskId))return;
    const inflight=this.closing.get(taskId);
    if(inflight)return inflight;
    const pending=this.verifyTaskClose(taskId,notify,resolve).finally(()=>this.closing.delete(taskId));
    this.closing.set(taskId,pending);
    return pending;
  }
  private async verifyTaskClose(taskId:string,notify:boolean,resolve:boolean):Promise<void> {
    const intent=this.store.taskClose(taskId),task=this.store.getTask(taskId),run=this.store.latestRun(taskId);
    if(!intent||run?.finishedAt===null||this.store.isBotDeleted(task.botId))return;
    const binding=this.store.activeBinding(taskId);
    try {
      this.store.assertTaskSettled(taskId);
      if((intent.runId!==null&&run?.id!==intent.runId)||intent.taskRevision!==task.taskRevision) {
        throw new AppError('version-conflict','原任务或执行发生变化，请核对最新状态。');
      }
      if(binding?.sessionId) {
        const sessionId=SessionId(binding.sessionId);
        const tree=originalService(this.nativeSubagents());
        let agent=this.ctx.agents.get?.(sessionId);
        if(!agent&&resolve) {
          const loaded=await this.ctx.sessionController.resolveAgent(sessionId);
          if('error' in loaded||loaded.agent.id!==sessionId)throw new AppError('session-unavailable','无法核对原 Worker 会话。请打开原会话后重新核对。');
          agent=loaded.agent;
        }
        const readback=run!==null&&run.id===intent.runId&&this.store.closeRunNeedsReadback(run,intent.activeRun);
        if(agent) {
          this.assertQuiet(agent);
          await this.confirmRecoveryTree(agent);
        } else if(!readback) {
          throw new AppError('session-unavailable','原 Worker 会话尚未加载。请打开原会话后重新核对。');
        }
        if(run&&readback) {
          const proof=this.store.runTurn(run.id);
          if(!proof?.quiet||proof.endSeq===null)throw new AppError('run-proof','缺少旧轮结束或后台收敛的持久回执。请核对原 Worker 会话。');
          const checks=await this.readRecoveryTools(run,binding.cwd,proof,agent,true);
          const unknown=checks.potentialEffects[0];
          if(unknown)throw new AppError('effect-uncertain',`原 Worker 的 ${unknown.tool} 调用可能留下外部效果。请核对该调用实际完成的操作和资源状态。`);
          if(checks.incomplete)throw new AppError('effect-uncertain','旧轮工具记录不完整，无法确认其中的操作效果。请核对原 Worker 会话。');
        }
        if(this.disposed)return;
        if(agent) {
          if(this.ctx.agents.get?.(sessionId)!==agent||tree!==originalService(this.nativeSubagents())) {
            throw new AppError('session-unavailable','核对期间原会话或后台服务发生变化。请重新核对。');
          }
          this.assertQuiet(agent);
        }
        const current=this.store.activeBinding(taskId);
        if(current?.id!==binding.id||current.generation!==binding.generation||current.sessionId!==sessionId||current.state!==binding.state) {
          throw new AppError('version-conflict','核对期间原会话关联发生变化。请重新核对。');
        }
      }
      if(!this.disposed)this.store.confirmTaskClose(taskId,intent.id,task.rowVersion,notify);
    }catch(error) {
      if(this.disposed)return;
      const code=error instanceof AppError?error.code:'close-unverified';
      const message=code==='run-active'&&run?.note?run.note:error instanceof AppError?error.message:'关闭核对暂未完成。请重新核对 Worker 会话。';
      if(code==='needs-attention'&&intent.blocker&&message.endsWith(intent.blocker.message))return;
      this.store.recordCloseBlocker(taskId,intent.id,{code,message},notify);
    }
  }
  async endTaskLink(action:'task.cancel'|'session.detach',requestId:string,taskId:string,rowVersion:number,authorize=()=>{}) {
    const receipt=()=>this.store.commandReceipt<Task>(requestId,action,{taskId,expectedRowVersion:rowVersion});
    authorize();
    const prior=receipt();if(prior)return prior;
    const binding=this.store.activeBinding(taskId);
    const validate=()=>{
      if(this.disposed)throw new AppError('unavailable','插件正在退出。');
      const task=this.store.getTask(taskId),current=this.store.activeBinding(taskId);
      if(task.rowVersion!==rowVersion||current?.id!==binding?.id||current?.sessionId!==binding?.sessionId||
        current?.generation!==binding?.generation||current?.state!==binding?.state) {
        throw new AppError('version-conflict','任务或会话关联已经更新，请刷新后再操作。');
      }
      if(task.status==='recovery')throw new AppError('needs-attention','请先完成待核对事项。');
    };
    validate();
    if(binding?.sessionId) {
      const resolved=await this.ctx.sessionController.resolveAgent(SessionId(binding.sessionId));
      authorize();
      const duplicate=receipt();if(duplicate)return duplicate;
      validate();
      if('error' in resolved||resolved.agent.id!==binding.sessionId)throw new AppError('session-unavailable','无法核对原生会话，请恢复会话后再操作。');
      const agent=resolved.agent,run=this.store.latestRun(taskId);
      this.assertQuiet(agent);
      if(action==='task.cancel'&&run&&run.bindingId===binding.id&&this.store.verifiedBlocker(run)) {
        const tree=originalService(this.nativeSubagents());
        this.assertRecoveryQuiet(agent,run.id);
        await this.confirmRecoveryTree(agent);
        const proof=this.store.runTurn(run.id);
        const checks=proof?.quiet&&proof.endSeq!==null?await this.readRecoveryTools(run,binding.cwd,proof,agent):null;
        authorize();validate();
        this.assertRecoveryQuiet(agent,run.id);
        if(tree!==originalService(this.nativeSubagents()))throw new AppError('child-unknown','原生子树服务已变更，暂未取消任务。');
        if(checks&&(checks.incomplete||checks.potentialEffects.some(tool=>tool.result!=='reported-success'))) {
          throw new AppError('effect-uncertain','上轮有未确认的工具回执或外部效果，暂未取消任务。');
        }
      }
    }
    if(action==='session.detach')return this.store.detachSession(requestId,taskId,rowVersion);
    const cancelled=this.store.cancelTask(requestId,taskId,rowVersion);await this.autoCleanup(taskId);return cancelled;
  }
  async dispose():Promise<void> {
    this.disposed=true;this.autoTurns.clear();
    for(const timer of this.lateJobTimers.values())clearTimeout(timer);
    this.lateJobTimers.clear();
    for(const controller of this.deletedRuns.values())controller.abort();
    for(const [id,{agent}]of this.running){this.store.runRecovery(id,'插件退出时执行尚未核对，重新启用后请核对原生会话。');const input=this.store.getRunInput(id);if(input.messageId)agent.inbox.remove(input.messageId as UserMessage['id']);agent.cancel({kind:'user'},{keepInbox:true});}
    await Promise.allSettled([...this.running.values()].map(r=>r.done));
    await this.whenReconciled();
    await Promise.allSettled(this.lateJobChecks.values());
  }
  async prepareSession(requestId:string,taskId:string,rowVersion:number,workdir?:WorkdirRequest,authorize=()=>{}):Promise<Binding> {
    authorize();
    const receipt=this.store.bindingReceipt(requestId,taskId,rowVersion);
    if(receipt?.state==='ready'||receipt?.state==='released')return receipt;
    return this.reloadAdmission.run(`Worker task ${taskId} session preparation`,()=>this.prepareWorker(requestId,taskId,rowVersion,workdir,authorize));
  }
  private async prepareWorker(requestId:string,taskId:string,rowVersion:number,workdir:WorkdirRequest|undefined,authorize:()=>void):Promise<Binding> {
    // Validate the ID through the ledger before using it as a directory segment.
    const task=this.store.getTask(taskId);
    const assertLive=()=>{
      authorize();
      if(this.store.isBotDeleted(task.botId))throw new AppError('not-found','Bot 已删除。');
    };
    assertLive();
    const bound=this.store.activeBinding(taskId);
    let cwd:string,info=bound?.workdir??undefined;
    if(bound)cwd=bound.cwd;
    else {
      // Provisioning has external effects (git, hook): one request provisions at most once.
      const key=`workdir-provision:${requestId}`,saved=this.store.get(key);
      if(saved)({cwd,info}=JSON.parse(saved) as {cwd:string;info:typeof info});
      else {
        try{({cwd,info}=await provisionWorkdir({request:workdir??task.workdirRequest??undefined,taskId:task.id,generation:this.store.nextBindingGeneration(taskId),policy:this.policy}));}
        catch(error){if(error instanceof AppError)this.store.note('workdir.failed',taskId,{code:error.code,message:error.message.slice(0,2000)});throw error;}
        this.store.set(key,JSON.stringify({cwd,info}));
      }
    }
    const path=await realpath(cwd);
    assertLive();
    const b=this.store.beginBinding(requestId,taskId,rowVersion,path,info);
    const current=this.store.getBinding(b.id);if(current.state==='ready')return current;
    const active=this.creating.get(b.id);if(active)return active;
    if(!this.store.claimBindingCreation(b.id))return this.reconcileBinding(b.id,authorize);
    const promise=(async()=>{
      try {
        const workspace=await this.ctx.workspaceRegistry.create(b.cwd,basename(b.cwd));
        assertLive();
        const result=await this.ctx.sessionController.create({workspaceId:workspace.id,sessionId:SessionId(b.requestedSessionId)});
        if(result.sessionId!==b.requestedSessionId){this.store.set(`native-create-mismatch:${b.id}`,result.sessionId);throw new AppError('session-mismatch','宿主返回了不同会话，尚未命名或关联。');}
        return await this.reconcileBinding(b.id,authorize);
      }catch(error){this.store.bindingRecovery(b.id);throw error instanceof AppError?error:new AppError('session-recovery','会话创建结果暂未确认，请在任务详情核对。');}
      finally{this.creating.delete(b.id);}
    })();this.creating.set(b.id,promise);return promise;
  }
  async reconcileBinding(id:string,authorize=()=>{}):Promise<Binding> {
    authorize();
    const b=this.store.getBinding(id);
    if(b.state==='ready'||b.state==='released')return b;
    if(this.store.get(`native-create-mismatch:${id}`))throw new AppError('session-mismatch','宿主已返回不同会话，保留待人工核对，不能自动关联原请求 ID。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(b.requestedSessionId));
    authorize();
    if('error' in resolved){this.store.bindingRecovery(id);throw new AppError('session-recovery','尚未找到已申请的会话；保持待核对，没有重复创建。');}
    const header=resolved.agent.session.header;
    const cwd=header.cwd&&await realpath(header.cwd);
    authorize();
    if(resolved.agent.session.id!==b.requestedSessionId||header.origin==='subagent'||header.isSeeded||cwd!==b.cwd){this.store.bindingRecovery(id);throw new AppError('session-mismatch','会话目录或归属不一致，尚未关联。');}
    if(this.store.getBinding(id).state==='released')return this.store.getBinding(id);
    const workspace=await this.ctx.workspaceRegistry.create(b.cwd,basename(b.cwd));
    authorize();
    if(this.store.getBinding(id).state==='released')return this.store.getBinding(id);
    await workspace.attachSession(SessionId(b.requestedSessionId));
    authorize();
    if(this.store.getBinding(id).state==='released')return this.store.getBinding(id);
    if(this.store.getTask(b.taskId).taskRevision!==b.taskRevision)throw new AppError('binding-stale','任务版本已改变，尚未命名旧会话。');
    await nameAutomaticSession(this.ctx,resolved.agent.session,workerTitle(this.store.getTask(b.taskId)));
    authorize();
    return this.store.confirmBinding(id,b.requestedSessionId);
  }
}
