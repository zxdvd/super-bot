/** Optional browser memory for the last Bot and list view; every access tolerates disabled storage. */
const BOT_KEY = 'super-bot:bot', VIEW_KEY = 'super-bot:view', SEEN_KEY = 'super-bot:seen', SEEN_LIMIT = 300;
export type WorkView = 'inbox' | 'board' | 'list' | 'settings';
export const WORK_VIEWS: readonly WorkView[] = ['inbox', 'board', 'list', 'settings'];
export type SavedView = { botId: string; selected: string; query: string; filter: string; offset: number; view?: WorkView };

export function rememberedBot(): string {
  try { return localStorage.getItem(BOT_KEY) ?? ''; } catch { return ''; }
}
export function rememberBot(id: string): void {
  try { localStorage.setItem(BOT_KEY, id); } catch { /* Browser storage is optional. */ }
}
export function rememberedView(): SavedView | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null') as SavedView | null;
    const filters = ['', 'open', 'review', 'completed', 'cancelled'];
    if (value && typeof value.botId === 'string' && typeof value.selected === 'string' && typeof value.query === 'string'
      && value.query.length <= 200 && filters.includes(value.filter) && Number.isSafeInteger(value.offset) && value.offset >= 0
      && (value.view === undefined || WORK_VIEWS.includes(value.view))) {
      return value;
    }
  } catch { /* Browser storage is optional. */ }
}
export function rememberView(view: SavedView): void {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* Browser storage is optional. */ }
}
export function forgetView(): void {
  try { sessionStorage.removeItem(VIEW_KEY); } catch { /* Optional view memory. */ }
}

/** Which finished results the user has opened, keyed by task ID with the update time seen. */
export function seenResults(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isSafeInteger(at))) as Record<string, number>;
  } catch { return {}; }
}
export function markSeen(entries: readonly (readonly [string, number])[]): Record<string, number> {
  const map = seenResults();
  for (const [id, at] of entries) map[id] = Math.max(map[id] ?? 0, at);
  const kept = Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, SEEN_LIMIT));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(kept)); } catch { /* Browser storage is optional. */ }
  return kept;
}
