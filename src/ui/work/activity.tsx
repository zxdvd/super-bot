import { useSyncExternalStore } from 'react';
import type { BotWorkSummary } from '../../model.ts';
import type { WorkspaceApi } from './api.ts';

type Snapshot = { bots?: BotWorkSummary[]; failed?: boolean };
export function createWorkFeed(api: WorkspaceApi) {
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = {}, controller: AbortController | undefined, followUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function refresh() {
    clearTimeout(timer);
    if (!listeners.size || document.visibilityState === 'hidden') return;
    if (controller) { followUp = true; return; }
    const request = new AbortController();
    controller = request;
    void api.call<BotWorkSummary[]>('bot.work', {}, request.signal).then(bots => {
      if (!request.signal.aborted) snapshot = { bots };
    }, () => {
      if (!request.signal.aborted) snapshot = { bots: snapshot.bots, failed: true };
    }).finally(() => {
      if (request.signal.aborted) return;
      controller = undefined;
      for (const listen of listeners) listen();
      if (followUp) { followUp = false; refresh(); }
      else if (listeners.size) timer = setTimeout(refresh, 5000);
    });
  }
  return {
    refresh, getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('focus', refresh);
        controller?.abort(); controller = undefined; followUp = false; clearTimeout(timer); snapshot = {};
      };
    },
  };
}

const empty: Snapshot = {};
const noFeed = { subscribe: () => () => {}, getSnapshot: () => empty };
export function useWorkFeed(api: WorkspaceApi) {
  const feed = api.workFeed ?? noFeed;
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}
export function activityLabel(bot?: BotWorkSummary) {
  return bot?.attention ? '等你处理' : bot?.working ? '进行中' : '';
}
export function WorkBadge({ label, compact = false }: { label: string; compact?: boolean }) {
  if (!label) return null;
  const attention = label === '等你处理';
  return <span title={label} aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, gap: 4,
    fontSize: '0.83em', fontWeight: 550, whiteSpace: 'nowrap', borderRadius: 12, padding: compact ? '0 2px' : '1px 6px',
    color: attention ? 'var(--dsw-alias-text-warning, light-dark(#895300, #ffcb79))'
      : 'light-dark(#146963, #79d2c8)',
    background: compact ? undefined : 'color-mix(in srgb, currentColor 10%, transparent)' }}>
    <span aria-hidden="true">{attention ? '!' : '◷'}</span>{!compact && label}
  </span>;
}

export function SessionBadge({ api, sessionId }: { api: WorkspaceApi; sessionId: string }) {
  const feed = useWorkFeed(api);
  return <WorkBadge label={activityLabel(!feed.failed ? feed.bots?.find(bot => bot.sessionId === sessionId) : undefined)} compact/>;
}
