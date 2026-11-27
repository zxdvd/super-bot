/** Optional browser storage for the remembered Bot, work views, and result reads. */
const BOT_KEY = 'super-bot:bot',
  VIEW_KEY = 'super-bot:view',
  SEEN_KEY = 'super-bot:seen',
  SEEN_LIMIT = 300;
export type WorkView = 'inbox' | 'board' | 'list' | 'settings';
export const WORK_VIEWS: readonly WorkView[] = ['inbox', 'board', 'list', 'settings'];
export type SavedView = {
  botId: string;
  selected: string;
  query: string;
  filter: string;
  offset: number;
  view?: WorkView;
  href?: string;
  linkSource?: string;
};
const views = new Map<string, SavedView>();
const viewKey = (botId: string, sessionId?: string) => `${VIEW_KEY}:${botId}:${sessionId ?? ''}`;

export function rememberedBot(): string {
  try {
    return localStorage.getItem(BOT_KEY) ?? '';
  } catch {
    return '';
  }
}
export function rememberBot(id: string): void {
  try {
    localStorage.setItem(BOT_KEY, id);
  } catch {
    /* Browser storage is optional. */
  }
}
export function rememberedView(botId: string, sessionId?: string): SavedView | undefined {
  const key = viewKey(botId, sessionId);
  const stored = views.get(key);
  if (stored) return stored;
  try {
    const item =
      sessionStorage.getItem(key) ?? (!sessionId ? sessionStorage.getItem(VIEW_KEY) : null);
    const value = JSON.parse(item ?? 'null') as SavedView | null;
    const filters = ['', 'open', 'review', 'completed', 'cancelled'];
    if (
      value &&
      value.botId === botId &&
      typeof value.selected === 'string' &&
      typeof value.query === 'string' &&
      value.query.length <= 200 &&
      filters.includes(value.filter) &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0 &&
      (value.view === undefined || WORK_VIEWS.includes(value.view)) &&
      (value.href === undefined || typeof value.href === 'string') &&
      (value.linkSource === undefined || typeof value.linkSource === 'string')
    ) {
      return value;
    }
  } catch {
    /* Browser storage is optional. */
  }
}
export function rememberView(view: SavedView, sessionId?: string): void {
  const key = viewKey(view.botId, sessionId);
  views.set(key, view);
  try {
    sessionStorage.setItem(key, JSON.stringify(view));
  } catch {
    /* Browser storage is optional. */
  }
}
export function forgetView(botId: string): void {
  const prefix = viewKey(botId);
  for (const key of views.keys()) if (key.startsWith(prefix)) views.delete(key);
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    if (JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null')?.botId === botId)
      sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* Optional view memory. */
  }
}

/** Which original-chat deliveries the user has opened, keyed by task ID and receipt time. */
export function seenResults(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => Number.isSafeInteger(at)),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}
export function markSeen(entries: readonly (readonly [string, number])[]): Record<string, number> {
  const map = seenResults();
  for (const [id, at] of entries) map[id] = Math.max(map[id] ?? 0, at);
  const kept = Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_LIMIT),
  );
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(kept));
  } catch {
    /* Browser storage is optional. */
  }
  return kept;
}
