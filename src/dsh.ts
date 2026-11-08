/** The only execution adapter. Product state never depends on a DSH object. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage,freezeMessage,type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { mkdir, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join,isAbsolute,basename } from 'node:path';
import {nameAutomaticSession,workerTitle} from './sidebar.ts';
import { AppError,requiredText,optionalText,type Binding,type Run,type WorkReport,type ExistingSessionGrant,type ExistingSessionPreview } from './model.ts';
import type { Store } from './store.ts';
import { collectEvidence,containedPath,verifyEvidence,evidencePaths } from './evidence.ts';
import {configureRole,type RuntimeOptions} from './runtime.ts';
import { materialPrompt } from './materials.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {'super-bot':{kind:'super-bot';taskId:string;runId:string;inputId:string;taskRevision:number;generation:number}}
}

/** Host defaults are not a model selection made for this conversation. */
export function selectedModel(ctx:Context,agent:Agent) {
  return ctx.sessionProjections.snapshot(agent.session,['modelSelection']).values.modelSelection?.next??undefined;
}
export function modelFailureNote(code:string):string {
  if(code==='MISSING_CREDENTIAL')return '模型缺少登录或 API Key。请打开原生会话配置模型账号，再核对并继续；本次没有自动重试。';
  if(['INVALID_CREDENTIAL','AUTHENTICATION','AUTH'].includes(code))return '模型认证失败。请在原生会话检查模型账号，再核对并继续；本次没有自动重试。';
  if(['QUOTA','ACCOUNT_QUOTA'].includes(code))return '模型账号额度不足。请检查原生模型设置与额度；本次没有自动重试。';
  if(code==='NO_ADAPTER')return '所选模型提供方当前不可用。请打开原生会话重新选择模型；本次没有自动重试。';
  return '原生模型执行失败。请打开对应会话查看错误、核对文件与执行状态后再继续；本次没有自动重试。';
}

export class DshExecution {
  private creating=new Map<string,Promise<Binding>>();
  private running=new Map<string,{agent:Agent;release:()=>void;done:Promise<void>}>();
  private disposed=false;
  constructor(private ctx:Context,private store:Store,private dataDir:string,private options:RuntimeOptions={}) {}
  install():void {
    this.ctx.effect(()=>this.ctx.tools.register({name:'super_bot_report',description:'Report progress, a question, a blockage, failure, or ready results to the task ledger. Ready requires files and acceptance checks. A ready report requests human review, it does not complete the task.',
      parameters:{type:'object',properties:{kind:{type:'string',enum:['progress','waiting','ready','blocked','failed']},summary:{type:'string'},checks:{type:'string'},files:{type:'array',items:{type:'string'},maxItems:10}},required:['kind','summary'],additionalProperties:false},
      output:{schema:{type:'object',properties:{accepted:{type:'boolean'},resultId:{type:'string'}},required:['accepted'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{
        const run=this.store.heldRuns().find(r=>r.sessionId===exec.agent?.id&&r.finishedAt===null);
        if(!run)throw new AppError('report-scope','当前会话没有可报告的执行。');
        const data=args as Record<string,unknown>;const binding=this.store.getBinding(run.bindingId);
        const report:WorkReport={kind:data.kind as WorkReport['kind'],summary:requiredText(data.summary,'报告内容'),checks:optionalText(data.checks,'验收说明')};
        if(report.kind==='ready')report.requestedFiles=evidencePaths(data.files);
        exec.signal.throwIfAborted();
        const receipt=this.store.workerReportReceipt(run.id,exec.callId,report);
        if(receipt){if(report.kind!=='progress')exec.concludeTurn();return receipt;}
        if(report.kind==='ready')report.evidence=await collectEvidence(binding.cwd,report.requestedFiles);
        exec.signal.throwIfAborted();
        const result=this.store.workerReport(run.id,exec.callId,report);
        if(report.kind!=='progress')exec.concludeTurn();return result;
      },
    },{when:({agent})=>this.store.heldRuns().some(r=>r.sessionId===agent.id&&r.finishedAt===null)}));
    this.ctx.on('session/event',(session,event)=>{
      if(this.disposed)return;
      if(event.type==='turn/end'&&event.data.reason.kind==='error') {
        const run=this.store.heldRuns().find(r=>r.sessionId===session.id&&r.finishedAt===null);
        if(run)this.store.runRecovery(run.id,modelFailureNote(event.data.reason.error.code));
      }
      if(!this.options.fullAccess&&event.type==='working-directory/change') {
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
        if(this.store.heldRuns().some(r=>r.id===source.runId&&r.sessionId===session.id&&r.inputId===source.inputId))this.store.inputEntered(source.runId,event.data.id,event.seq);
      }
      const messages=event.type==='agent/inbox/spliced'?event.data.inserted:event.type==='user/message'?[event.data]:[];
      for(const message of messages)if(message.source.kind==='user'&&'rpcId' in message.source) {
        const previous=this.store.heldRuns().find(run=>run.sessionId===session.id&&run.finishedAt===null);
        const changed=this.store.nativeIntervention(session.id,message.id);
        if(changed&&previous) {
          const active=this.running.get(previous.id),input=this.store.getRunInput(previous.id);
          if(active){if(input.messageId)active.agent.inbox.remove(input.messageId as UserMessage['id']);active.agent.cancel({kind:'user'},{keepInbox:true});}
        }
      }
    });
    // A process restart cannot infer absence of an external effect from an idle fresh Agent.
    for(const run of this.store.heldRuns())if(run.finishedAt===null)this.store.runRecovery(run.id,'宿主重新加载，需要核对上次输入和执行；没有自动重投。');
  }
  private assertQuiet(agent:Agent):void {
    if(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)throw new AppError('session-busy','任务会话有活动或待处理输入，请先在原生会话核对。');
    if(this.ctx.jobs.list(agent.id).some(job=>job.owner===agent.id&&['running','stopping'].includes(job.status)))throw new AppError('job-active','后台工作尚未停止，不能开始或确认执行结束。');
    if(this.ctx.agents.list().some(child=>this.ctx.agents.isOwnedBy(child.id,agent)))throw new AppError('child-active','会话仍有子 Agent，需要先核对。');
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
  async dispatch(requestId:string,taskId:string,rowVersion:number,authorize:()=>void=()=>{}):Promise<Run> {
    if(this.disposed)throw new AppError('unavailable','插件正在退出。');
    const receipt=this.store.commandReceipt<Run>(requestId,'task.dispatch',{taskId,expectedRowVersion:rowVersion});
    if(receipt)return this.store.getRun(receipt.id);
    const b=this.store.activeBinding(taskId);if(!b?.sessionId||b.state!=='ready')throw new AppError('not-ready','请先准备执行会话。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(b.sessionId));
    if('error' in resolved)throw new AppError('session-unavailable','执行会话暂不可用，请核对。');
    const agent=resolved.agent;this.assertQuiet(agent);this.assertDirectory(agent,b.cwd);configureRole(this.ctx,agent,'worker',this.options);
    if(!selectedModel(this.ctx,agent))throw new AppError('model-required','请先打开任务会话，明确选择并配置模型，再回来开始执行。宿主默认路由不算已选择。');
    authorize();
    const run=this.store.reserveRun(requestId,taskId,rowVersion);
    if(this.running.has(run.id)||run.finishedAt!==null)return this.store.getRun(run.id);
    const task=this.store.getTask(taskId);const botContext=this.store.taskBotContext(taskId);
    let input=this.store.getRunInput(run.id);
    if(!input.messageJson) {
      const supplement=`\nScheduling fact: Super Bot has reserved this working directory for the current run. Its ledger rejects concurrent runs in overlapping directories and keeps unresolved runs reserved. You do not need another confirmation that an earlier Super Bot run released this directory. This does not cover unrelated external processes.\n${input.kind==='answer'||input.kind==='rework'?`Additional user input (${input.kind}): ${input.content}`:''}`;
      const message=createUserMessage({source:{kind:'super-bot',taskId,runId:run.id,inputId:run.inputId,taskRevision:run.taskRevision,generation:run.generation},content:[{type:'text',text:`You are executing a NEW attempt of one Super Bot task.\nCurrent run: ${run.id}. Reports from previous attempts do not complete this run. Re-check current facts and perform the authorized work; do not merely repeat an earlier conclusion. Submit a fresh super_bot_report for this run.\nBot configuration revision: ${task.botConfigRevision}\nBot responsibility: ${botContext.instructions}${materialPrompt(botContext.materials)}\nGoal: ${task.goal}\nAuthorized scope: ${task.scope}\nAcceptance criteria: ${task.acceptance}\nWorking directory: ${b.cwd}${supplement}\n${this.options.fullAccess?'Full Access is explicitly authorized. Use native tools including shell to implement and test the requested work. Keep work scoped to this task. Do not modify unrelated projects or credentials. Change host configuration only when this task explicitly authorizes that change. Report actual changed source files and test results.':'Use only read/write/edit in this directory, always with absolute file_path values. Do not change working directories. Shell and subagents are not enabled in this preview.'}\nReport with super_bot_report. Use waiting to ask a necessary question. For ready provide files and checks explaining every acceptance criterion. Never claim the task is accepted; the user decides.`}]});
      input=this.store.saveRunMessage(run.id,message.id,JSON.stringify(message));
    }
    const releaseMask=this.options.fullAccess?()=>{}:agent.ctx.tools.restrict({allow:['read','write','edit','super_bot_report']});
    const releaseGuard=agent.ctx.tools.guard(exec=>{
      if(this.store.getRun(run.id).finishedAt!==null||this.store.getTask(taskId).controlMode==='manual')return 'This automatic run no longer has task authority.';
      if(!this.options.fullAccess&&!['read','write','edit','super_bot_report'].includes(exec.name))return 'Only task file tools and super_bot_report are authorized for this run.';
      if(this.options.fullAccess)return;
      try{this.assertDirectory(agent,b.cwd);}catch(error){return error instanceof Error?error.message:'Working directory changed';}
      if(this.options.fullAccess||!['read','write','edit'].includes(exec.name))return;
      try{const args=exec.arguments as {file_path?:unknown};if(typeof args.file_path!=='string'||!isAbsolute(args.file_path))return 'Use an absolute file_path inside the task working directory.';containedPath(b.cwd,args.file_path);}catch(error){return error instanceof Error?error.message:'File path refused';}
    });
    let steps=0;let deadline:ReturnType<typeof setTimeout>|undefined;
    const releaseBudget=this.options.fullAccess?()=>{}:agent.ctx.on('agent/pre-step',async(_payload,next)=>{
      if(++steps>40){await this.stopForBudget(run.id,'steps');throw new AppError('run-budget','执行达到步数上限。');}
      return next();
    });
    let released=false;const release=()=>{if(released)return;released=true;clearTimeout(deadline);releaseStatus();releaseBudget();releaseGuard();releaseMask();};
    // DSH publishes idle after the aborted driver converges, before it can wake
    // queued human work. whenIdle() can follow that new driver, so it is too late
    // to release an interrupted Run's restrictions for a native handoff.
    const releaseStatus=agent.ctx.on('agent/status',({status})=>{
      if(status==='idle'&&this.store.getRun(run.id).finishedAt!==null&&this.store.getTask(taskId).controlMode==='manual'){release();this.running.delete(run.id);}
    });
    try {
      if(!this.store.claimDispatch(run.id)){release();this.store.runRecovery(run.id,'投递记录已经发出，但回执不完整。没有重复投递，请核对原生会话。');return this.store.getRun(run.id);}
      agent.followup(freezeMessage(JSON.parse(input.messageJson!) as UserMessage));
      this.store.inputEnqueued(run.id);
      if(!this.options.fullAccess){deadline=setTimeout(()=>{void this.stopForBudget(run.id,'time');},10*60*1000);deadline.unref();}
      const done=agent.whenIdle().then(()=>{
        if(this.disposed)return;
        this.assertQuiet(agent);
        if(this.store.getRun(run.id).state==='cancelling')this.store.settleCancelled(run.id);else this.store.settleRun(run.id);
      }).catch(error=>{if(!this.disposed)this.store.runRecovery(run.id,error instanceof AppError?error.message:'执行状态待核对，请打开原生会话检查。');}).finally(()=>{clearTimeout(deadline);release();this.running.delete(run.id);});
      this.running.set(run.id,{agent,release,done});
      return this.store.getRun(run.id);
    }catch(error){
      // A throw may happen AFTER the inbox accepted the message. Keep the mask until idle.
      try{this.store.runRecovery(run.id,'输入投递未能确认，没有自动重投。请核对原生会话。');}
      finally {
        if(input.messageId)agent.inbox.remove(input.messageId as UserMessage['id']);
        agent.cancel({kind:'user'},{keepInbox:true});
        const done=agent.whenIdle().catch(()=>{}).finally(()=>{release();this.running.delete(run.id);});
        this.running.set(run.id,{agent,release,done});
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
  async accept(requestId:string,taskId:string,rowVersion:number,resultId:string) {
    const receipt=this.store.commandReceipt<import('./model.ts').Task>(requestId,'result.accept',{taskId,expectedRowVersion:rowVersion,resultId});
    if(receipt)return receipt;
    await this.verifyResult(taskId,resultId);
    return this.store.acceptResult(requestId,taskId,rowVersion,resultId);
  }
  async verifyResult(taskId:string,resultId:string) {
    const detail=this.store.taskDetail(taskId);
    if(!detail.result||detail.result.id!==resultId||!detail.binding?.sessionId)throw new AppError('result-stale','当前成果不存在或已经改变。');
    const resolved=await this.ctx.sessionController.resolveAgent(SessionId(detail.binding.sessionId));
    if('error' in resolved)throw new AppError('session-unavailable','无法核对原生会话，暂未验收。');
    this.assertQuiet(resolved.agent);await verifyEvidence(detail.binding.cwd,detail.result.evidence);this.assertQuiet(resolved.agent);
    return detail;
  }
  async stop(requestId:string,taskId:string,rowVersion:number) {
    const receipt=this.store.requestStop(requestId,taskId,rowVersion);
    if(this.store.getRun(receipt.runId).finishedAt!==null)return receipt;
    const active=this.running.get(receipt.runId);
    if(!active){if(this.store.getRun(receipt.runId).finishedAt===null)this.store.runRecovery(receipt.runId,'停止请求已记录，但当前宿主没有这个执行句柄，请核对原生会话。');return receipt;}
    const input=this.store.getRunInput(receipt.runId);
    if(input.messageId)active.agent.inbox.remove(input.messageId as UserMessage['id']);
    active.agent.cancel({kind:'user'},{keepInbox:true});
    for(const job of this.ctx.jobs.list(active.agent.id))if(job.owner===active.agent.id&&['running','stopping'].includes(job.status))this.ctx.jobs.kill(job.id,active.agent.id,'Super Bot stop');
    const timeout=setTimeout(()=>{if(!this.disposed&&this.store.getRun(receipt.runId).finishedAt===null)this.store.runRecovery(receipt.runId,'停止已请求，但 10 秒内未确认收敛。请核对原生会话与后台工作。');},10000);timeout.unref();
    void active.done.finally(()=>clearTimeout(timeout));return receipt;
  }
  async recover(requestId:string,taskId:string,rowVersion:number,acknowledged:unknown) {
    if(acknowledged!==true)throw new AppError('confirmation-required','请先检查原生会话、文件和外部效果，再确认核对完成。');
    const receipt=this.store.commandReceipt<import('./model.ts').Task>(requestId,'run.resolve-recovery',{taskId,expectedRowVersion:rowVersion});if(receipt)return receipt;
    const sessionId=this.store.activeBinding(taskId)?.sessionId;
    if(sessionId) {
      const resolved=await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
      if('error' in resolved)throw new AppError('session-unavailable','无法读取原生会话，暂未释放执行占用。');
      this.assertQuiet(resolved.agent);
    }
    return this.store.resolveRunRecovery(requestId,taskId,rowVersion);
  }
  async endTaskLink(action:'task.cancel'|'session.detach',requestId:string,taskId:string,rowVersion:number) {
    const receipt=this.store.commandReceipt<import('./model.ts').Task>(requestId,action,{taskId,expectedRowVersion:rowVersion});if(receipt)return receipt;
    const binding=this.store.activeBinding(taskId);
    if(binding?.sessionId) {
      const resolved=await this.ctx.sessionController.resolveAgent(SessionId(binding.sessionId));
      if('error' in resolved)throw new AppError('session-unavailable','无法核对原生会话，请恢复会话后再操作。');
      this.assertQuiet(resolved.agent);
    }
    return action==='task.cancel'?this.store.cancelTask(requestId,taskId,rowVersion):this.store.detachSession(requestId,taskId,rowVersion);
  }
  async dispose():Promise<void> {
    this.disposed=true;
    for(const [id,{agent}]of this.running){this.store.runRecovery(id,'插件退出时执行尚未核对，重新启用后请核对原生会话。');const input=this.store.getRunInput(id);if(input.messageId)agent.inbox.remove(input.messageId as UserMessage['id']);agent.cancel({kind:'user'},{keepInbox:true});}
    await Promise.allSettled([...this.running.values()].map(r=>r.done));
  }
  async prepareSession(requestId:string,taskId:string,rowVersion:number):Promise<Binding> {
    const receipt=this.store.bindingReceipt(requestId,taskId,rowVersion);
    if(receipt?.state==='ready'||receipt?.state==='released')return receipt;
    // Validate the ID through the ledger before using it as a directory segment.
    const task=this.store.getTask(taskId);
    const generation=this.store.nextBindingGeneration(taskId);
    const cwd=this.store.activeBinding(taskId)?.cwd??(this.options.fullAccess&&this.options.workspace?realpathSync(this.options.workspace):undefined)??join(this.dataDir,'workspaces',generation===1?task.id:`${task.id}-g${generation}`);await mkdir(cwd,{recursive:true});
    const b=this.store.beginBinding(requestId,taskId,rowVersion,await realpath(cwd));
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
