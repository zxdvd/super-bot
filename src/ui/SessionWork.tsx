import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { Bot } from '../model.ts';
import { Workspace, type WorkspaceApi } from './Workspace.tsx';
import { watchSessionBot, toggleSessionWork } from './work-navigation.ts';

type Resolved = { sessionId: string; bot: Bot | null; error?: string };
const buttonStyle = {
  cursor: 'pointer', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l3, #87908d50)',
  borderRadius: 7, padding: '5px 10px', font: 'inherit', whiteSpace: 'nowrap',
} as const;

function useSessionBot(api: WorkspaceApi, sessionId: string, sidebar: ISidebarRight) {
  const current = useSyncExternalStore(listener => sidebar.mounted.subscribe(listener), () => sidebar.mounted.getSnapshot());
  const [resolved, setResolved] = useState<Resolved>();
  useEffect(() => watchSessionBot(api, sessionId, sidebar.mounted, value => setResolved(value ? { sessionId, ...value } : undefined)),
    [api, sessionId, sidebar]);
  // Even retained slots cannot show the departing conversation's data in a new one.
  return current === sessionId && resolved?.sessionId === sessionId ? resolved : undefined;
}

export function WorkButton({ api, sessionId, sidebar }: { api: WorkspaceApi; sessionId: string; sidebar: ISidebarRight }) {
  const resolved = useSessionBot(api, sessionId, sidebar);
  if (!resolved?.bot) return null;
  return <button type="button" title={`${resolved.bot.name} · 打开或收起工作视图`} aria-label="打开或收起当前 Bot 的工作"
    onClick={() => toggleSessionWork(sessionId, sidebar)} style={buttonStyle}>工作</button>;
}

export function SessionWork({ api, sessionId, sidebar, tabId }: {
  api: WorkspaceApi; sessionId: string; sidebar: ISidebarRight; tabId: TabId;
}) {
  const resolved = useSessionBot(api, sessionId, sidebar);
  const back = () => { if (sidebar.mounted.getSnapshot() === sessionId) sidebar.hide(tabId); };
  if (!resolved?.bot) {
    const text = resolved?.error ?? (resolved
      ? '此会话不是当前有效的 Bot 对话，不展示其他 Bot 的任务。请从 Super Bot 打开当前对话。' : '正在核对当前对话…');
    return <div style={{ padding: 20, overflowWrap: 'anywhere' }}>
      <button onClick={back}>← 返回聊天</button><p role={resolved?.error ? 'alert' : 'status'}>{text}</p>
    </div>;
  }
  return <Workspace key={`${sessionId}:${resolved.bot.id}`} api={api} initialBotId={resolved.bot.id} sessionId={sessionId} compact
    onReturn={back}/>;
}
