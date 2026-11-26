import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionStore } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { AppError, type Run } from '../model.ts';

export async function readRunEvents(ctx: Context, run: Run, session?: Session) {
  if (session && !(await (ctx.sessions as unknown as SessionStore).flush(session)))
    throw new AppError('run-proof', '宿主未确认轮次持久保存，保留占用。');
  const handle = await ctx.sessionPersistence.open(SessionId(run.sessionId), 'read');
  try {
    if (handle.header.id !== run.sessionId) throw new AppError('run-proof', '持久会话身份不符。');
    return (await handle.read()).events;
  } finally {
    await handle.close();
  }
}
