/** Optional browser memory for the last Bot and list view; every access tolerates disabled storage. */
const BOT_KEY = 'super-bot:bot', VIEW_KEY = 'super-bot:view';
export type SavedView = { botId: string; selected: string; query: string; filter: string; offset: number };

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
      && value.query.length <= 200 && filters.includes(value.filter) && Number.isSafeInteger(value.offset) && value.offset >= 0) {
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
