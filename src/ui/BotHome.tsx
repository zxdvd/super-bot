import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Bot, TaskPage } from '../model.ts';
import { ownerLabel, type MirrorCatalog, type MirrorSelection } from '../mirror.ts';
import { Workspace, type WorkspaceApi } from './Workspace.tsx';
import { styles } from './styles.ts';
import { readTaskLink, workLinkForUrl } from './work-navigation.ts';
import { workUrl, type WorkLink } from '../work-links.ts';
import { inboxGroups } from './work/format.ts';
import { FeishuSettings } from './FeishuSettings.tsx';

const DEFAULT_INSTRUCTIONS = '你是我的长期助手。自然地与我交流，理解我的目标，必要时澄清，主动安排已授权的工作，并回来交付结果。';
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

type Work = { botId: string; link?: WorkLink; revision?: number; mirror?: MirrorSelection };

function WorkFrame({ api, work, error, setError, close }: {
  api: WorkspaceApi; work: Work; error: string; setError: (text: string) => void; close: () => void;
}) {
  const clearHash = () => history.replaceState(history.state, '', location.pathname + location.search);
  const leave = () => { api.beginNavigation(); clearHash(); close(); };
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div className="sb" style={{ height: 'auto', flexShrink: 0, padding: 12 }}><style>{styles}</style>
      <button onClick={leave}>← 我的 Bot</button>{' '}
      {!work.mirror && <button onClick={() => {
        clearHash(); void api.openBot(work.botId).catch(e => setError(e.message));
      }}>返回这个 Bot 聊天 →</button>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <Workspace api={api} key={work.link ? `${workUrl(work.link)}:${work.revision}` : `${work.mirror?.owner ?? 'local'}:${work.botId}`}
        initialBotId={work.botId} initialLink={work.link} mirror={work.mirror}/>
    </div>
  </div>;
}

/** One read per Bot on the home list: how many tasks need the user, wait for review, or are running. */
function BotCounts({ api, botId }: { api: WorkspaceApi; botId: string }) {
  const [counts, setCounts] = useState<{ needs: number; review: number; running: number }>();
  useEffect(() => {
    const controller = new AbortController();
    api.call<TaskPage>('task.inbox', { botId }, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      const groups = inboxGroups(page.items, {}, Date.now());
      setCounts({ needs: groups.attentionCount, review: groups.review.length, running: groups.active.length });
    }).catch(() => { /* Counts are a hint; the work view reports errors. */ });
    return () => controller.abort();
  }, [api, botId]);
  if (!counts) return null;
  return <span className="bot-counts">
    {counts.needs > 0 && <span className="badge attention">需要你 {counts.needs}</span>}
    {counts.review > 0 && <span className="badge info">待验收 {counts.review}</span>}
    {counts.running > 0 && <span className="badge success">进行中 {counts.running}</span>}
  </span>;
}

/** Native DSH owns the conversation, composer, model choice and history. */
export function BotHome({ api }: { api: WorkspaceApi }) {
  const [bots, setBots] = useState<Bot[]>([]), [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<MirrorCatalog>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [work, setWork] = useState<Work | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const settingsEntry = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [instructions, setInstructions] = useState('');
  const request = useRef(crypto.randomUUID()), alive = useRef(true), locked = useRef(false);
  useEffect(() => {
    alive.current = true; const controller = new AbortController(), live = () => !controller.signal.aborted;
    api.call<Bot[]>('bot.list', {}, controller.signal).then(value => { if (live()) setBots(value); })
      .catch(e => { if (live()) setError(e.message); }).finally(() => { if (live()) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [api, work === null]);
  const atHome = work === null;
  useEffect(() => {
    if (!atHome) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.visibilityState !== 'hidden') {
        try {
          const next = await api.call<MirrorCatalog>('mirror.catalog', {}, signal);
          if (!signal.aborted) setCatalog(next);
        } catch {
          if (!signal.aborted) setCatalog(current => current && { ...current, state: 'unverified', reason: undefined, bots: [] });
        }
      }
      if (!signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, atHome]);
  useEffect(() => {
    let controller: AbortController | undefined, revision = 0;
    const navigate = () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const current = new URL(location.href), link = workLinkForUrl(current, current); if (!link) return;
      const navigation = api.beginNavigation(), opening = ++revision;
      setWork(null); setShowSettings(false); setError('');
      readTaskLink(api, link.taskId, signal, navigation).then(task => {
        if (task && !signal.aborted && !navigation.aborted) setWork({ botId: task.botId, link, revision: opening });
      })
        .catch(e => { if (!signal.aborted && !navigation.aborted) setError(e.message); });
    };
    navigate(); window.addEventListener('hashchange', navigate);
    return () => { controller?.abort(); window.removeEventListener('hashchange', navigate); };
  }, [api]);
  async function chat(bot: Bot) {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { await api.openBot(bot.id); } catch (e) { if (alive.current) setError(message(e, '暂时无法打开对话，请重试。')); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault(); if (locked.current || !name.trim()) return; locked.current = true; setBusy(true); setError('');
    const navigation = api.beginNavigation();
    try {
      const bot = await api.call<Bot>('bot.create', {
        requestId: request.current, name: name.trim(), instructions: instructions.trim() || DEFAULT_INSTRUCTIONS,
      });
      // Keep the saved Bot visible even if opening its conversation fails.
      if (alive.current) {
        setBots(current => [...current.filter(item => item.id !== bot.id), bot]); setCreating(false); setName(''); setInstructions('');
        request.current = crypto.randomUUID();
      }
      await api.openBot(bot.id, navigation);
    } catch (e) { if (alive.current) setError(message(e, '暂时无法创建，请重试。')); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  if (work !== null) return <WorkFrame api={api} work={work} error={error} setError={setError} close={() => setWork(null)}/>;
  if (showSettings) return <FeishuSettings api={api} close={() => {
    setShowSettings(false);
    requestAnimationFrame(() => settingsEntry.current?.focus());
  }}/>;
  return <div className="sb"><style>{styles}</style><main className="sb-wrap" style={{ maxWidth: 820 }}>
    <header className="sb-header">
      <div><div className="eyebrow">Super Bot</div><h1>你想一起做点什么？</h1>
        <p className="muted">和 Bot 聊聊，把事情交给它，完成后它会回来告诉你。</p></div>
      <div className="header-actions">
        {bots.length > 0 && <button disabled={busy} onClick={() => setCreating(true)}>新建 Bot</button>}
        <button ref={settingsEntry} disabled={busy} onClick={() => setShowSettings(true)}>设置</button>
      </div>
    </header>
    {error && <p role="alert" className="notice error">{error}</p>}
    {loading ? <p className="muted">正在读取你的 Bot…</p> : <>
      {bots.map(bot => <article key={bot.id} className="bot-row">
        <button disabled={busy} className="bot-open" onClick={() => void chat(bot)}>
          <span className="bot-name"><strong>{bot.name}</strong><BotCounts api={api} botId={bot.id}/></span>
          {catalog && <div className="muted wrap">{ownerLabel[catalog.owner]} 创建 · {bot.id}</div>}
          <div className="muted">继续聊天 →</div>
        </button>
        <button disabled={busy} onClick={() => { api.beginNavigation(); setWork({ botId: bot.id }); }}>工作</button>
      </article>)}
      {catalog && catalog.state !== 'disabled' && <section aria-label={`${ownerLabel[catalog.peer]} 的 Bot`}>
        {catalog.state === 'offline' && <p role="status">{ownerLabel[catalog.peer]} 离线，暂时无法读取该端的 Bot。</p>}
        {catalog.state === 'unverified' && <p role="status">
          {ownerLabel[catalog.peer]} 镜像暂停 · {catalog.reason ?? '暂时无法核对连接。'}
        </p>}
        {catalog.state === 'online' && catalog.bots.length === 0 && <p className="muted">{ownerLabel[catalog.peer]} 暂无 Bot。</p>}
        {catalog.bots.map(bot => <article key={`${catalog.peer}:${bot.id}`} className="bot-row">
          <button disabled={busy} className="bot-open" onClick={() => {
            api.beginNavigation(); setWork({ botId: bot.id, mirror: { owner: catalog.peer, bot } });
          }}>
            <span className="bot-name"><strong>{bot.name}</strong></span>
            <div className="muted wrap">{ownerLabel[catalog.peer]} 创建 · 只读 · {bot.id}</div>
            <div className="muted">查看工作 →</div>
          </button>
        </article>)}
      </section>}
      {(creating || bots.length === 0) && <form className="form" onSubmit={create} style={{ marginTop: 28 }}>
        <h2>{bots.length ? '新建 Bot' : '创建你的第一个 Bot'}</h2>
        <label htmlFor="sb-home-name">给它起个名字</label>
        <input id="sb-home-name" autoFocus required maxLength={80} disabled={busy} value={name} placeholder="例如：小帮手"
          onChange={e => { setName(e.target.value); request.current = crypto.randomUUID(); }}/>
        <label htmlFor="sb-home-role">希望它怎么帮你？（可选）</label>
        <textarea id="sb-home-role" maxLength={10000} disabled={busy} value={instructions} placeholder="也可以在聊天时慢慢告诉它"
          onChange={e => { setInstructions(e.target.value); request.current = crypto.randomUUID(); }}/>
        <div className="actions">
          <button className="primary" disabled={busy || !name.trim()}>{busy ? '正在打开…' : '创建并聊天'}</button>
          {bots.length > 0 && <button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>}
        </div>
      </form>}
      {busy && <p role="status" className="muted">正在打开对话…</p>}
    </>}
  </main></div>;
}
