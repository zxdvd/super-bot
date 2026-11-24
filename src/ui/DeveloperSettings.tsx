import { useEffect, useRef, useState } from 'react';
import type { DeveloperView } from '../developer-reload.ts';
import type { WorkspaceApi } from './Workspace.tsx';

declare const __SUPER_BOT_RELOAD_BUILD__: string;
const clientBuild = typeof __SUPER_BOT_RELOAD_BUILD__ === 'string' ? __SUPER_BOT_RELOAD_BUILD__ : '';
export const reloadSettingsKey = 'super-bot.developer-reload';

export function returningToReloadSettings(): boolean {
  return !!clientBuild && sessionStorage.getItem(reloadSettingsKey) === clientBuild;
}

function status(view: DeveloperView): string | undefined {
  const op = view.operation;
  if (!op) return;
  if (op.state === 'running') return '正在检查活动、构建并重载本端插件…';
  if (op.state === 'failed') return `重载失败：${op.message}`;
  if (op.state === 'unconfirmed') return `重载结果待核对：${op.message}`;
  if (op.build !== view.build) return '本端已切换到其他构建。';
  if (op.build !== clientBuild) return '后端已更新，等待此窗口载入新版。';
  return `已重载本端 Super Bot · ${op.build.slice(0, 8)}`;
}

export function DeveloperSettings({ api }: { api: WorkspaceApi }) {
  const [view, setView] = useState<DeveloperView>();
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const serial = useRef(0), changing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const before = serial.current;
      try {
        const next = await api.call<DeveloperView>('developer.get', {}, controller.signal);
        if (!controller.signal.aborted && before === serial.current && !changing.current) { setView(next); setOffline(false); }
      } catch {
        if (!controller.signal.aborted && before === serial.current && !changing.current) {
          setOffline(true);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); serial.current++; };
  }, [api]);

  useEffect(() => {
    if (view?.operation?.state === 'applied' && view.build === clientBuild && returningToReloadSettings()) {
      sessionStorage.removeItem(reloadSettingsKey);
    }
  }, [view]);

  async function change(action: 'developer.save' | 'developer.reload') {
    if (!view || changing.current) return;
    changing.current = true;
    const revision = ++serial.current;
    setError(''); setPending(true);
    try {
      const fields = action === 'developer.save' ? { enabled: !view.enabled }
        : { requestId: crypto.randomUUID(), previousId: view.operation?.id ?? null };
      if ('requestId' in fields && fields.requestId) sessionStorage.setItem(reloadSettingsKey, fields.requestId);
      const next = await api.call<DeveloperView>(action, fields);
      if (serial.current === revision) setView(next);
    } catch (cause) {
      if (serial.current === revision) setError(cause instanceof Error ? cause.message : '操作未完成，请检查宿主。');
    } finally {
      changing.current = false;
      if (serial.current === revision) setPending(false);
    }
  }
  const locked = pending || view?.operation?.state === 'running';
  return <section><h2>开发者模式</h2>
    <label><input type="checkbox" checked={view?.enabled ?? false} disabled={!view || locked}
      onChange={() => void change('developer.save')}/>启用本端插件开发</label>
    {view?.enabled && <div><button type="button" disabled={locked || !!view.unavailable}
      onClick={() => void change('developer.reload')}>重载本端 Super Bot（{view.profile}）</button>
      {view.unavailable && <p>{view.unavailable}</p>}
      <p role="status">{status(view)}</p></div>}
    {offline && <p role="status">正在重新连接本端宿主…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
