import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type { WorkspaceApi } from './ui/Workspace.tsx';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import { WorkButton, SessionOriginHint, SessionWork } from './ui/SessionWork.tsx';
import {
  WORK_TAB,
  chatDeliveryLink,
  openBotConversation,
  openWorkLink,
  sameWorkHost,
  workLinkForUrl,
} from './ui/work-navigation.ts';
import { returningToReloadSettings } from './ui/DeveloperSettings.tsx';
import { createWorkFeed, SessionBadge } from './ui/work/activity.tsx';
import { BotHome } from './ui/BotHome.tsx';
import { installBotSidebar } from './ui/BotSidebar.tsx';
import { createBotNavigation } from './ui/bot-navigation.ts';
import { ChatDeliveryLinks, type ChatDeliverySlot } from './ui/ChatDeliveryLinks.tsx';
import { parseWorkLink, RESULT_FILE_PATH, workUrl } from './work-links.ts';

export const inject = [
  'slots',
  'uiWorkspace',
  'connection',
  'sessions',
  'layout',
  'sidebarRight',
  'sidebarRightTabs',
];
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle };

function Icon({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <rect x="4" y="7" width="16" height="13" rx="4" />
      <path d="M12 3v4M8 12v2m8-2v2m-7 3h6" />
    </svg>
  );
}

export function apply(context: Context): void {
  const ctx = context as unknown as ClientContext;
  const panel = 'super-bot' as MainPanelId;
  const clearWorkHash = () => {
    if (typeof location !== 'undefined' && parseWorkLink(location.hash))
      history.replaceState(history.state, '', location.pathname + location.search);
  };
  let chatOnly: string | undefined;
  const hideWork = (sessionId: string) => {
    if (chatOnly !== sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
    for (const tab of ctx.sidebarRight.tabsIn(sessionId as SessionId)) {
      if (tab.kind === WORK_TAB) ctx.sidebarRight.hide(tab.id);
    }
  };
  const api: WorkspaceApi = {
    async call<T>(
      action: string,
      payload: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): Promise<T> {
      const result = await ctx.connection.rpc.call(
        '/api',
        'super-bot',
        { ...payload, action },
        signal,
      );
      if (!result.ok)
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value as T;
    },
    openSession: (id) => {
      clearWorkHash();
      ctx.uiWorkspace.openSession(id as SessionId);
    },
    openChildSession: (parentId, childId) => {
      clearWorkHash();
      ctx.uiWorkspace.openSession({
        parentSessionId: parentId as SessionId,
        childSessionId: childId as SessionId,
        mode: 'unknown',
      });
    },
    beginNavigation: () => ctx.layout.beginNavigation(),
    currentSession: () => ctx.sidebarRight.mounted.getSnapshot(),
    watchCurrentSession: (listener) => ctx.sidebarRight.mounted.subscribe(listener),
    openBot: (botId, navigation = ctx.layout.beginNavigation()) =>
      openBotConversation(api, botId, navigation, (id) => {
        chatOnly = id;
        api.openSession(id);
        api.botNavigation.rememberManager(botId);
        hideWork(id);
      }),
    openHome: () => ctx.layout.selectPanel(panel),
    botNavigation: createBotNavigation(
      {
        call: (...args) => api.call(...args),
        openSession: (id) => api.openSession(id),
        openChildSession: (parent, child) => api.openChildSession?.(parent, child),
      },
      {
        openManager: (id, signal, managerOnly) =>
          managerOnly ? api.openBot(id, signal) : openBotConversation(api, id, signal),
        async hasSession(id, parentSessionId) {
          const sessionId = id as SessionId;
          const has = () =>
            parentSessionId
              ? ctx.sessions.subagentAddress(sessionId)?.parentSessionId === parentSessionId
              : ctx.sessions.list.getSnapshot().ids.includes(sessionId);
          if (!has()) await ctx.sessions.refresh();
          if (ctx.sessions.list.getSnapshot().phase !== 'ready')
            throw new Error('暂时无法核对 Worker 会话，请重试。');
          return has();
        },
        showMainPanel() {
          clearWorkHash();
          ctx.layout.selectPanel(panel);
        },
      },
    ),
  };
  api.workFeed = createWorkFeed(api);
  const row = 'sidebar.session.row.trailing';
  ctx.slots.inject(row, () =>
    ctx.slots.register(
      { name: row, id: 'super-bot-work-state' },
      ({ sessionId }: { sessionId: SessionId }) => <SessionBadge api={api} sessionId={sessionId} />,
    ),
  );
  ctx.effect(() => {
    let intent: AbortController | undefined, nativeHash: string | undefined;
    const replaceHash = (hash: string) =>
      history.replaceState(history.state, '', location.pathname + location.search + hash);
    const select = () => {
      const current = new URL(location.href);
      if (
        workLinkForUrl(current, current) &&
        ctx.layout.panelInfo.getSnapshot().activePanelId !== panel
      ) {
        ctx.layout.selectPanel(panel);
      }
    };
    const hashChanged = () => {
      intent?.abort();
      nativeHash = undefined;
      select();
    };
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => {
      intent?.abort();
      if (chatOnly !== ctx.sidebarRight.mounted.getSnapshot()) chatOnly = undefined;
      if (nativeHash && location.hash === nativeHash) replaceHash('');
      nativeHash = undefined;
    });
    const unwatchPanel = ctx.layout.panelInfo.subscribe(() => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== panel)
        api.botNavigation.setMainWork(null);
    });
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link?.href) return;
      const current = new URL(location.href),
        url = new URL(link.href, current);
      const delivery = link.closest('[data-slot="conversation.chat.flow"]')
        ? chatDeliveryLink(url, current)
        : undefined;
      const primary =
        event.type === 'click' &&
        event.button === 0 &&
        !event.defaultPrevented &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey;
      if (delivery) {
        // Cancel native browser/sidebar navigation before any asynchronous ownership lookup.
        event.preventDefault();
        event.stopPropagation();
        if (!primary || delivery === 'blocked') return;
        if (delivery.kind === 'file') {
          const sessionId = ctx.sidebarRight.mounted.getSnapshot();
          if (!sessionId) return;
          intent?.abort();
          const { resultId, index } = delivery;
          ctx.sidebarRight.openTab(WORK_TAB, {
            params: { sessionId, file: { resultId, index, name: link.textContent ?? '' } },
          });
          return;
        }
      } else if (
        event.type === 'click' &&
        sameWorkHost(url, current) &&
        url.pathname === RESULT_FILE_PATH
      ) {
        event.stopPropagation();
        return;
      }
      const work = delivery ?? workLinkForUrl(url, current);
      if (!work || !primary) return;
      event.preventDefault();
      event.stopPropagation();
      intent?.abort();
      intent = new AbortController();
      const { signal } = intent;
      void openWorkLink(api, ctx.sidebarRight, work, signal, !!delivery).then((destination) => {
        if (signal.aborted || !destination) return;
        const hash = workUrl(work).slice(1);
        nativeHash = destination === 'sidebar' ? hash : undefined;
        replaceHash(hash);
        if (destination === 'work') window.dispatchEvent(new Event('hashchange'));
      });
    };
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      if (returningToReloadSettings()) ctx.layout.selectPanel(panel);
      else select();
    });
    const mouseEvents = ['click', 'auxclick', 'contextmenu'] as const;
    for (const name of mouseEvents) document.addEventListener(name, click, true);
    window.addEventListener('hashchange', hashChanged);
    return () => {
      disposed = true;
      intent?.abort();
      unsubscribe();
      unwatchPanel();
      for (const name of mouseEvents) document.removeEventListener(name, click, true);
      window.removeEventListener('hashchange', hashChanged);
    };
  });
  const guide = {
    id: 'work',
    order: 20,
    title: () => '当前 Bot 的工作',
    description: () => '进展、需要你处理的事与成果',
    icon: Icon,
  };
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: WORK_TAB,
      kind: WORK_TAB,
      title: () => '工作',
      guide: [guide],
    }),
  );
  for (const name of [
    'conversation.session.header.actions',
    'conversation.hero.options',
  ] as const) {
    ctx.slots.inject(name, () =>
      ctx.slots.register({ name, id: WORK_TAB, order: 20 }, (props: { sessionId: SessionId }) => (
        <WorkButton
          api={api}
          sessionId={props.sessionId}
          sidebar={ctx.sidebarRight}
          onChatReady={() => {
            hideWork(props.sessionId);
            if (chatOnly === props.sessionId) chatOnly = undefined;
          }}
        />
      )),
    );
    ctx.slots.inject(name, () =>
      ctx.slots.register(
        { name, id: 'super-bot-session-origin', order: 19 },
        (props: { sessionId: SessionId }) => (
          <SessionOriginHint
            api={api}
            sessionId={props.sessionId}
            sidebar={ctx.sidebarRight}
            locale={ctx.get?.('locale')}
          />
        ),
      ),
    );
  }
  type TabProps = { sessionId: SessionId; useTabInfo: UseSidebarRightTabInfo };
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: WORK_TAB }, (props: TabProps) => {
      const { tab } = props.useTabInfo(),
        raw = tab.navigation.params;
      const params = raw?.sessionId === props.sessionId ? raw : undefined;
      const linked =
        params &&
        'href' in params &&
        typeof params.href === 'string' &&
        params.href.startsWith('/#')
          ? parseWorkLink(params.href.slice(1))
          : undefined;
      return tab.visible ? (
        <SessionWork
          api={api}
          sessionId={props.sessionId}
          sidebar={ctx.sidebarRight}
          tabId={tab.id}
          file={params && 'file' in params ? params.file : undefined}
          linkedWork={
            linked && params && 'botId' in params
              ? { link: linked, botId: params.botId, revision: tab.navigation.revision }
              : undefined
          }
        />
      ) : null;
    }),
  );
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'super-bot', inject: () => ({}) }, () => (
      <BotHome api={api} />
    )),
  );
  const tail = 'conversation.chat.turnTail';
  ctx.slots.inject(tail, () =>
    ctx.slots.register(
      { name: tail, id: 'super-bot-delivery-links' },
      (props: ChatDeliverySlot) => (
        <ChatDeliveryLinks {...props} api={api} source={ctx.sidebarRight.mounted} />
      ),
    ),
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'super-bot', order: 11, label: () => 'Super Bot' },
      Icon,
    ),
  );
  ctx.effect(() => installBotSidebar(ctx.slots, api));
}
