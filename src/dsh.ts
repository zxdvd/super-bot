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
import {carrierKeyOf} from '@deepseek-ai/dsh-scope';
import {ChildWaitObservation,type NativeChildEdge} from './dsh-child-wait.ts';
import { createUserMessage,freezeMessage,type UserMessage } from '@deepseek-ai/dsh-llm';
import type {Session,SessionStore} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import {verifyRunTurn} from './run-proof.ts';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join,isAbsolute,basename } from 'node:path';
import {cleanupWorkdir,provisionWorkdir,workdirPolicy,workdirSummary,type WorkdirPolicy,type WorkdirRequest} from './workdir.ts';
import {nameAutomaticSession,workerTitle} from './sidebar.ts';
import { AppError,requiredText,optionalText,type Binding,type Run,type Task,type WorkReport,type ExistingSessionGrant,type ExistingSessionPreview } from './model.ts';
import type { ChildWaitDetail,ChildWaitMember,RecoveryContinuation,RecoveryDetail,RecoveryInput,RecoveryInputKind,
  RunChildWait,RunModels,WorkerModelPreview } from './model.ts';
import { actualModelRequests,modelRoute,nativeModel,observeNativeModel,readModelLog,workerModelPlan } from './dsh-model.ts';
import type { Store } from './store.ts';
import { captureEvidence,containedPath,verifyEvidence,evidencePaths,type CapturedEvidence } from './evidence.ts';
import {configureRole,fullAccessEnabled,type RuntimeOptions} from './runtime.ts';
import { materialPrompt } from './materials.ts';
import { ReloadAdmission } from './reload-admission.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {'super-bot':{kind:'super-bot';taskId:string;runId:string;inputId:string;taskRevision:number;generation:number}}
}

const CODE_DELIVERY = `For code work, after reading the applicable project instructions and before editing, record the opening Git HEAD and relevant staged, unstaged, and untracked changes. Keep the baseline scoped to the files you expect to touch. Preserve existing work, including changes in files you edit. If Git or the baseline is unavailable, state what you could verify.
In ready, use summary for what changed and checks for commands actually run, their outcomes, and what remains unverified. Make the opening HEAD, relevant existing changes, and this run's attributable diff visible in the summary or a concise attachment. Compare with the opening state, including for files you both found dirty and edited. Treat the full diff against HEAD as worktree context. If you cannot attribute a change, say so. Attach a scoped diff when useful and include actual changed source where available. For any relevant host, identify a matching native load receipt for this result and build, or say that loading there is unverified. Only reload when authorized.
For ordinary non-code work, keep the report brief and use the checks and files relevant to that task.`;

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
}

export class DshExecution {
  private creating=new Map<string,Promise<Binding>>();
  private running=new Map<string,{agent:Agent;release:()=>void;done:Promise<void>;finishTurn:(endSeq?:number,endKind?:string,endTime?:number)=>void}>();
  private autoTurns=new Set<string>();
  private treeChecks=new Map<string,TreeCheck>();
  private turnStarts=new WeakMap<Session,{turn:number;seq:number}>();
  private finishing=new Map<string,Promise<void>>();
  private pendingHuman=new Map<string,string[]>();
  private recoveryTreeChecks=new WeakMap<Agent,Promise<boolean>>();
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
    this.ctx.effect(()=>this.ctx.tools.register({name:'super_bot_report',description:'Report progress, a question, a blockage, failure, or ready results to the task ledger. Ready requires files and acceptance checks. A ready report requests human review, it does not complete the task.',
      parameters:{type:'object',properties:{kind:{type:'string',enum:['progress','waiting','ready','blocked','failed']},summary:{type:'string'},checks:{type:'string'},files:{type:'array',items:{type:'string'},maxItems:10}},required:['kind','summary'],additionalProperties:false},
      output:{schema:{type:'object',properties:{accepted:{type:'boolean'},resultId:{type:'string'},reason:{type:'string'},next:{type:'string'}},required:['accepted'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const run=this.store.heldRuns().find(r=>r.sessionId===exec.agent?.id&&r.finishedAt===null);
        if(!run||this.finishing.has(run.id))throw new AppError('report-scope','当前会话没有可报告的执行。');
        const data=args as Record<string,unknown>;const binding=this.store.getBinding(run.bindingId);
        const report:WorkReport={kind:data.kind as WorkReport['kind'],summary:requiredText(data.summary,'报告内容'),checks:optionalText(data.checks,'验收说明')};
        if(report.kind==='ready')report.requestedFiles=evidencePaths(data.files);
        exec.signal.throwIfAborted();
        const receipt=this.store.workerReportReceipt(run.id,exec.callId,report);
        const treeCheck=this.treeChecks.get(run.id);
        const assertCurrent=()=>{
          exec.signal.throwIfAborted();
          const current=this.store.getRun(run.id);
          if(this.disposed||this.finishing.has(run.id)||current.finishedAt!==null||current.state==='cancelling') {
            throw new AppError('report-stale','当前执行授权已结束或正在停止。');
          }
        };
        let captured: CapturedEvidence[] | undefined;
        if(report.kind==='ready') {
          const agent=exec.agent!,revision=treeCheck?.revision;
          let joined=await this.waitForTreeWork(agent,exec.signal,treeCheck,this.childWait(run,agent,'ready'));
          assertCurrent();
          this.assertChildrenQuiet(agent);
          this.assertObservedTreeQuiet(treeCheck);
          if(!joined&&treeCheck?.revision===revision&&!hasPendingChildResult(agent)&&!receipt) {
            captured=await captureEvidence(binding.cwd,report.requestedFiles);
            // File I/O yields. Require a fresh native observation before using the evidence.
            joined=await this.waitForTreeWork(agent,exec.signal,treeCheck,this.childWait(run,agent,'ready'));
            assertCurrent();
            this.assertChildrenQuiet(agent);
            this.assertObservedTreeQuiet(treeCheck);
          }
          if(joined||treeCheck?.revision!==revision||hasPendingChildResult(agent)) {
            if(receipt)throw new AppError('report-stale','已提交候选后又有子树活动，请核对，不能重用旧报告。');
            return {accepted:false,reason:'subtree-joined',next:'已等待子 Agent 树收敛。本次未提交成果，父轮次与目录占用仍在。请核对子 Agent 结果、文件与测试，再在本轮重新调用 ready。'};
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
    },{when:({agent})=>this.store.heldRuns().some(r=>r.sessionId===agent.id&&r.finishedAt===null)}));
    this.ctx.on('agent/created',({agent})=>{
      if(this.disposed)return;
      for(const run of this.store.heldRuns())if(run.sessionId===agent.id&&!this.running.has(run.id)) {
        const input=this.store.getRunInput(run.id);
        for(const message of [...agent.inbox.nextTurn,...agent.inbox.nextStep]) {
          const source=message.source;
          if(message.id===input.messageId&&source.kind==='super-bot'&&source.runId===run.id&&source.inputId===run.inputId&&source.taskId===run.taskId&&source.taskRevision===run.taskRevision&&source.generation===run.generation)agent.inbox.remove(message.id);
        }
      }
    });
    this.ctx.on('session/event',(session,event)=>{
      if(this.disposed)return;
      if(event.type==='turn/start')this.turnStarts.set(session,{turn:event.data.turn,seq:event.seq});
      if(!fullAccessEnabled(this.options)&&event.type==='working-directory/change') {
        const run=this.store.heldRuns().find(r=>r.sessionId===session.id&&r.finishedAt===null);
        if(run&&event.data.cwd!==this.store.getBinding(run.bindingId).cwd) {
          this.store.runRecovery(run.id,'原生会话工作目录已改变，当前执行授权停止。请核对文件和原生会话。');
          this.running.get(run.id)?.agent.cancel({kind:'user'},{keepInbox:true});
        }
      }
      if(event.type==='approval/asked') {
        const run=this.store.heldRuns().find(r=>r.sessionId===session.id&&r.finishedAt===null);
        if(run)this.store.nativeApprovalAsked(run.id,event.data.id,event.data.toolName,event.data.reason??'');
      }
      if(event.type==='approval/decided')this.store.nativeApprovalDecided(session.id,event.data.id,event.data.outcome);
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
          if(event.data.reason.kind==='error'&&run.finishedAt===null)this.store.runRecovery(run.id,modelFailureNote(event.data.reason.error.code));
          active.finishTurn(event.seq,event.data.reason.kind,event.time);
        }
        if(this.turnStarts.get(session)?.turn===event.data.turn)this.turnStarts.delete(session);
      }
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
    // No Agent is resolved or woken. Only old-process certificates plus durable log facts may settle.
    for(const run of this.store.heldRuns())if(run.finishedAt===null) {
      const proof=this.store.runTurn(run.id);
      if(!proof?.quiet||proof.endSeq===null)this.store.runRecovery(run.id,proof?'重启后缺少原进程的归属结束/后台收敛证据，保留占用；没有自动重投。':'旧版 Run 没有持久轮次证据，请人工核对；没有自动重投。',false);
      else this.scheduleReconciliation(run.id);
    }
  }
  /** Useful to callers/tests before inspecting startup reconciliation; never executes model work. */
  async whenReconciled():Promise<void> {await Promise.all([...this.finishing.values()]);}
  private scheduleReconciliation(runId:string,session?:Session):void {
    const done=Promise.resolve().then(()=>this.reconcileRun(runId,session)).catch(error=>{
      if(!this.disposed)this.store.runRecovery(runId,error instanceof AppError?error.message:'持久执行证据无法读取，请人工核对；没有重投。',!!session);
    }).finally(()=>{
      if(!this.disposed)for(const id of this.pendingHuman.get(runId)??[])this.store.nativeIntervention(this.store.getRun(runId).sessionId,id);
      this.pendingHuman.delete(runId);this.finishing.delete(runId);
    });
    this.finishing.set(runId,done);
  }
  private async reconcileRun(runId:string,session?:Session):Promise<void> {
    const run=this.store.getRun(runId);if(run.finishedAt!==null||this.disposed)return;
    const proof=this.store.runTurn(runId);if(!proof)throw new AppError('run-proof','旧版执行没有可归属的持久证据。');
    if(session&&!await (this.ctx.sessions as unknown as SessionStore).flush(session))throw new AppError('run-proof','宿主未确认轮次持久保存，保留占用。');
    const handle=await this.ctx.sessionPersistence.open(SessionId(run.sessionId),'read');
    let followups:string[];
    try {
      if(handle.header.id!==run.sessionId)throw new AppError('run-proof','持久会话身份不符。');
      followups=verifyRunTurn(run,this.store.getRunInput(runId),proof,(await handle.read()).events);
    }finally{await handle.close();}
    const current=this.store.getRun(runId);
    if(this.disposed||current.finishedAt!==null)return;
    if(current.state!=='cancelling'&&(!proof.reportId||this.store.finalReport(runId)?.id!==proof.reportId))throw new AppError('run-proof','没有绑定到结束边界的最终报告；不会推断完成。');
    const task=this.store.getTask(run.taskId),binding=this.store.activeBinding(run.taskId);
    if(task.taskRevision!==run.taskRevision||binding?.id!==run.bindingId||binding.generation!==run.generation||binding.sessionId!==run.sessionId)throw new AppError('run-proof','任务或会话绑定已改变，不能补结算。');
    // No awaits between settlement and native takeover: later human work cannot
    // become an automatic scheduling/review opportunity in between these writes.
    if(current.state==='cancelling')this.store.settleCancelled(runId,!!session);else this.store.settleRun(runId,!!session);
    for(const id of followups)this.store.nativeIntervention(run.sessionId,id);
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
    if(check?.pendingWaits||check?.active.size)throw new AppError('child-active','子 Agent 树仍有活动或清理未完成，保留目录占用。');
    if(check?.service) {
      const tree=this.nativeSubagents();
      if(check.waitFailed||originalService(tree)!==check.service||(!tree?.waitForTreeWork&&!tree?.waitForChildren)) {
        throw new AppError('child-unknown','原生子树状态不可核对，保留目录占用。');
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
  async attachExistingSession(requestId:string,grant:ExistingSessionGrant):Promise<Binding> {
    const receipt=this.store.commandReceipt<Binding>(requestId,'session.attach',grant);
    if(receipt)return this.store.getBinding(receipt.id);
    if(grant.fullHistoryApproved!==true||grant.directoryApproved!==true)throw new AppError('confirmation-required','请明确授权读取整个会话历史，以及在所示目录内执行文件任务。');
    const preview=await this.inspectExistingSession(grant.taskId,grant.sessionId);
    if(!preview.quiet)throw new AppError('session-busy',preview.reason);
    if(preview.cwd!==grant.cwd)throw new AppError('working-directory-changed','会话当前目录已改变，请重新检查后授权。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(grant.sessionId));
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
      configureRole(this.ctx,agent,'worker',this.options);
      if(inherited)agent.model.select(inherited);
    } catch {
      this.store.runRecovery(run.id,'配置本次执行会话时失败，尚未投递。请核对原生会话。');
      return this.store.getRun(run.id);
    }
    return this.deliverRun(run,agent,b);
  }
  private deliverRun(run:Run,agent:Agent,b:Binding):Run {
    if(this.running.has(run.id)||run.finishedAt!==null)return this.store.getRun(run.id);
    const taskId=run.taskId,task=this.store.getTask(taskId),botContext=this.store.taskBotContext(taskId);
    let input=this.store.getRunInput(run.id);
    if(!input.messageJson) {
      const convention=botContext.workConvention;
      const conventionPrompt=convention
        ? `\nWork convention recorded for this task (${convention.source}). Follow it within the current task scope and authorization:\n${convention.text}`
        : '';
      const supplement=`\nScheduling fact: Super Bot has reserved this working directory for the current run. Its ledger rejects concurrent runs in overlapping directories and keeps unresolved runs reserved. You do not need another confirmation that an earlier Super Bot run released this directory. This does not cover unrelated external processes.\n${input.kind==='answer'||input.kind==='rework'?`Additional user input (${input.kind}): ${input.content}`:''}`;
      const message=createUserMessage({source:{kind:'super-bot',taskId,runId:run.id,inputId:run.inputId,taskRevision:run.taskRevision,generation:run.generation},content:[{type:'text',text:`You are executing a NEW attempt of one Super Bot task.\nCurrent run: ${run.id}. Reports from previous attempts do not complete this run. Re-check current facts and perform the authorized work; do not merely repeat an earlier conclusion. Submit a fresh super_bot_report for this run.\nBot configuration revision: ${task.botConfigRevision}\nBot responsibility: ${botContext.instructions}${materialPrompt(botContext.materials)}${conventionPrompt}\nGoal: ${task.goal}\nAuthorized scope: ${task.scope}\nAcceptance criteria: ${task.acceptance}\nWorking directory: ${workdirSummary(b.cwd,b.workdir)}. Work only inside it; do not change other checkouts or directories.${supplement}\n${fullAccessEnabled(this.options)?'This Worker uses the native Full Access preset. Use native tools including shell to implement and test the requested work. Keep work scoped to this task. Do not modify unrelated projects or credentials. Change host configuration only when this task explicitly authorizes that change. Report actual changed source files and test results.':'Use only read/write/edit in this directory, always with absolute file_path values. Do not change working directories. Worker 完整权限未开启：当前 fullAccess: false。Shell and external CLI tools are unavailable in files mode; report this limitation, never ask for a tool channel. To enable them, set fullAccess: true in the Super Bot config of the active profile cordis.patch.yml and reload when idle.'}\n${CODE_DELIVERY}\nUse super_bot_report(progress) at meaningful checkpoints, such as written changes or a focused failing or passing test. State what was actually observed. For reloads, report a matching host receipt when available. Use waiting to ask a necessary question. For ready provide files and checks explaining every acceptance criterion. Never claim the task is accepted; the user decides.`}]});
      input=this.store.saveRunMessage(run.id,message.id,JSON.stringify(message));
    }
    const releaseMask=fullAccessEnabled(this.options)?()=>{}:agent.ctx.tools.restrict({allow:['read','write','edit','super_bot_report']});
    const releaseGuard=agent.ctx.tools.guard(exec=>{
      if(this.store.getRun(run.id).finishedAt!==null||this.store.getTask(taskId).controlMode==='manual')return 'This automatic run no longer has task authority.';
      if(exec.name!=='super_bot_report'&&this.store.finalReport(run.id))return 'A final report has been submitted; no new tool work is authorized in this run.';
      if(!fullAccessEnabled(this.options)&&!['read','write','edit','super_bot_report'].includes(exec.name))return 'Only task file tools and super_bot_report are authorized for this run.';
      if(fullAccessEnabled(this.options))return;
      try{this.assertDirectory(agent,b.cwd);}catch(error){return error instanceof Error?error.message:'Working directory changed';}
      if(!['read','write','edit'].includes(exec.name))return;
      try{const args=exec.arguments as {file_path?:unknown};if(typeof args.file_path!=='string'||!isAbsolute(args.file_path))return 'Use an absolute file_path inside the task working directory.';containedPath(b.cwd,args.file_path);}catch(error){return error instanceof Error?error.message:'File path refused';}
    });
    let steps=0;let deadline:ReturnType<typeof setTimeout>|undefined;
    const releaseBudget=fullAccessEnabled(this.options)?()=>{}:agent.ctx.on('agent/pre-step',async(_payload,next)=>{
      if(++steps>40){await this.stopForBudget(run.id,'steps');throw new AppError('run-budget','执行达到步数上限。');}
      return next();
    });
    let released=false;
    const release=()=>{
      if(released)return;
      released=true;clearTimeout(deadline);
      releaseStatus();releaseStopping();releaseTreeStart();releaseTreeEnd();
      for(const wait of treeCheck.waits.values())wait.finish('unknown',null);
      treeCheck.waits.clear();
      this.treeChecks.delete(run.id);releaseBudget();releaseGuard();releaseMask();
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
    const finishTurn=(endSeq?:number,endKind?:string,endTime?:number)=>{
      if(finalized||this.disposed)return;
      finalized=true;this.autoTurns.delete(run.id);
      try {
        for(const wait of treeCheck.waits.values())wait.finish(endKind==='aborted'?'cancelled':'unknown',endTime??null);
        let quiet=true,note='';
        try {
          this.assertExternalQuiet(agent);
          this.assertObservedTreeQuiet(treeCheck);
          if(endKind==='completed'&&(treeCheck.service||this.nativeSubagents())&&
            (!stoppingProof||stoppingProof.turn!==this.store.runTurn(run.id)?.turn||stoppingProof.revision!==treeCheck.revision)) {
            throw new AppError('child-unknown','原进程结束前没有同轮子树安静证明；不会用稍后空闲补成功。');
          }
        }catch(error){quiet=false;note=error instanceof AppError?error.message:'后台效果尚未核对。';}
        if(endSeq!==undefined&&endKind)this.store.observeRunEnd(run.id,endSeq,endKind,quiet);
        if(this.store.getRun(run.id).finishedAt!==null)return;
        if(!quiet)throw new AppError('run-proof',note);
        if(endSeq===undefined)throw new AppError('run-proof','没有可归属的自动轮次结束事件；仅会话空闲不足以补成功。');
        this.scheduleReconciliation(run.id,agent.session);
      }catch(error){this.store.runRecovery(run.id,error instanceof AppError?error.message:'执行状态待核对，请打开原生会话检查。');}
      finally{release();this.running.delete(run.id);}
    };
    const releaseStatus=agent.ctx.on('agent/status',({agent:subject,status})=>{
      if(subject===agent&&status==='idle')finishTurn();
    });
    try {
      if(!this.store.claimDispatch(run.id)){release();this.store.runRecovery(run.id,'投递记录已经发出，但回执不完整。没有重复投递，请核对原生会话。');return this.store.getRun(run.id);}
      agent.followup(freezeMessage(JSON.parse(input.messageJson!) as UserMessage));
      this.autoTurns.add(run.id);
      this.store.inputEnqueued(run.id);
      if(!fullAccessEnabled(this.options)){deadline=setTimeout(()=>{void this.stopForBudget(run.id,'time');},10*60*1000);deadline.unref();}
      const done=agent.whenIdle().then(()=>{
        if(this.disposed||finalized)return;
        this.assertQuiet(agent);finishTurn();
      }).catch(error=>{if(!this.disposed&&!finalized)this.store.runRecovery(run.id,error instanceof AppError?error.message:'执行状态待核对，请打开原生会话检查。');}).finally(()=>{this.autoTurns.delete(run.id);release();this.running.delete(run.id);});
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
  async accept(requestId:string,taskId:string,rowVersion:number,resultId:string,authorize?:()=>void) {
    const receipt=this.store.commandReceipt<import('./model.ts').Task>(requestId,'result.accept',{taskId,expectedRowVersion:rowVersion,resultId});
    if(receipt)return receipt;
    await this.verifyResult(taskId,resultId);
    authorize?.();
    const task=this.store.acceptResult(requestId,taskId,rowVersion,resultId);
    await this.autoCleanup(taskId);return task;
  }
  /** Removes a finished task's provisioned directory. Existing directories and running tasks are refused. */
  async cleanupWorkdir(taskId:string):Promise<Binding> {
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
  async stop(requestId:string,taskId:string,rowVersion:number) {
    const receipt=this.store.requestStop(requestId,taskId,rowVersion);
    if(this.store.getRun(receipt.runId).finishedAt!==null)return receipt;
    if(this.finishing.has(receipt.runId))return receipt; // Do not cancel a following human driver while the old end is being verified.
    const active=this.running.get(receipt.runId);
    if(!active){if(this.store.getRun(receipt.runId).finishedAt===null)this.store.runRecovery(receipt.runId,'停止请求已记录，但当前宿主没有这个执行句柄，请核对原生会话。');return receipt;}
    const input=this.store.getRunInput(receipt.runId);
    if(input.messageId)active.agent.inbox.remove(input.messageId as UserMessage['id']);
    active.agent.cancel({kind:'user'},{keepInbox:true});
    for(const job of this.ctx.jobs.list(active.agent.id))if(job.owner===active.agent.id&&['running','stopping'].includes(job.status))this.ctx.jobs.kill(job.id,active.agent.id,'Super Bot stop');
    const timeout=setTimeout(()=>{if(!this.disposed&&this.store.getRun(receipt.runId).finishedAt===null)this.store.runRecovery(receipt.runId,'停止已请求，但 10 秒内未确认收敛。请核对原生会话与后台工作。');},10000);timeout.unref();
    void active.done.finally(()=>clearTimeout(timeout));return receipt;
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
      canContinue=!!target.binding&&target.task.lifecycle==='open'&&!!target.task.scope&&!!target.task.acceptance;
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
  async recover(requestId:string,taskId:string,rowVersion:number,acknowledged:unknown,continuation?:RecoveryContinuation,authorize=()=>{}) {
    if(acknowledged!==true)throw new AppError('confirmation-required','请先检查原生会话、文件和外部效果，再确认核对完成。');
    const action=continuation?'run.continue-recovery':'run.resolve-recovery';
    const payload={taskId,expectedRowVersion:rowVersion,...continuation};
    const receipt=()=>this.store.commandReceipt<Task|Run>(requestId,action,payload);
    authorize();
    const prior=receipt();
    if(prior)return 'inputId' in prior?this.store.getRun(prior.id):prior;
    const target=this.store.recoveryTarget(taskId,rowVersion,continuation);
    return this.reloadAdmission.run(`Worker task ${taskId} recovery`,async()=>{
      const binding=target.binding;
      if(!binding?.sessionId)return this.store.resolveRunRecovery(requestId,taskId,rowVersion);
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
      if(!continuation)return this.store.resolveRunRecovery(requestId,taskId,rowVersion);
      this.assertDirectory(agent,binding.cwd);
      const modelRequired=()=>new AppError('model-required','请先在原生会话明确选择模型，再核对并继续。');
      const selected=selectedModel(this.ctx,agent);
      const plan=workerModelPlan(selected?modelRoute(selected):null,this.options.workerModel);
      if(!plan)throw modelRequired();
      const run=this.store.continueRunRecovery(requestId,taskId,rowVersion,continuation,plan);
      try {
        configureRole(this.ctx,agent,'worker',this.options);
        if(!selectedModel(this.ctx,agent))throw modelRequired();
        this.assertRecoveryQuiet(agent,target.run?.id);
        return this.deliverRun(run,agent,binding);
      }catch{
        // The new Run is already reserved. Preserve its receipt and quarantine any unknown delivery.
        this.store.runRecovery(run.id,'新执行未能确认开始。请检查原生会话；没有自动重投。');
        return this.store.getRun(run.id);
      }
    });
  }
  async endTaskLink(action:'task.cancel'|'session.detach',requestId:string,taskId:string,rowVersion:number) {
    const receipt=this.store.commandReceipt<Task>(requestId,action,{taskId,expectedRowVersion:rowVersion});if(receipt)return receipt;
    if(this.store.getTask(taskId).status==='recovery')throw new AppError('needs-attention','请先完成待核对事项。');
    const binding=this.store.activeBinding(taskId);
    if(binding?.sessionId) {
      const resolved=await this.ctx.sessionController.resolveAgent(SessionId(binding.sessionId));
      if('error' in resolved)throw new AppError('session-unavailable','无法核对原生会话，请恢复会话后再操作。');
      this.assertQuiet(resolved.agent);
    }
    if(action==='session.detach')return this.store.detachSession(requestId,taskId,rowVersion);
    const cancelled=this.store.cancelTask(requestId,taskId,rowVersion);await this.autoCleanup(taskId);return cancelled;
  }
  async dispose():Promise<void> {
    this.disposed=true;this.autoTurns.clear();
    for(const [id,{agent}]of this.running){this.store.runRecovery(id,'插件退出时执行尚未核对，重新启用后请核对原生会话。');const input=this.store.getRunInput(id);if(input.messageId)agent.inbox.remove(input.messageId as UserMessage['id']);agent.cancel({kind:'user'},{keepInbox:true});}
    await Promise.allSettled([...this.running.values()].map(r=>r.done));
    await this.whenReconciled();
  }
  async prepareSession(requestId:string,taskId:string,rowVersion:number,workdir?:WorkdirRequest):Promise<Binding> {
    const receipt=this.store.bindingReceipt(requestId,taskId,rowVersion);
    if(receipt?.state==='ready'||receipt?.state==='released')return receipt;
    return this.reloadAdmission.run(`Worker task ${taskId} session preparation`,()=>this.prepareWorker(requestId,taskId,rowVersion,workdir));
  }
  private async prepareWorker(requestId:string,taskId:string,rowVersion:number,workdir?:WorkdirRequest):Promise<Binding> {
    // Validate the ID through the ledger before using it as a directory segment.
    const task=this.store.getTask(taskId);
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
    const b=this.store.beginBinding(requestId,taskId,rowVersion,await realpath(cwd),info);
    const current=this.store.getBinding(b.id);if(current.state==='ready')return current;
    const active=this.creating.get(b.id);if(active)return active;
    if(!this.store.claimBindingCreation(b.id))return this.reconcileBinding(b.id);
    const promise=(async()=>{
      try {
        const workspace=await this.ctx.workspaceRegistry.create(b.cwd,basename(b.cwd));
        const result=await this.ctx.sessionController.create({workspaceId:workspace.id,sessionId:SessionId(b.requestedSessionId)});
        if(result.sessionId!==b.requestedSessionId){this.store.set(`native-create-mismatch:${b.id}`,result.sessionId);throw new AppError('session-mismatch','宿主返回了不同会话，尚未命名或关联。');}
        return await this.reconcileBinding(b.id);
      }catch(error){this.store.bindingRecovery(b.id);throw error instanceof AppError?error:new AppError('session-recovery','会话创建结果暂未确认，请在任务详情核对。');}
      finally{this.creating.delete(b.id);}
    })();this.creating.set(b.id,promise);return promise;
  }
  async reconcileBinding(id:string):Promise<Binding> {
    const b=this.store.getBinding(id);
    if(b.state==='ready'||b.state==='released')return b;
    if(this.store.get(`native-create-mismatch:${id}`))throw new AppError('session-mismatch','宿主已返回不同会话，保留待人工核对，不能自动关联原请求 ID。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(b.requestedSessionId));
    if('error' in resolved){this.store.bindingRecovery(id);throw new AppError('session-recovery','尚未找到已申请的会话；保持待核对，没有重复创建。');}
    const header=resolved.agent.session.header;
    if(resolved.agent.session.id!==b.requestedSessionId||header.origin==='subagent'||header.isSeeded||!header.cwd||await realpath(header.cwd)!==b.cwd){this.store.bindingRecovery(id);throw new AppError('session-mismatch','会话目录或归属不一致，尚未关联。');}
    const workspace=await this.ctx.workspaceRegistry.create(b.cwd,basename(b.cwd));await workspace.attachSession(SessionId(b.requestedSessionId));
    if(this.store.getBinding(id).state==='released')return this.store.getBinding(id);
    if(this.store.getTask(b.taskId).taskRevision!==b.taskRevision)throw new AppError('binding-stale','任务版本已改变，尚未命名旧会话。');
    await nameAutomaticSession(this.ctx,resolved.agent.session,workerTitle(this.store.getTask(b.taskId)));
    return this.store.confirmBinding(id,b.requestedSessionId);
  }
}
