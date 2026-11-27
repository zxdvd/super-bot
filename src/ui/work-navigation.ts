import type { Context } from '@deepseek-ai/cordis';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { Bot, ManagerBinding, Task } from '../model.ts';
import { managedSessionId, type SessionOrigin } from '../mirror.ts';
import type { WorkspaceApi } from './Workspace.tsx';
import {
  parseResultFileLink,
  parseWorkLink,
  RESULT_FILE_PATH,
  workUrl,
  type WorkLink,
} from '../work-links.ts';
import type { Detail } from './work/types.ts';

export const WORK_TAB = 'super-bot-work';
export type FileTarget = NonNullable<ReturnType<typeof parseResultFileLink>> & { name: string };

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    [WORK_TAB]: { sessionId: string } & ({ botId: string; href: string } | { file: FileTarget });
  }
}

function isDesktopDocument(url: URL): boolean {
  return url.protocol === 'dsh-app:' && url.host === 'app' && !url.username && !url.password;
}

export function sameWorkHost(url: URL, current: URL): boolean {
  return isDesktopDocument(current)
    ? isDesktopDocument(url)
    : (current.protocol === 'http:' || current.protocol === 'https:') &&
        url.origin === current.origin;
}

export function workLinkForUrl(url: URL, current: URL): WorkLink | undefined {
  if (
    sameWorkHost(url, current) &&
    url.pathname === '/' &&
    !url.searchParams.has('resultId') &&
    !url.searchParams.has('attentionId')
  ) {
    return parseWorkLink(url.hash);
  }
}

type ChatDeliveryLink =
  | Extract<WorkLink, { kind: 'result' }>
  | ({ kind: 'file' } & NonNullable<ReturnType<typeof parseResultFileLink>>);

/** Only the exact delivery namespace is reserved in native chat. Arbitrary HTTP links keep DSH's handler. */
export function chatDeliveryLink(url: URL, current: URL): ChatDeliveryLink | 'blocked' | undefined {
  const isFile = url.pathname === RESULT_FILE_PATH;
  const hash = new URLSearchParams(url.hash.slice(1));
  if (!isFile && !(url.pathname === '/' && hash.has('super-bot-task') && hash.has('resultId')))
    return;
  const loopback = (value: URL) =>
    value.protocol === 'http:' && value.hostname === '127.0.0.1' && !!value.port;
  const localCarrier = loopback(url) && (isDesktopDocument(current) || loopback(current));
  if (url.username || url.password || (!sameWorkHost(url, current) && !localCarrier))
    return 'blocked';
  if (isFile) {
    const file = parseResultFileLink(url);
    return file ? { kind: 'file', ...file } : 'blocked';
  }
  const work = parseWorkLink(url.hash);
  return !url.search && work?.kind === 'result' ? work : 'blocked';
}

export async function openWorkLink(
  api: WorkspaceApi,
  sidebar: Pick<Context['sidebarRight'], 'mounted' | 'active' | 'openTab' | 'tabsIn'>,
  link: WorkLink,
  signal: AbortSignal,
  chatOnly = false,
): Promise<'sidebar' | 'work' | undefined> {
  if (signal.aborted) return;
  const fallback = chatOnly ? undefined : 'work';
  const sessionId = sidebar.mounted.getSnapshot();
  if (!sessionId || link.kind === 'task') return fallback;
  const navigation = api.beginNavigation(),
    request = new AbortController();
  const unsubscribe = sidebar.mounted.subscribe(() => request.abort());
  const current = AbortSignal.any([signal, navigation, request.signal]);
  try {
    const bot = await readSessionBot(api, sessionId, current, () => sidebar.mounted.getSnapshot());
    if (current.aborted || bot === undefined) return;
    if (!bot) return fallback;
    if (chatOnly && link.kind === 'result') {
      const detail = await api.call<Detail>(
        'task.detail',
        { id: link.taskId, resultId: link.resultId, sessionId },
        current,
      );
      if (
        current.aborted ||
        detail.task.id !== link.taskId ||
        detail.task.botId !== bot.id ||
        detail.linkedResult?.id !== link.resultId ||
        detail.linkedResult.taskId !== link.taskId
      )
        return;
    }
    const active = sidebar.active();
    const existing =
      active?.kind === WORK_TAB
        ? active
        : sidebar.tabsIn(sessionId).find((tab) => tab.kind === WORK_TAB);
    sidebar.openTab(WORK_TAB, {
      params: { sessionId, botId: bot.id, href: workUrl(link) },
      ...(existing ? { replaceTab: existing.id } : {}),
    });
    return 'sidebar';
  } catch {
    if (!current.aborted && sidebar.mounted.getSnapshot() === sessionId) return fallback;
  } finally {
    unsubscribe();
  }
}

/** No remembered Bot participates in this lookup. Undefined means a superseded read. */
export async function readSessionBot(
  api: WorkspaceApi,
  sessionId: string,
  signal: AbortSignal,
  currentSession: () => string | undefined,
): Promise<Bot | null | undefined> {
  try {
    const bot = await api.call<Bot | null>('bot.for-session', { sessionId }, signal);
    if (signal.aborted || currentSession() !== sessionId) return undefined;
    return bot?.managerSessionId === sessionId ? bot : null;
  } catch (error) {
    if (signal.aborted || currentSession() !== sessionId) return undefined;
    throw error;
  }
}

export interface SessionSource {
  getSnapshot(): string | undefined;
  subscribe(listener: () => void): () => void;
}
export type SessionBotState = { bot: Bot | null; error?: string };

export function watchSessionOrigin(
  api: WorkspaceApi,
  sessionId: string,
  source: SessionSource,
  receive: (origin: SessionOrigin | undefined) => void,
): () => void {
  let controller: AbortController | undefined;
  const changed = () => {
    controller?.abort();
    receive(undefined);
    if (source.getSnapshot() !== sessionId || !managedSessionId.test(sessionId)) return;
    controller = new AbortController();
    const { signal } = controller;
    void api
      .call<SessionOrigin | null>('session.origin', { sessionId }, signal)
      .then((origin) => {
        if (
          !signal.aborted &&
          source.getSnapshot() === sessionId &&
          origin &&
          (origin.owner === 'web' || origin.owner === 'desktop') &&
          typeof origin.local === 'boolean'
        )
          receive(origin);
      })
      .catch(() => {
        /* No hint until the origin is known. */
      });
  };
  const unsubscribe = source.subscribe(changed);
  changed();
  return () => {
    controller?.abort();
    unsubscribe();
  };
}

/** UI-only refresh; native selection changes invalidate reads synchronously, including A → B → A. */
export function watchSessionBot(
  api: WorkspaceApi,
  sessionId: string,
  source: SessionSource,
  receive: (state: SessionBotState | undefined) => void,
): () => void {
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  async function pull(signal: AbortSignal) {
    try {
      const bot = await readSessionBot(api, sessionId, signal, () => source.getSnapshot());
      if (!signal.aborted && bot !== undefined) receive({ bot });
    } catch (error) {
      if (!signal.aborted)
        receive({
          bot: null,
          error: error instanceof Error ? error.message : '暂时无法读取会话归属。',
        });
    }
    if (!signal.aborted) timer = setTimeout(() => void pull(signal), 5000);
  }
  const changed = () => {
    controller.abort();
    clearTimeout(timer);
    controller = new AbortController();
    receive(undefined);
    if (source.getSnapshot() === sessionId) void pull(controller.signal);
  };
  const unsubscribe = source.subscribe(changed);
  changed();
  return () => {
    unsubscribe();
    controller.abort();
    clearTimeout(timer);
  };
}

/** Preparing a conversation may commit after navigation; opening it must not. */
export async function openBotConversation(
  api: WorkspaceApi,
  botId: string,
  navigation: AbortSignal,
  open = api.openSession,
): Promise<void> {
  if (navigation.aborted) return;
  let binding: ManagerBinding;
  try {
    binding = await api.call<ManagerBinding>('manager.prepare', {
      botId,
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    if (navigation.aborted) return;
    throw error;
  }
  if (navigation.aborted) return;
  if (binding.botId !== botId || binding.state !== 'ready' || !binding.sessionId)
    throw new Error('对话尚未准备好，请在“工作”的设置（⋯）中查看状态。');
  open(binding.sessionId);
}

/** A delivery link resolves its real task owner, but cannot outlive navigation away. */
export async function readTaskLink(
  api: WorkspaceApi,
  taskId: string,
  signal: AbortSignal,
  navigation: AbortSignal,
): Promise<Task | undefined> {
  try {
    const { task } = await api.call<{ task: Task }>('task.detail', { id: taskId }, signal);
    if (signal.aborted || navigation.aborted || task.id !== taskId) return undefined;
    return task;
  } catch (error) {
    if (signal.aborted || navigation.aborted) return undefined;
    throw error;
  }
}

/** The native controller targets its on-screen Session, not the caller's old closure. */
export function toggleSessionWork(
  sessionId: string,
  sidebar: Pick<ISidebarRight, 'mounted' | 'active' | 'isExpanded' | 'hide' | 'openTab'>,
): void {
  if (sidebar.mounted.getSnapshot() !== sessionId) return;
  const active = sidebar.active();
  if (active?.kind === WORK_TAB && sidebar.isExpanded()) sidebar.hide(active.id);
  else sidebar.openTab(WORK_TAB);
}
