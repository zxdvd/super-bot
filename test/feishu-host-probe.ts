import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { apply as applyProduct } from '../src/index.ts';
import type { FeishuConnectionState, FeishuTextMessage } from '../src/feishu-types.ts';
import { handlers, sent, setFailure, starts } from './feishu-host-transport.ts';

export { Config, inject, name } from '../src/index.ts';

export async function apply(ctx: Context, config: Parameters<typeof applyProduct>[1]) {
  assert.match(process.env.DSH_HOME ?? '', /\/feishu-smoke-[^/]+\/super-bot\/\.runtime\/dsh$/);
  await applyProduct(ctx, config);
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/super-bot-feishu-probe', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
      try {
        const body = await request.json() as { action: string; connection?: FeishuConnectionState; message?: FeishuTextMessage;
          sessionId?: string; fail?: boolean };
        if (body.action === 'connection') handlers?.onConnection(body.connection!);
        if (body.action === 'receive') await handlers?.onMessage(body.message!);
        if (body.action === 'fail-send') setFailure(body.fail === true);
        if (body.action === 'events') {
          assert.ok(body.sessionId);
          const address = { kind: 'session', sessionId: SessionId(body.sessionId) } as const;
          const page = await ctx.sessionController.events({ address, maxMessages: 200 }, request.signal);
          return Response.json({ ok: true, page });
        }
        return Response.json({ ok: true, starts, sent });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Fixture failed' });
      }
    },
  }));
}
