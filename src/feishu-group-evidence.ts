import type { FeishuGroupEvidence, FeishuGroupTextMessage } from './feishu-types.ts';
import type { Store } from './store.ts';

export const GROUP_EVIDENCE_KEY_PREFIX = 'feishu-group-evidence:';

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function groupEvidence(store: Store, bindingId: string): FeishuGroupEvidence {
  try {
    const value = JSON.parse(store.get(GROUP_EVIDENCE_KEY_PREFIX + bindingId) ?? 'null');
    return { plainTextAt: timestamp(value?.plainTextAt), botMentionAt: timestamp(value?.botMentionAt) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { plainTextAt: null, botMentionAt: null };
  }
}

/** Record only evidence for the exact accepted receipt, including identity verified after intake. */
export function recordGroupEvidence(store: Store, bindingId: string, kind: FeishuGroupTextMessage['receiptKind'],
  receivedAt: number): void {
  const field = kind === 'plain' ? 'plainTextAt' : kind === 'bot-mention' ? 'botMentionAt' : undefined;
  if (!field) return;
  const evidence = groupEvidence(store, bindingId);
  if ((evidence[field] ?? 0) >= receivedAt) return;
  evidence[field] = receivedAt;
  store.set(GROUP_EVIDENCE_KEY_PREFIX + bindingId, JSON.stringify(evidence));
}
