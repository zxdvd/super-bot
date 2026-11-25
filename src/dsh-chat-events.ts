import type {} from '@deepseek-ai/dsh-api-session-controller';
import { lastAssistantStreamChunk, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export function isFeishuSource(source: UserMessage['source']): source is MessageSourceMap['super-bot-feishu'] {
  return source.kind === 'user' && 'feishuMessageId' in source;
}

export function isNativeOwner(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === 'user' && !isFeishuSource(source) && 'rpcId' in source &&
    typeof source.rpcId === 'string' && source.rpcId.length > 0 &&
    Object.keys(source).every(key => key === 'kind' || key === 'rpcId' || key === 'clientTimeZone') &&
    (!('clientTimeZone' in source) || typeof source.clientTimeZone === 'string');
}

export function isHostContext(message: UserMessage): boolean {
  const kind: string = message.source.kind;
  return kind === 'runtime-context' || kind === 'agent-instructions' || kind === 'time-context' || kind === 'skill-catalog';
}

export function messageText(message: Pick<UserMessage, 'content'>): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export function finalAssistantText(event: SessionEvent<'assistant/message'>): string | undefined {
  const { message, stream, interrupted } = event.data;
  if (event.surfaceOp !== 'append' || interrupted || message.source.kind !== 'model' ||
      lastAssistantStreamChunk(stream, 'finish')?.reason.kind !== 'stop' ||
      message.content.some(block => block.type === 'tool-call')) return;
  const text = messageText(message);
  if (text.trim()) return text;
}
