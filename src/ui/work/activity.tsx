import { useSyncExternalStore, type CSSProperties } from 'react';
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
type WorkCounts = Pick<BotWorkSummary, 'working' | 'attention' | 'review'>;
const statuses = [
  { key: 'working', label: '进行中', color: 'light-dark(#146359, #88d9ca)',
    icon: 'M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM8 5v3l2 1' },
  { key: 'attention', label: '需处理', color: 'light-dark(#864905, #ffd092)',
    icon: 'M8 2.5 14 13H2L8 2.5ZM8 6.3v2.8m0 1.6v.2' },
  { key: 'review', label: '待验收', color: 'light-dark(#535f70, #b7c2d1)',
    icon: 'M5.5 3H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.5M6 2h4v3H6zM5.5 9l1.6 1.6L10.5 7' },
] as const;

function entries(counts?: WorkCounts, includeReview = false) {
  return counts ? statuses.flatMap(status => {
    if (status.key === 'review' && !includeReview) return [];
    const count = counts[status.key];
    return count > 0 ? [{ ...status, count }] : [];
  }) : [];
}

const countLabel = ({ label, count }: { label: string; count: number }) => `${label} ${count}`;
const countsLabel = (badges: ReturnType<typeof entries>) => badges.map(countLabel).join(' · ');

export function activityLabel(counts?: WorkCounts) { return countsLabel(entries(counts)); }

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 5, flexShrink: 0, whiteSpace: 'nowrap',
  fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3,
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
};

export function WorkBadges({ counts, showLabels = false, primaryOnly = false, includeReview = false }: {
  counts?: WorkCounts; showLabels?: boolean; primaryOnly?: boolean; includeReview?: boolean;
}) {
  const badges = entries(counts, includeReview), label = countsLabel(badges);
  if (!label) return null;
  return <span className="sb-work-counts" role="img" title={label} aria-label={label}
    style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
    {(primaryOnly ? badges.slice(0, 1) : badges).map(status => <span key={status.key} data-status={status.key}
      className="sb-work-count" aria-hidden="true" title={!primaryOnly && badges.length > 1 ? countLabel(status) : undefined}
      style={{ ...chipStyle, color: status.color, padding: showLabels ? '2px 5px' : '1px 3px' }}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={status.icon}/></svg>
      <span>{showLabels ? countLabel(status) : status.count}</span>
    </span>)}
  </span>;
}

export function SessionBadge({ api, sessionId }: { api: WorkspaceApi; sessionId: string }) {
  const feed = useWorkFeed(api);
  return <WorkBadges counts={!feed.failed ? feed.bots?.find(bot => bot.sessionId === sessionId) : undefined}/>;
}
