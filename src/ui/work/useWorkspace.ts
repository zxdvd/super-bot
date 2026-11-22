/** All Workspace state, the polling loop and guarded mutations. Views receive the returned object read-only. */
import { useEffect, useRef, useState } from 'react';
import type { Bot, TaskPage, WorkspaceStatus } from '../../model.ts';
import { ownerLabel, type MirrorDetail, type MirrorSelection } from '../../mirror.ts';
import type { BackupInfo } from '../../backups.ts';
import type { WorkLink } from '../../work-links.ts';
import type { WorkspaceApi } from './api.ts';
import type { Detail, FormKind, ManagerInfo } from './types.ts';
import {
  forgetView, markSeen, rememberBot, rememberedBot, rememberedView, rememberView, seenResults, type WorkView,
} from './storage.ts';

export interface WorkspaceProps {
  api: WorkspaceApi; initialBotId?: string; initialLink?: WorkLink; sessionId?: string; compact?: boolean; onReturn?: () => void;
  mirror?: MirrorSelection;
}
export const PAGE_SIZE = 25;
export type Page = TaskPage & { truncated?: boolean };
const ACTIVE = ['queued', 'running', 'stopping', 'approval'];

async function existing<T>(query: Promise<T>): Promise<T | undefined> {
  try { return await query; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'not-found') return; throw error; }
}

export function useWorkspace({ api, initialBotId, initialLink, sessionId, mirror }: WorkspaceProps) {
  const preferredBot = useRef(initialBotId ?? rememberedBot());
  const savedView = useRef(sessionId || mirror ? undefined : rememberedView());
  const restoredView = useRef(!initialLink && savedView.current?.botId === initialBotId ? savedView.current : undefined);
  const pendingSelection = useRef(restoredView.current?.selected ?? '');
  const alive = useRef(true), viewScope = useRef(''), scroller = useRef<HTMLDivElement>(null);
  const backupNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [managerInfo, setManagerInfo] = useState<ManagerInfo>();
  const [backupInfo, setBackupInfo] = useState<BackupInfo>();
  const [sidebarNotice, setSidebarNotice] = useState<{ botId: string; text: string }>();
  const [status, setStatus] = useState<WorkspaceStatus>(); const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState(mirror?.bot.id ?? initialBotId ?? ''); const [page, setPage] = useState<Page>();
  const [view, setViewState] = useState<WorkView>(mirror ? 'list' : restoredView.current?.view ?? 'inbox');
  const [seen, setSeen] = useState(() => mirror ? {} : seenResults()); const [now, setNow] = useState(Date.now);
  const [selected, setSelected] = useState(initialLink?.taskId ?? ''); const [loaded, setDetail] = useState<Detail>();
  const [remoteDetail, setRemoteDetail] = useState<MirrorDetail>();
  const mirrorDetail = remoteDetail?.task.id === selected && remoteDetail.task.botId === botId ? remoteDetail : undefined;
  const [link, setLink] = useState(initialLink), [missingLink, setMissingLink] = useState(false);
  const detail = loaded?.task.id === selected && loaded.task.botId === botId ? loaded : undefined;
  const [query, setQuery] = useState(restoredView.current?.query ?? '');
  const [filter, setFilter] = useState(restoredView.current?.filter ?? '');
  const [offset, setOffset] = useState(restoredView.current?.offset ?? 0);
  const [online, setOnline] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false), mutating = useRef(false); const [form, setForm] = useState<FormKind>(null);
  const [refresh, setRefresh] = useState(0); const [synced, setSynced] = useState(0);
  useEffect(() => { if (backupInfo) backupNotice.current?.scrollIntoView({ block: 'nearest' }); }, [backupInfo]);
  viewScope.current = `${botId}:${selected}`;
  useEffect(() => {
    if (botId && !sessionId && !mirror) {
      rememberView({ botId, selected, query, filter, offset, view: view === 'settings' ? 'inbox' : view });
    }
  }, [botId, selected, query, filter, offset, sessionId, view, mirror]);
  const showingCurrentResult = !link || link.kind === 'task' || link.kind === 'result' && link.resultId === detail?.result?.id;
  const openedResult = showingCurrentResult ? detail?.task : undefined;
  useEffect(() => {
    if (openedResult?.deliveredAt !== undefined) setSeen(markSeen([[openedResult.id, openedResult.deliveredAt]]));
  }, [openedResult?.id, openedResult?.deliveredAt]);
  const closeEdit = () => setForm(current => current === 'edit' ? null : current);
  const deselect = () => {
    setSelected(''); setDetail(undefined); setRemoteDetail(undefined); setLink(undefined); setMissingLink(false);
  };

  useEffect(() => {
    if (!mirror) return;
    const { owner, bot } = mirror;
    const controller = new AbortController(), signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    async function pull() {
      if (document.visibilityState !== 'hidden') {
        try {
          const scope = { owner, botId: bot.id };
          const [next, detail] = await Promise.all([
            api.call<TaskPage>('mirror.tasks', { ...scope, q: query.trim(), lifecycle: filter, offset, limit: PAGE_SIZE }, signal),
            selected ? existing(api.call<MirrorDetail>('mirror.detail', { ...scope, id: selected }, signal)) : undefined,
          ]);
          if (signal.aborted) return;
          setPage(next); setRemoteDetail(detail); setOnline(true); setSynced(Date.now()); setNow(Date.now()); setConnectionError('');
          setMissingLink(!!selected && !detail);
          if (offset > 0 && offset >= next.total) setOffset(Math.max(0, Math.floor((next.total - 1) / PAGE_SIZE) * PAGE_SIZE));
        } catch (cause) {
          if (signal.aborted) return;
          const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
          const source = ownerLabel[owner];
          setConnectionError(code === 'mirror-offline' ? `${source} 离线，暂时无法读取。`
            : code === 'not-found' ? `${source} 已找不到此 Bot。`
              : code === 'mirror-unverified' && cause instanceof Error ? `${source} 镜像暂停 · ${cause.message}`
                : `暂时无法核对 ${source} 的配对或读取结果。`);
          setPage(undefined); setRemoteDetail(undefined); setOnline(false); setSynced(0); setMissingLink(false);
        }
        setLoading(false);
      }
      if (!signal.aborted) timer = setTimeout(pull, 5000);
    }
    void pull();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, mirror, selected, query, filter, offset, refresh]);

  useEffect(() => {
    if (mirror) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const signal = controller.signal;
    const current = () => !signal.aborted && (!sessionId || api.currentSession?.() === sessionId);
    const unsubscribe = sessionId && api.watchCurrentSession?.(() => {
      controller.abort(); clearTimeout(timer);
      if (api.currentSession?.() === sessionId) setRefresh(n => n + 1);
    });
    function switchToAvailableBot(list: Bot[]) {
      const id = sessionId ? '' : list[0]?.id ?? '';
      pendingSelection.current = ''; savedView.current = undefined; preferredBot.current = id; setBotId(id);
      if (!sessionId) rememberBot(id);
      setPage(undefined); deselect(); setManagerInfo(undefined); setOffset(0); setFilter(''); setQuery(''); setForm(null);
      if (!id && !sessionId) forgetView();
    }
    function adoptFirstBot(list: Bot[]) {
      const id = list.some(bot => bot.id === preferredBot.current) ? preferredBot.current : list[0]!.id;
      setBotId(id); rememberBot(id);
      const view = savedView.current;
      if (!initialLink && view?.botId === id) {
        setQuery(view.query); setFilter(view.filter); setOffset(view.offset); pendingSelection.current = view.selected;
      }
      savedView.current = undefined;
    }
    const listQuery = { botId, q: query, lifecycle: filter, offset, limit: PAGE_SIZE };
    const detailQuery = { id: selected, ...(sessionId ? { sessionId } : {}),
      ...(link?.kind === 'result' ? { resultId: link.resultId } : {}) };
    async function pull() {
      if (!current()) return;
      let cadence = 5000;
      if (document.visibilityState === 'hidden') { timer = setTimeout(pull, 5000); return; }
      try {
        const [s, b, p, d, m] = await Promise.all([
          api.call<WorkspaceStatus>('status', {}, signal), api.call<Bot[]>('bot.list', {}, signal),
          botId ? existing(view === 'list' ? api.call<TaskPage>('task.list', listQuery, signal)
            : api.call<Page>('task.inbox', { botId }, signal)) : undefined,
          selected ? existing(api.call<Detail>('task.detail', detailQuery, signal)) : undefined,
          botId ? existing(api.call<ManagerInfo>('manager.status', { botId }, signal)) : undefined,
        ]);
        if (!current()) return;
        setStatus(s); setBots(b); setPage(p); setManagerInfo(m); setConnectionError('');
        if (p && pendingSelection.current) {
          if (p.items.some(t => t.id === pendingSelection.current)) setSelected(pendingSelection.current);
          pendingSelection.current = '';
        }
        if ((d && ACTIVE.includes(d.task.status)) || p?.items.some(t => ACTIVE.includes(t.status))) cadence = 1000;
        const filtered = view === 'list' && p && !link && !p.items.some(t => t.id === selected);
        const gone = !d || d.task.id !== selected || d.task.botId !== botId || filtered;
        if (selected && gone && !link) { deselect(); closeEdit(); }
        else { setDetail(gone ? undefined : d); setMissingLink(!!link && !!gone); }
        setOnline(true); setLoading(false); setSynced(Date.now()); setNow(Date.now()); failures = 0;
        if (view === 'list' && p && offset > 0 && offset >= p.total) {
          setOffset(Math.max(0, Math.floor((p.total - 1) / PAGE_SIZE) * PAGE_SIZE)); deselect(); closeEdit();
        }
        if (botId && !b.some(bot => bot.id === botId)) switchToAvailableBot(b);
        if (!sessionId && !botId && b.length) adoptFirstBot(b);
      } catch {
        if (!current()) return;
        setOnline(false); setLoading(false); setConnectionError('暂时无法读取宿主状态，将自动重试。'); failures++;
      }
      timer = setTimeout(pull, Math.min(30000, cadence * 2 ** failures));
    }
    pull(); return () => { controller.abort(); clearTimeout(timer); if (unsubscribe) unsubscribe(); };
  }, [api, botId, selected, query, filter, offset, refresh, view, link, sessionId, mirror]);

  async function mutate<T>(action: string, payload: Record<string, unknown>, done?: (value: T) => void): Promise<boolean> {
    if (mirror || !online || mutating.current || sessionId && api.currentSession?.() !== sessionId) return false;
    const navigation = api.beginNavigation(), scope = viewScope.current;
    const leaving = new AbortController();
    const unsubscribe = sessionId && api.watchCurrentSession?.(() => leaving.abort());
    const current = () => alive.current && !navigation.aborted && !leaving.signal.aborted && viewScope.current === scope
      && (!sessionId || api.currentSession?.() === sessionId);
    mutating.current = true; setBusy(true); setError('');
    try {
      if (sessionId) {
        const owner = await api.call<Bot | null>('bot.for-session', { sessionId }); if (!current()) return false;
        if (owner?.id !== botId) throw new Error('当前对话归属已改变，请重新打开 Bot 的工作视图。');
      }
      const scoped = sessionId && ['task.dispatch', 'attention.respond', 'result.accept', 'result.reject',
        'run.recover', 'run.recover-and-continue'].includes(action);
      const result = await api.call<T>(action, scoped ? { ...payload, sessionId } : payload);
      if (!current()) return false;
      done?.(result); setRefresh(n => n + 1); return true;
    } catch (e) {
      if (current()) { setError(e instanceof Error ? e.message : '操作未完成，请核对后重试。'); setRefresh(n => n + 1); }
      return false;
    } finally {
      if (unsubscribe) unsubscribe();
      mutating.current = false; if (alive.current) setBusy(false);
    }
  }
  function pickBot(id: string) {
    preferredBot.current = id; rememberBot(id); setBotId(id); setManagerInfo(undefined); setPage(undefined);
    deselect(); setOffset(0); setFilter(''); setQuery(''); setForm(null);
  }
  /** Opens one task; list and filter changes use resetView instead. */
  const select = (id: string) => { deselect(); setSelected(id); setForm(null); setError(''); };
  const resetView = (next: { filter?: string; query?: string; offset?: number }) => {
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.query !== undefined) setQuery(next.query);
    setOffset(next.offset ?? 0); deselect();
  };
  /** Switching views keeps the open task; leaving for settings closes it. */
  const setView = (next: WorkView) => {
    setViewState(next); if (next === 'settings') deselect();
    setForm(current => current === 'bot' || current === 'bot-edit' ? current : null);
    if (next === 'list') setOffset(0);
  };
  const markAllSeen = (tasks: readonly { id: string; deliveredAt?: number }[]) =>
    setSeen(markSeen(tasks.flatMap(t => t.deliveredAt === undefined ? [] : [[t.id, t.deliveredAt] as const])));
  const bot = bots.find(b => b.id === botId);
  return {
    api, sessionId, scroller, backupNotice, bot, bots, botId, status, page, selected, detail, link, missingLink, query, filter, offset,
    mirror, mirrorDetail,
    managerInfo, backupInfo, setBackupInfo, sidebarNotice, setSidebarNotice, online, loading, error, setError,
    connectionError, setConnectionError, busy, locked: !online || busy, form, setForm, setRefresh, synced,
    mutate, pickBot, select, deselect, resetView, setOffset, setQuery, setFilter, setSelected, setManagerInfo,
    view, setView, seen, markAllSeen, now,
  };
}
export type WorkspaceState = ReturnType<typeof useWorkspace>;
