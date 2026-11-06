import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { Workspace, type WorkspaceApi } from './ui/Workspace.tsx';

export const inject = ['slots', 'uiWorkspace', 'connection'];
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle };

function Icon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2m8-2v2m-7 3h6"/></svg>;
}

export function apply(context: Context): void {
  const ctx = context as unknown as ClientContext;
  const api: WorkspaceApi = {
    async call<T>(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      const result = await ctx.connection.rpc.call('/api', 'super-bot', { ...payload, action }, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value as T;
    },
    openSession: id => ctx.uiWorkspace.openSession(id as SessionId),
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'super-bot', inject: () => ({}) }, () => <Workspace api={api}/>));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'super-bot', order: 11, label: () => 'Super Bot' }, Icon));
}
