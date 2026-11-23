import type {} from '@deepseek-ai/dsh-api-session-controller';
import { lastAssistantStreamChunk, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export function isFeishuSource(source: UserMessage['source']): source is MessageSourceMap['super-bot-feishu'] {
  return source.kind === 'user' && 'feishuMessageId' in source;
}

export function isNativeOwner(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === 'user' && !isFeishuSource(source) && 'rpcId' in source && !!source.rpcId && source.principal === undefined;
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
