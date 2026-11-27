import type { MirrorSelection } from '../mirror.ts';
import type { Task } from '../model.ts';
import type { WorkLink } from '../work-links.ts';
import type { WorkspaceApi } from './work/api.ts';

export type MainWork = {
  botId: string;
  link?: WorkLink;
  revision?: number;
  mirror?: MirrorSelection;
  focusFeishu?: boolean;
};

type Worker = { taskId: string; sessionId: string } & (
  | { kind: 'worker'; historical: boolean }
  | { kind: 'child'; parentSessionId: string }
);
type Location = { kind: 'work' } | Worker;

/** The browser remembers where each local Bot was last used. DSH owns native pane layout. */
export function createBotNavigation(
  api: Pick<WorkspaceApi, 'call' | 'openSession' | 'openChildSession'>,
  host: {
    openManager(botId: string, signal: AbortSignal, chatOnly?: boolean): Promise<void>;
    hasSession(sessionId: string, parentSessionId?: string): Promise<boolean>;
    showMainPanel(): void;
  },
) {
  const locations = new Map<string, Location>();
  let mainWork: MainWork | null = null;
  const listeners = new Set<() => void>();
  const setMainWork = (work: MainWork | null) => {
    if (mainWork === work) return;
    if (work && !work.mirror) locations.set(work.botId, { kind: 'work' });
    mainWork = work;
    for (const listener of listeners) listener();
  };

  async function select(botId: string, signal: AbortSignal) {
    if (signal.aborted) return;
    const location = locations.get(botId);
    if (location?.kind === 'work') {
      if (mainWork?.botId !== botId || mainWork.mirror) {
        host.showMainPanel();
        setMainWork({ botId });
      }
      return;
    }
    if (location) {
      const { sessionId, taskId } = location;
      const target =
        location.kind === 'child'
          ? { taskId, parentSessionId: location.parentSessionId }
          : { historical: location.historical };
      try {
        const owner = await api.call<{ botId: string; taskId: string } | null>(
          'session.worker-owner',
          { sessionId, ...target },
          signal,
        );
        if (signal.aborted || locations.get(botId) !== location) return;
        if (owner?.taskId === taskId && owner.botId === botId) {
          const available = await host.hasSession(
            sessionId,
            'parentSessionId' in target ? target.parentSessionId : undefined,
          );
          if (signal.aborted || locations.get(botId) !== location) return;
          if (available) {
            if (location.kind === 'child')
              api.openChildSession?.(location.parentSessionId, sessionId);
            else api.openSession(sessionId);
            return;
          }
        }
      } catch (error) {
        if (signal.aborted || locations.get(botId) !== location) return;
        if (!(error instanceof Error && 'code' in error && error.code === 'not-found')) throw error;
      }
      if (locations.get(botId) === location) locations.delete(botId);
    }
    await host.openManager(botId, signal, !!location);
  }

  return {
    mainWork: {
      getSnapshot: () => mainWork,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setMainWork,
    select,
    rememberManager(botId: string) {
      locations.delete(botId);
    },
    openWorker(task: Pick<Task, 'id' | 'botId'>, sessionId: string, historical = false) {
      api.openSession(sessionId);
      locations.set(task.botId, { kind: 'worker', taskId: task.id, sessionId, historical });
    },
    openChildWorker(task: Pick<Task, 'id' | 'botId'>, parentSessionId: string, sessionId: string) {
      if (!api.openChildSession) return;
      api.openChildSession(parentSessionId, sessionId);
      locations.set(task.botId, { kind: 'child', taskId: task.id, parentSessionId, sessionId });
    },
    forget(botId: string) {
      locations.delete(botId);
    },
  };
}
