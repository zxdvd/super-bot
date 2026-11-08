/** Small native-sidebar adapter. No archive, lifecycle, or preference synchronizer. */
import type {Context} from '@deepseek-ai/cordis';
import type {Session,SessionStore} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import {SessionId} from '@deepseek-ai/dsh-session/types';
import {realpath} from 'node:fs/promises';
import {AppError,type Task} from './model.ts';
import type {Store} from './store.ts';

export function workerTitle(task:Pick<Task,'id'|'goal'>):string {
  const label=task.goal.split(/[\n\r：:。!?！？]/u,1)[0]!.replace(/\s+/gu,' ').trim();
  const chars=[...(label||'任务')];
  return `Worker · ${chars.slice(0,24).join('')}${chars.length>24?'…':''} · ${task.id.slice(0,6)}`;
}

/** Source is authoritative, not text (even a user-chosen "Untitled" is custom).
 * get→rename is synchronous: a user rename cannot slip between the check and append.
 * Always retry the durability barrier, never repeat an already user-owned title append.
 */
export async function nameAutomaticSession(ctx:Context,session:Session,title:string):Promise<boolean> {
  const before=ctx.sessionTitle.get(session);
  const changed=!before||before.source.kind==='fallback'||before.source.kind==='provider';
  if(changed)ctx.sessionTitle.rename(session,title);
  if(!await (ctx.sessions as unknown as SessionStore).flush(session))throw new AppError('sidebar-durability','会话名称尚未确认持久保存，请重试整理；不会重新创建或执行任务。');
  return changed;
}

export class NativeSidebar {
  constructor(private ctx:Context,private store:Store){}
  private current(botId:string,sessionId:string):void {
    if(this.store.botForSession(sessionId)?.id!==botId)throw new AppError('sidebar-scope','请从当前有效的 Bot 主聊天操作，不处理其他 Bot 或历史管理对话。');
  }
  /** Only a deliberate click pins. Opening, preparing, and tidying never repin. */
  async pin(botId:string,sessionId:string):Promise<void> {
    this.current(botId,sessionId);
    if(this.ctx.workspaceRegistry.pinnedSessionIds.includes(SessionId(sessionId)))return;
    await this.ctx.workspaceRegistry.pinSession(SessionId(sessionId));
  }
  async tidy(botId:string,sessionId:string):Promise<{renamed:number;kept:number;failed:number}> {
    this.current(botId,sessionId);
    const result={renamed:0,kept:0,failed:0};
    const manager=this.store.activeManager(botId)!;
    const candidates=[{sessionId,cwd:manager.cwd,title:this.store.getBot(botId).name,bindingId:null,taskRevision:0},...this.store.sidebarWorkers(botId).map(({binding,task})=>({sessionId:binding.sessionId!,cwd:binding.cwd,title:workerTitle(task),bindingId:binding.id,taskRevision:binding.taskRevision}))];
    for(const candidate of candidates) {
      this.current(botId,sessionId);
      if(this.ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(candidate.sessionId))){result.kept++;continue;}
      try {
        // Never resolve/resume an Agent merely to tidy presentation. Cold history
        // stays native/manual; opening it is a separate user lifecycle decision.
        const session=(this.ctx.sessions as unknown as SessionStore).get(SessionId(candidate.sessionId));
        if(!session){result.kept++;continue;}
        const header=session.header;
        if(session.id!==candidate.sessionId||header.origin==='subagent'||header.isSeeded||!header.cwd||await realpath(header.cwd)!==candidate.cwd){result.kept++;continue;}
        this.current(botId,sessionId);
        if(this.ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(candidate.sessionId))||(this.ctx.sessions as unknown as SessionStore).get(SessionId(candidate.sessionId))!==session){result.kept++;continue;}
        if(candidate.bindingId){const binding=this.store.getBinding(candidate.bindingId);if(binding.sessionId!==candidate.sessionId||this.store.getTask(binding.taskId).taskRevision!==candidate.taskRevision){result.kept++;continue;}}
        // User title, archive and ledger ownership are now checked without an await
        // before native rename. The only remaining await is its durability barrier.
        const renamed=await nameAutomaticSession(this.ctx,session,candidate.title);
        this.current(botId,sessionId);
        if(renamed)result.renamed++;else result.kept++;
      }catch(error){if(error instanceof AppError&&error.code==='sidebar-scope')throw error;result.failed++;}
    }
    // Existing Workspace title has no provenance, even when it resembles our old
    // generated title or all its accounted sessions look owned. Leave it native/manual.
    return result;
  }
}
