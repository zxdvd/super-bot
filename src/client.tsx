import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorkspaceApi } from './ui/Workspace.tsx';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import { WorkButton, SessionWork } from './ui/SessionWork.tsx';
import { WORK_TAB, openBotConversation } from './ui/work-navigation.ts';
import { BotHome } from './ui/BotHome.tsx';

export const inject = ['slots', 'uiWorkspace', 'connection', 'layout', 'sidebarRight', 'sidebarRightTabs'];
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle };

function Icon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2m8-2v2m-7 3h6"/>
  </svg>;
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
    currentSession:()=>ctx.sidebarRight.mounted.getSnapshot(),
    openBot:(botId,navigation=ctx.layout.beginNavigation())=>openBotConversation(api,botId,navigation),
  };
  ctx.effect(()=>{
    const select=()=>{if(/^#super-bot-task=[a-f0-9-]{36}$/.test(location.hash))ctx.layout.selectPanel('super-bot' as MainPanelId);};
    const click=(event:MouseEvent)=>{
      const link=event.target instanceof Element?event.target.closest('a'):null;
      if(!link)return;const url=new URL(link.href,location.href);
      if(url.origin===location.origin&&url.pathname==='/api/super-bot-file'){
        event.stopPropagation();link.setAttribute('download','');return;
      }
      if(url.origin!==location.origin||!/^#super-bot-task=[a-f0-9-]{36}$/.test(url.hash))return;
      event.preventDefault();event.stopPropagation();
      history.replaceState(null,'',location.pathname+location.search+url.hash);select();window.dispatchEvent(new Event('hashchange'));
    };
    document.addEventListener('click',click,true);window.addEventListener('hashchange',select);
    return()=>{document.removeEventListener('click',click,true);window.removeEventListener('hashchange',select);};
  });
  const guide={id:'work',order:20,title:()=> '当前 Bot 的工作',description:()=> '进展、需要你处理的事与成果',icon:Icon};
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:WORK_TAB,kind:WORK_TAB,title:()=> '工作',guide:[guide]}));
  for(const name of ['conversation.session.header.actions','conversation.hero.options'] as const) {
    ctx.slots.inject(name,()=>ctx.slots.register({name,id:WORK_TAB,order:20},
      (props:{sessionId:SessionId})=><WorkButton api={api} sessionId={props.sessionId} sidebar={ctx.sidebarRight}/>));
  }
  type TabProps={sessionId:SessionId;useTabInfo:UseSidebarRightTabInfo};
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:WORK_TAB},(props:TabProps)=>{
    const {tab}=props.useTabInfo();
    return tab.visible?<SessionWork api={api} sessionId={props.sessionId} sidebar={ctx.sidebarRight} tabId={tab.id}/>:null;
  }));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'super-bot', inject: () => ({}) }, () => <BotHome api={api}/>));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'super-bot', order: 11, label: () => 'Super Bot' }, Icon));
}
