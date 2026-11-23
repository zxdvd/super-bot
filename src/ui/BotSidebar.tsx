import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SidebarSectionOwnerProps, SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { Bot } from '../model.ts';
import type { WorkspaceApi } from './work/api.ts';

const styles = `
.sb-sidebar-bots{min-height:0;overflow:auto;padding:2px 4px;}
.sb-sidebar-button{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;
  border:0;border-radius:var(--dsw-radius-md,6px);background:transparent;color:inherit;font:inherit;
  text-align:left;cursor:pointer;}
.sb-sidebar-button:hover,.sb-sidebar-button:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}
.sb-sidebar-button:disabled{cursor:wait;opacity:.6;}
.sb-sidebar-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sb-sidebar-rail .sb-sidebar-button,.sb-sidebar-button.sb-sidebar-rail{justify-content:center;padding:4px;}
.sb-sidebar-mode{font-size:13px;}
.sb-sidebar-message{margin:4px 8px;font-size:12px;overflow-wrap:anywhere;}
.sb-sidebar-rail .sb-sidebar-message{margin:4px 0;}
`;

function BotList({ api, wide, lifetime }: { api: WorkspaceApi; wide: boolean; lifetime: AbortSignal }) {
  const [bots, setBots] = useState<Pick<Bot, 'id' | 'name'>[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<{ id: string; navigation: AbortSignal }>();
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime]);
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (signal.aborted) return;
      if (document.visibilityState !== 'hidden') {
        try {
          const list = await api.call<Bot[]>('bot.list', {}, signal);
          if (!signal.aborted) { setBots(list); setLoadFailed(false); }
        } catch {
          if (!signal.aborted) setLoadFailed(true);
        }
      }
      if (!signal.aborted) timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, lifetime]);

  async function open(id: string) {
    if (lifetime.aborted) return;
    const navigation = AbortSignal.any([api.beginNavigation(), lifetime]);
    setError(''); setOpening({ id, navigation });
    try { await api.openBot(id, navigation); }
    catch (error) {
      if (!navigation.aborted) setError(error instanceof Error ? error.message : '暂时无法打开对话，请重试。');
    } finally {
      if (!lifetime.aborted) setOpening(current => current?.navigation === navigation ? undefined : current);
    }
  }

  const status = loadFailed ? '暂时无法读取 Bot' : !bots ? '正在读取 Bot…' : !bots.length ? '暂无 Bot' : '';
  return <nav aria-label="Bot" className={wide ? 'sb-sidebar-bots' : 'sb-sidebar-bots sb-sidebar-rail'}>
    {bots?.map(bot => <button key={bot.id} type="button" className="sb-sidebar-button" aria-label={bot.name} title={bot.name}
      disabled={opening?.id === bot.id} onClick={() => void open(bot.id)}>
      <span className="sb-sidebar-label">{wide ? bot.name : Array.from(bot.name)[0]}</span>
    </button>)}
    {status && (wide || loadFailed) && <p className="sb-sidebar-message" role="status" title={status}
      aria-label={status}>{wide ? status : '!'}</p>}
    {error && <p className="sb-sidebar-message" role="alert" title={error} aria-label={error}>{wide ? error : '!'}</p>}
  </nav>;
}

type SidebarMode = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
  toggle: () => void;
};

function ModeButton({ wide, mode }: SidebarFooterActionOwnerProps & { mode: SidebarMode }) {
  const botMode = useSyncExternalStore(mode.subscribe, mode.getSnapshot);
  const label = botMode ? '切换到 Workspace' : '切换到 Bot';
  return <><style>{styles}</style><button type="button"
    className={`sb-sidebar-button sb-sidebar-mode${wide ? '' : ' sb-sidebar-rail'}`}
    aria-label={label} title={label} onClick={mode.toggle}>
    <span aria-hidden="true">↔</span>{wide && <span>{label}</span>}
  </button></>;
}

export function installBotSidebar(slots: Context['slots'], api: WorkspaceApi): () => void {
  const showBots = () => {
    const lifetime = new AbortController();
    const release = slots.inject('sidebar.workspaces', () => slots.register(
      { name: 'sidebar.workspaces', priority: -10 }, ({ wide }: SidebarSectionOwnerProps) =>
        <BotList api={api} wide={wide} lifetime={lifetime.signal}/>));
    return () => { lifetime.abort(); release(); };
  };
  const listeners = new Set<() => void>();
  let releaseBots: (() => void) | undefined = showBots();
  const mode: SidebarMode = {
    getSnapshot: () => releaseBots !== undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    toggle() {
      if (releaseBots) { releaseBots(); releaseBots = undefined; }
      else releaseBots = showBots();
      for (const listener of listeners) listener();
    },
  };
  const releaseToggle = slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'super-bot-sidebar-mode', order: 20 },
    ({ wide }: SidebarFooterActionOwnerProps) => <ModeButton wide={wide} mode={mode}/>));
  return () => { releaseToggle(); releaseBots?.(); };
}
