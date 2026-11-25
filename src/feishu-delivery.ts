import { Lexer, walkTokens } from 'marked';
import { deliveryArtifactUrl } from './delivery-artifacts.ts';
import { parseWorkLink, RESULT_FILE_PATH, workUrl } from './work-links.ts';

type Delivered = { taskId: string; resultId: string; links: Record<string, string> };

function loopback(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
    || host === '[::1]' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:/.test(host);
}

/** The forwarded text is backed by this exact native reply's durable delivery receipt. */
export function feishuDeliveryText(text: string, deliveries: readonly Delivered[], webOrigin: string,
  fits: (text: string) => boolean): string {
  if (!deliveries.length) return text;
  const origin = deliveryArtifactUrl(webOrigin) ? new URL(webOrigin) : undefined;
  const byResult = new Map(deliveries.map(item => [item.resultId, item]));
  const tasks = new Set(deliveries.map(item => item.taskId));
  const managedLinks = new Set<string>(), visibleUrls = new Set<string>();
  walkTokens(Lexer.lex(text), token => {
    if (token.type !== 'link') return;
    const href = deliveryArtifactUrl(token.href.replaceAll('&amp;', '&'));
    if (!href) return;
    const url = new URL(href);
    if (url.origin === origin?.origin) {
      const work = url.pathname === '/' && !url.search ? parseWorkLink(url.hash) : undefined;
      const ownResult = work?.kind === 'result' && byResult.get(work.resultId)?.taskId === work.taskId;
      const ownTask = work?.kind === 'task' && tasks.has(work.taskId);
      const ownFile = url.pathname === RESULT_FILE_PATH && byResult.has(url.searchParams.get('resultId') ?? '');
      if (ownResult || ownTask || ownFile) {
        managedLinks.add(token.raw);
        return;
      }
    }
    visibleUrls.add(url.href);
  });
  let prose = text;
  for (const link of managedLinks) {
    const escaped = link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const standalone = new RegExp(`^[ \\t]*(?:[-*+] |\\d+[.)] )?${escaped}[ \\t]*(?:\\r?\\n|$)`, 'gm');
    prose = prose.replace(standalone, '').replaceAll(link, '');
  }
  const local = !origin || loopback(origin);
  const resultLinks = origin ? deliveries.map(({ taskId, resultId }) => {
    const url = new URL(workUrl({ kind: 'result', taskId, resultId }), origin);
    const label = local ? '在运行 Bot 的电脑上查看完整交付' : '查看完整交付';
    return `${label}：${url.href}`;
  }) : ['完整成果请在原 Bot 对话中查看。'];

  const shortcuts: string[] = [];
  for (const [name, candidate] of deliveries.flatMap(({ links }) => Object.entries(links))) {
    const href = deliveryArtifactUrl(candidate);
    if (!href) continue;
    const url = new URL(href);
    if (loopback(url) || url.pathname === RESULT_FILE_PATH || parseWorkLink(url.hash) || visibleUrls.has(url.href)) continue;
    shortcuts.push(`${name.replace(/\s+/g, ' ').trim()}：${href}`);
    visibleUrls.add(url.href);
  }
  const format = (lines: string[]) => [prose.trim(), [...resultLinks, ...lines].join('\n')].filter(Boolean).join('\n\n');
  const whole = format([]);
  if (!fits(whole)) return text;
  const direct: string[] = [];
  if (local || shortcuts.length <= 2) {
    for (const shortcut of shortcuts) {
      if (fits(format([...direct, shortcut]))) direct.push(shortcut);
      if (direct.length === 2) break;
    }
  }
  const remaining = shortcuts.length - direct.length;
  if (remaining) {
    const withCount = format([...direct, `另有 ${remaining} 项交付物见完整成果。`]);
    if (fits(withCount)) return withCount;
  }
  return format(direct);
}
