import { Lexer, walkTokens } from 'marked';
import { parseWorkLink } from './work-links.ts';

function markdownLinks(text: string): string[] {
  const links: string[] = [];
  let rawHtml = false;
  walkTokens(Lexer.lex(text, { gfm: false }), token => {
    if (token.type === 'html') rawHtml = true;
    if (token.type === 'link' && 'href' in token && token.text.trim()) links.push(token.href);
  });
  return rawHtml ? [] : links;
}

/** Native Chat renders each text block as its own Markdown document. */
export function hasDeliveryLinks(blocks: string[], origin: string, resultId: string, taskId: string,
  fileCount: number, allowLegacyTaskLink: boolean): boolean {
  if (!URL.canParse(origin) || !blocks.some(text => text.includes(resultId)) || !blocks.some(text => text.includes(taskId))) return false;
  const expectedOrigin = new URL(origin).origin;
  const files = new Set<number>();
  let exact = false, legacyTask = false, otherVersion = false;
  for (const link of blocks.flatMap(markdownLinks)) {
    if (!/^https?:\/\//i.test(link)) continue;
    const href = link.replaceAll('&amp;', '&');
    if (!URL.canParse(href)) continue;
    const url = new URL(href);
    if (url.origin !== expectedOrigin || url.username || url.password) continue;
    if (url.pathname === '/api/super-bot-file' && url.searchParams.getAll('resultId').length === 1
      && url.searchParams.get('resultId') === resultId && url.searchParams.getAll('index').length === 1) {
      const index = url.searchParams.get('index')!;
      if (/^(0|[1-9][0-9]*)$/.test(index)) files.add(Number(index));
    }
    if (url.pathname !== '/') continue;
    const hash = new URLSearchParams(url.hash.slice(1));
    if (!hash.getAll('super-bot-task').includes(taskId)) continue;
    const work = parseWorkLink(url.hash);
    if (url.searchParams.has('resultId') || url.searchParams.has('attentionId')) otherVersion = true;
    else if (work?.kind === 'result' && work.resultId === resultId) exact = true;
    else if (hash.has('resultId')) otherVersion = true;
    else if (work?.kind === 'task') legacyTask = true;
  }
  if (!exact && !(allowLegacyTaskLink && legacyTask && !otherVersion && fileCount > 0)) return false;
  for (let index = 0; index < fileCount; index++) if (!files.has(index)) return false;
  return true;
}
