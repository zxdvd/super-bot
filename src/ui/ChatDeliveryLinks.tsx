import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Lexer, walkTokens } from 'marked';
import type { ChatSnapshot, ToolCallBlock, ToolChatData, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { ConversationSnapshot, UseConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { deliveryArtifactUrl } from '../delivery-artifacts.ts';
import { managedSessionId } from '../mirror.ts';
import type { WorkspaceApi } from './Workspace.tsx';
import type { SessionSource } from './work-navigation.ts';

type Delivery = { resultId: string; links: Record<string, string> };
const visibleLinks = 3;
const linkStyle = { color: 'var(--dsw-alias-link, #328375)', textDecoration: 'underline', overflowWrap: 'anywhere' } as const;
const listStyle = { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } as const;

export function DeliveryItems({ links, replyLinks }: { links: Delivery['links']; replyLinks: ReadonlySet<string> }) {
  const seen = new Set(replyLinks);
  const items = Object.entries(links).flatMap(([label, candidate]) => {
    if (!deliveryArtifactUrl(candidate)) return [];
    const url = new URL(candidate).href;
    if (seen.has(url)) return [];
    seen.add(url);
    return <a key={label} href={candidate} target="_blank" rel="noopener noreferrer" style={linkStyle}>{label}</a>;
  });
  if (!items.length) return null;
  return <div role="group" aria-label="交付物" style={{ fontSize: '0.875em', marginBlock: 4 }}>
    {items.length <= visibleLinks ? <div style={listStyle}>{items}</div> : <details>
      <summary style={{ cursor: 'pointer' }}>交付物（{items.length}）</summary>
      <div style={listStyle}>{items}</div>
    </details>}
  </div>;
}

type DeliveryTarget = { sessionId: string; turn: number; endSeq: number };

function correctionSequence(call: ToolCallBlock, deliveries?: Delivery[]): number {
  if ('kind' in call && call.name === 'super_bot_manage' && !call.isError && call.call) {
    try {
      const args = JSON.parse(call.call.argsRaw) as { action?: string; resultId?: string } | null;
      if (args?.action === 'update_delivery_links' && deliveries?.some(result => result.resultId === args.resultId)) {
        return call.seq;
      }
    } catch { /* Malformed native arguments do not invalidate any delivery. */ }
  }
  return call.subCalls.reduce((seq, child) => Math.max(seq, correctionSequence(child, deliveries)), -1);
}

/** The active Turn can revise links only through a settled tool call for the matching result. */
export function deliveryCorrection(chat: ChatSnapshot | undefined, deliveries?: Delivery[]): number {
  const latest = chat?.timeline.turnOrder.at(-1);
  if (latest === undefined || !deliveries?.length) return -1;
  const tools: readonly ToolChatData[] = chat?.nodes.turnDataSource(latest, 'tool-call').getSnapshot() ?? [];
  return tools.reduce((seq, { root }) => Math.max(seq, correctionSequence(root, deliveries)), -1);
}

function DeliveryLinks({ target, api, source, useConversation, replyBlocks }: {
  target: DeliveryTarget; api: WorkspaceApi; source: SessionSource; useConversation: UseConversation; replyBlocks: string[];
}) {
  const { sessionId, turn, endSeq } = target;
  const current = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot());
  const [deliveries, setDeliveries] = useState<Delivery[]>();
  const lastCorrection = useRef(-1);
  const correction = useConversation((snapshot: ConversationSnapshot) => deliveryCorrection(snapshot.views.get('chat'), deliveries));
  const revision = Math.max(lastCorrection.current, correction);
  useEffect(() => {
    if (current !== sessionId) return;
    lastCorrection.current = revision;
    const request = new AbortController();
    void api.call<{ deliveries: Delivery[] }>('chat.delivery', { sessionId, turn, endSeq }, request.signal).then(value => {
      if (!request.signal.aborted && source.getSnapshot() === sessionId) setDeliveries(value.deliveries);
    }).catch(() => { if (!request.signal.aborted) setDeliveries(undefined); });
    return () => request.abort();
  }, [api, source, current, sessionId, turn, endSeq, revision]);
  if (current !== sessionId || !deliveries?.length) return null;
  const alreadyInReply = new Set<string>();
  for (const block of replyBlocks) {
    walkTokens(Lexer.lex(block), token => {
      if (token.type !== 'link') return;
      const href = deliveryArtifactUrl(token.href.replaceAll('&amp;', '&'));
      if (href) alreadyInReply.add(new URL(href).href);
    });
  }
  return <>{deliveries.map(({ resultId, links }) => <DeliveryItems key={resultId} links={links} replyLinks={alreadyInReply}/>)}</>;
}

export type ChatDeliverySlot = TurnTailOwnerProps & { sessionId: string; useConversation: UseConversation };

export function ChatDeliveryLinks({ api, source, sessionId, turn, useConversation }: ChatDeliverySlot & {
  api: WorkspaceApi; source: SessionSource;
}) {
  if (!managedSessionId.test(sessionId) || turn.end?.data.reason.kind !== 'completed') return null;
  const final = turn.data.get('turn-tail')?.closing?.finalNode;
  const replyBlocks = final?.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []) ?? [];
  // Authority comes from the receipt. The native text only avoids requests for unrelated turns.
  if (!final?.messageId || !replyBlocks.some(text => text.includes('super-bot-task=') && text.includes('resultId='))) return null;
  const target = { sessionId, turn: turn.turn, endSeq: turn.end.seq };
  return <DeliveryLinks key={`${sessionId}:${target.turn}:${target.endSeq}`}
    {...{ api, source, target, useConversation, replyBlocks }}/>;
}
