/** All Workspace state, the polling loop and guarded mutations. Views receive the returned object read-only. */
import { useEffect, useRef, useState } from 'react';
import type { Bot, TaskPage, WorkspaceStatus } from '../../model.ts';
import type { BackupInfo } from '../../backups.ts';
import type { WorkspaceApi } from './api.ts';
import type { Detail, FormKind, ManagerInfo } from './types.ts';
import { forgetView, rememberBot, rememberedBot, rememberedView, rememberView } from './storage.ts';

export interface WorkspaceProps {
  api: WorkspaceApi; initialBotId?: string; initialTaskId?: string; sessionId?: string; compact?: boolean; onReturn?: () => void;
}
export const PAGE_SIZE = 25;
const ACTIVE = ['queued', 'running', 'stopping', 'approval'];

async function existing<T>(query: Promise<T>): Promise<T | undefined> {
  try { return await query; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'not-found') return; throw error; }
}

export function useWorkspace({ api, initialBotId, initialTaskId, sessionId, compact }: WorkspaceProps) {
  const preferredBot = useRef(initialBotId ?? rememberedBot());
  const savedView = useRef(sessionId ? undefined : rememberedView());
  const restoredView = useRef(!initialTaskId && savedView.current?.botId === initialBotId ? savedView.current : undefined);
  const pendingSelection = useRef(restoredView.current?.selected ?? '');
  const alive = useRef(true), viewScope = useRef(''), scroller = useRef<HTMLDivElement>(null);
  const backupNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [managerInfo, setManagerInfo] = useState<ManagerInfo>();
  const [backupInfo, setBackupInfo] = useState<BackupInfo>();
  const [sidebarNotice, setSidebarNotice] = useState<{ botId: string; text: string }>();
  const [status, setStatus] = useState<WorkspaceStatus>(); const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState(initialBotId ?? ''); const [page, setPage] = useState<TaskPage>();
  const [selected, setSelected] = useState(initialTaskId ?? ''); const [detail, setDetail] = useState<Detail>();
  const [query, setQuery] = useState(restoredView.current?.query ?? '');
  const [filter, setFilter] = useState(restoredView.current?.filter ?? '');
  const [offset, setOffset] = useState(restoredView.current?.offset ?? 0);
  const [online, setOnline] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false); const [form, setForm] = useState<FormKind>(null);
  const [refresh, setRefresh] = useState(0); const [synced, setSynced] = useState(0);
  useEffect(() => { if (backupInfo) backupNotice.current?.scrollIntoView({ block: 'nearest' }); }, [backupInfo]);
  useEffect(() => { if (compact) scroller.current?.scrollTo({ top: 0 }); }, [compact, selected]);
  viewScope.current = `${botId}:${selected}`;
  useEffect(() => {
    if (botId && !sessionId) rememberView({ botId, selected, query, filter, offset });
  }, [botId, selected, query, filter, offset, sessionId]);
  const closeEdit = () => setForm(current => current === 'edit' ? null : current);
  const deselect = () => { setSelected(''); setDetail(undefined); };

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const signal = controller.signal;
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
      if (!initialTaskId && view?.botId === id) {
        setQuery(view.query); setFilter(view.filter); setOffset(view.offset); pendingSelection.current = view.selected;
      }
      savedView.current = undefined;
    }
    async function pull() {
      let cadence = 5000;
      if (document.visibilityState === 'hidden') { timer = setTimeout(pull, 5000); return; }
      try {
        const [s, b, p, d, m] = await Promise.all([
          api.call<WorkspaceStatus>('status', {}, signal), api.call<Bot[]>('bot.list', {}, signal),
          botId ? existing(api.call<TaskPage>('task.list', { botId, q: query, lifecycle: filter, offset, limit: PAGE_SIZE }, signal))
            : undefined,
          selected ? existing(api.call<Detail>('task.detail', { id: selected }, signal)) : undefined,
          botId ? existing(api.call<ManagerInfo>('manager.status', { botId }, signal)) : undefined,
        ]);
        if (signal.aborted) return;
        setStatus(s); setBots(b); setPage(p); setManagerInfo(m); setConnectionError('');
        if (p && pendingSelection.current) {
          if (p.items.some(t => t.id === pendingSelection.current)) setSelected(pendingSelection.current);
          pendingSelection.current = '';
        }
        if (p?.items.some(t => ACTIVE.includes(t.status))) cadence = 1000;
        const gone = !d || d.task.botId !== botId || (p && selected !== initialTaskId && !p.items.some(t => t.id === selected));
        if (selected && gone) { deselect(); closeEdit(); } else setDetail(d);
        setOnline(true); setLoading(false); setSynced(Date.now()); failures = 0;
        if (p && offset > 0 && offset >= p.total) {
          setOffset(Math.max(0, Math.floor((p.total - 1) / PAGE_SIZE) * PAGE_SIZE)); deselect(); closeEdit();
        }
        if (botId && !b.some(bot => bot.id === botId)) switchToAvailableBot(b);
        if (!sessionId && !botId && b.length) adoptFirstBot(b);
      } catch {
        if (signal.aborted) return;
        setOnline(false); setLoading(false); setConnectionError('暂时无法读取宿主状态，将自动重试。'); failures++;
      }
      timer = setTimeout(pull, Math.min(30000, cadence * 2 ** failures));
    }
    pull(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, botId, selected, query, filter, offset, refresh]);

  async function mutate<T>(action: string, payload: Record<string, unknown>, done?: (value: T) => void): Promise<boolean> {
    if (!online || busy || sessionId && api.currentSession?.() !== sessionId) return false;
    const navigation = api.beginNavigation(), scope = viewScope.current;
    const current = () => alive.current && !navigation.aborted && viewScope.current === scope
      && (!sessionId || api.currentSession?.() === sessionId);
    setBusy(true); setError('');
    try {
      if (sessionId) {
        const owner = await api.call<Bot | null>('bot.for-session', { sessionId }); if (!current()) return false;
        if (owner?.id !== botId) throw new Error('当前对话归属已改变，请重新打开 Bot 的工作视图。');
      }
      const result = await api.call<T>(action, payload); if (!current()) return false;
      done?.(result); setRefresh(n => n + 1); return true;
    } catch (e) {
      if (current()) { setError(e instanceof Error ? e.message : '操作未完成，请核对后重试。'); setRefresh(n => n + 1); }
      return false;
    } finally { if (alive.current) setBusy(false); }
  }
  function pickBot(id: string) {
    preferredBot.current = id; rememberBot(id); setBotId(id); setManagerInfo(undefined); setPage(undefined);
    deselect(); setOffset(0); setFilter(''); setQuery(''); setForm(null);
  }
  /** Opens one task; list and filter changes use resetView instead. */
  const select = (id: string) => { setSelected(id); setDetail(undefined); setForm(null); };
  const resetView = (next: { filter?: string; query?: string; offset?: number }) => {
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.query !== undefined) setQuery(next.query);
    setOffset(next.offset ?? 0); deselect();
  };
  const bot = bots.find(b => b.id === botId);
  return {
    api, sessionId, scroller, backupNotice, bot, bots, botId, status, page, selected, detail, query, filter, offset,
    managerInfo, backupInfo, setBackupInfo, sidebarNotice, setSidebarNotice, online, loading, error, setError,
    connectionError, setConnectionError, busy, locked: !online || busy, form, setForm, setRefresh, synced,
    mutate, pickBot, select, deselect, resetView, setOffset, setQuery, setFilter, setSelected, setManagerInfo,
  };
}
export type WorkspaceState = ReturnType<typeof useWorkspace>;
