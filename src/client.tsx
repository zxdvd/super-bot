import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorkspaceApi } from './ui/Workspace.tsx';
import type { ManagerBinding } from './model.ts';
import { BotHome } from './ui/BotHome.tsx';

export const inject = ['slots', 'uiWorkspace', 'connection', 'layout'];
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle };

function Icon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2m8-2v2m-7 3h6"/></svg>;
}

export function apply(context: Context): void {
  const ctx = context as unknown as ClientContext;
  const api: WorkspaceApi = {
    async call<T>(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      const result = await ctx.connection.rpc.call('/api', 'super-bot', { ...payload, action }, signal);
      if (!result.ok) throw Object.assign(new Error(result.error.message),{code:result.error.code});
      return result.value as T;
    },
    openSession: id => ctx.uiWorkspace.openSession(id as SessionId),
    beginNavigation:()=>ctx.layout.beginNavigation(),
    async openBot(botId,navigation=ctx.layout.beginNavigation()) {
      if(navigation.aborted)return;
      const binding=await api.call<ManagerBinding>('manager.prepare',{botId,requestId:crypto.randomUUID()});
      if(navigation.aborted)return;
      if(binding.state!=='ready'||!binding.sessionId)throw new Error('对话尚未准备好，请在工作与设置中查看状态。');
      ctx.uiWorkspace.openSession(binding.sessionId as SessionId);
    },
  };
  ctx.effect(()=>{
    const select=()=>{if(/^#super-bot-task=[a-f0-9-]{36}$/.test(location.hash))ctx.layout.selectPanel('super-bot' as MainPanelId);};
    const click=(event:MouseEvent)=>{
      const link=event.target instanceof Element?event.target.closest('a'):null;
      if(!link)return;const url=new URL(link.href,location.href);
      if(url.origin===location.origin&&url.pathname==='/api/super-bot-file'){event.stopPropagation();link.setAttribute('download','');return;}
      if(url.origin!==location.origin||!/^#super-bot-task=[a-f0-9-]{36}$/.test(url.hash))return;
      event.preventDefault();event.stopPropagation();history.replaceState(null,'',location.pathname+location.search+url.hash);select();window.dispatchEvent(new Event('hashchange'));
    };
    document.addEventListener('click',click,true);window.addEventListener('hashchange',select);
    return()=>{document.removeEventListener('click',click,true);window.removeEventListener('hashchange',select);};
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'super-bot', inject: () => ({}) }, () => <BotHome api={api}/>));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'super-bot', order: 11, label: () => 'Super Bot' }, Icon));
}
