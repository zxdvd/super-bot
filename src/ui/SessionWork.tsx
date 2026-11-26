import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import type { Bot } from '../model.ts';
import type { SessionOrigin } from '../mirror.ts';
import { resultFileUrl, type WorkLink } from '../work-links.ts';
import { Workspace, type WorkspaceApi } from './Workspace.tsx';
import {
  watchSessionBot,
  toggleSessionWork,
  watchSessionOrigin,
  type FileTarget,
} from './work-navigation.ts';
import { activityLabel, useWorkFeed, WorkBadges } from './work/activity.tsx';
import { ResultFilePreview } from './work/ResultFilePreview.tsx';

type Resolved = { sessionId: string; bot: Bot | null; error?: string };
const buttonStyle = {
  cursor: 'pointer',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l3, #87908d50)',
  borderRadius: 7,
  padding: '5px 10px',
  font: 'inherit',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
} as const;

function useSessionBot(api: WorkspaceApi, sessionId: string, sidebar: ISidebarRight) {
  const current = useSyncExternalStore(
    (listener) => sidebar.mounted.subscribe(listener),
    () => sidebar.mounted.getSnapshot(),
  );
  const [resolved, setResolved] = useState<Resolved>();
  useEffect(
    () =>
      watchSessionBot(api, sessionId, sidebar.mounted, (value) =>
        setResolved(value ? { sessionId, ...value } : undefined),
      ),
    [api, sessionId, sidebar],
  );
  // Even retained slots cannot show the departing conversation's data in a new one.
  return current === sessionId && resolved?.sessionId === sessionId ? resolved : undefined;
}

export function WorkButton({
  api,
  sessionId,
  sidebar,
}: {
  api: WorkspaceApi;
  sessionId: string;
  sidebar: ISidebarRight;
}) {
  const resolved = useSessionBot(api, sessionId, sidebar);
  const feed = useWorkFeed(api);
  if (!resolved?.bot) return null;
  const counts = feed.failed
    ? undefined
    : feed.bots?.find((row) => row.sessionId === sessionId && row.id === resolved.bot?.id);
  const label = activityLabel(counts);
  return (
    <button
      type="button"
      title={[resolved.bot.name, '打开或收起工作视图', label].filter(Boolean).join(' · ')}
      aria-label={['打开或收起当前 Bot 的工作', label].filter(Boolean).join(' · ')}
      onClick={() => toggleSessionWork(sessionId, sidebar)}
      style={buttonStyle}
    >
      工作
      <WorkBadges counts={counts} />
    </button>
  );
}

type HintLocale = Pick<LocaleRuntime, 'subscribe' | 'getSnapshot' | 'resolveText'>;

export function SessionOriginHint({
  api,
  sessionId,
  sidebar,
  locale,
}: {
  api: WorkspaceApi;
  sessionId: string;
  sidebar: ISidebarRight;
  locale?: HintLocale;
}) {
  const current = useSyncExternalStore(
    (listener) => sidebar.mounted.subscribe(listener),
    () => sidebar.mounted.getSnapshot(),
  );
  useSyncExternalStore(
    (listener) => locale?.subscribe(listener) ?? (() => {}),
    () => locale?.getSnapshot(),
  );
  const [resolved, setResolved] = useState<{ sessionId: string; origin: SessionOrigin }>();
  useEffect(
    () =>
      watchSessionOrigin(api, sessionId, sidebar.mounted, (origin) =>
        setResolved(origin && { sessionId, origin }),
      ),
    [api, sessionId, sidebar],
  );
  if (current !== sessionId || resolved?.sessionId !== sessionId) return null;
  const { owner, local } = resolved.origin,
    label = owner === 'web' ? 'Web' : 'Desktop';
  const text = local
    ? { zh: `${label} 创建`, en: `Created on ${label}` }
    : {
        zh: `${label} 创建 · 请在 ${label} 继续`,
        en: `Created on ${label} · Continue on ${label}`,
      };
  return (
    <span
      title={locale?.resolveText(text) ?? text.zh}
      style={{ fontSize: '0.85em', whiteSpace: 'nowrap' }}
    >
      {locale?.resolveText(text) ?? text.zh}
    </span>
  );
}

export function SessionWork({
  api,
  sessionId,
  sidebar,
  tabId,
  linkedWork,
  file,
}: {
  api: WorkspaceApi;
  sessionId: string;
  sidebar: ISidebarRight;
  tabId: TabId;
  linkedWork?: { link: WorkLink; botId: string; revision: number };
  file?: FileTarget;
}) {
  const resolved = useSessionBot(api, sessionId, sidebar);
  const back = () => {
    if (sidebar.mounted.getSnapshot() === sessionId) sidebar.hide(tabId);
  };
  if (!resolved?.bot) {
    const text =
      resolved?.error ??
      (resolved
        ? '此会话不是当前有效的 Bot 对话，不展示其他 Bot 的任务。请从 Super Bot 打开当前对话。'
        : '正在核对当前对话…');
    return (
      <div style={{ padding: 20, overflowWrap: 'anywhere' }}>
        <button onClick={back}>← 返回聊天</button>
        <p role={resolved?.error ? 'alert' : 'status'}>{text}</p>
      </div>
    );
  }
  const target = linkedWork?.botId === resolved.bot.id ? linkedWork : undefined;
  if (linkedWork && !target)
    return (
      <div style={{ padding: 20 }}>
        <button onClick={back}>← 返回聊天</button>
        <p role="alert">当前对话的归属已改变，请重新打开链接。</p>
      </div>
    );
  if (file) {
    const href = resultFileUrl(file.resultId, file.index, sessionId);
    return (
      <section aria-label="成果文件预览" style={{ padding: 20, overflowWrap: 'anywhere' }}>
        <button onClick={back}>← 返回聊天</button>
        <h3>{file.name || '成果文件'}</h3>
        <ResultFilePreview key={href} href={href} showDownload />
      </section>
    );
  }
  return (
    <Workspace
      key={`${sessionId}:${resolved.bot.id}:${target?.revision ?? ''}`}
      api={api}
      initialBotId={resolved.bot.id}
      sessionId={sessionId}
      initialLink={target?.link}
      compact
      onReturn={back}
      onBotDeleted={
        api.openHome &&
        (() => {
          back();
          api.openHome?.();
        })
      }
    />
  );
}
