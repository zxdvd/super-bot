import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Store } from './store.ts';
import { DshExecution } from './dsh.ts';
import { Managers } from './manager.ts';
import { createLedgerBackup } from './backups.ts';
import { AppError, requiredText, optionalText, type WorkspaceStatus, type NewBot, type NewTask, type ControlMode } from './model.ts';

export const name = 'super-bot';
export const inject = ['connection', 'sessionController', 'workspaceRegistry','agents','tools','jobs','systemPrompt'];
export const Config = Schema.object({ dataDir: Schema.string().description('Super Bot 本地数据目录') });

export function apply(ctx: Context, config: { dataDir?: string } = {}): void {
  const dataDir = resolve(config.dataDir ?? process.env.SUPER_BOT_DATA_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'super-bot'));
  const store = new Store(join(dataDir, 'ledger.sqlite'));
  const execution=new DshExecution(ctx,store,dataDir);
  const managers=new Managers(ctx,store,execution,dataDir);
  ctx.effect(() => async () => {await managers.dispose();await execution.dispose();store.close();});
  execution.install();
  managers.install();
  const require = createRequire(import.meta.url);
  const runtime = require('@deepseek-ai/dsh-agent/package.json').version as string;
  const startedAt = Date.now();
  let creating: Promise<string> | undefined;

  const status = (): WorkspaceStatus => ({ product: 'Super Bot', version: '0.1.0', runtime,
    ...store.sqliteInfo(), startedAt, savedSessionId: store.get('probeSession') });

  async function invoke(endpoint: string, payload: Record<string, unknown>) {
    try {
      if (endpoint === 'status') return { ok: true, value: status() };
      if (endpoint === 'backup.create') return {ok:true,value:await createLedgerBackup(store,dataDir,requiredText(payload.requestId,'请求标识',200))};
      if (endpoint === 'bot.list') return { ok: true, value: store.listBots() };
      if (endpoint === 'manager.prepare') return {ok:true,value:await managers.prepare(requiredText(payload.requestId,'请求标识',200),requiredText(payload.botId,'Bot 标识',200))};
      if (endpoint === 'manager.replace') return {ok:true,value:await managers.replace(requiredText(payload.requestId,'请求标识',200),requiredText(payload.botId,'Bot 标识',200),payload.expectedGeneration as number)};
      if (endpoint === 'manager.status') return {ok:true,value:store.managerInfo(requiredText(payload.botId,'Bot 标识',200))};
      if (endpoint === 'bot.create') return { ok: true, value: store.createBot(requiredText(payload.requestId,'请求标识',200),payload as unknown as NewBot) };
      if (endpoint === 'task.create') return { ok: true, value: store.createTask(requiredText(payload.requestId,'请求标识',200),payload as unknown as NewTask) };
      if (endpoint === 'task.list') return { ok: true, value: store.listTasks({
        botId: requiredText(payload.botId,'Bot 标识',200), q: optionalText(payload.q,'搜索',200),
        lifecycle: optionalText(payload.lifecycle,'状态',30), limit: payload.limit as number | undefined, offset: payload.offset as number | undefined,
      }) };
      if (endpoint === 'task.detail') return { ok: true, value: store.taskDetail(requiredText(payload.id,'任务标识',200)) };
      if (endpoint === 'task.dispatch') return {ok:true,value:await execution.dispatch(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'task.stop') return {ok:true,value:await execution.stop(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'run.recover') return {ok:true,value:await execution.recover(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload.acknowledged)};
      if (endpoint === 'result.accept') return {ok:true,value:await execution.accept(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,requiredText(payload.resultId,'成果标识',200))};
      if (endpoint === 'result.reject') return {ok:true,value:store.rejectResult(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,requiredText(payload.resultId,'成果标识',200),requiredText(payload.text,'返工要求'))};
      if (endpoint === 'attention.respond') return {ok:true,value:store.respondAttention(requiredText(payload.requestId,'请求标识',200),requiredText(payload.attentionId,'待办标识',200),payload.expectedRowVersion as number,requiredText(payload.text,'回答'))};
      if (endpoint === 'session.prepare') return {ok:true,value:await execution.prepareSession(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'session.reconcile') return {ok:true,value:await execution.reconcileBinding(requiredText(payload.id,'会话关联标识',200))};
      if (endpoint === 'task.control') return { ok: true, value: store.controlTask(requiredText(payload.requestId,'请求标识',200),
        requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload.mode as ControlMode) };
      if (endpoint === 'task.revise') return { ok: true, value: store.reviseTask(requiredText(payload.requestId,'请求标识',200),
        requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload as unknown as NewTask) };
      if (endpoint === 'create-probe-session') {
        const cwd = join(dataDir, 'probe-workspace');
        await mkdir(cwd, { recursive: true });
        const workspace = await ctx.workspaceRegistry.create(cwd, 'Super Bot 验证');
        const existing = store.get('probeSession');
        if (existing) {
          await workspace.attachSession(SessionId(existing));
          return { ok: true, value: { sessionId: existing } };
        }
        if (store.get('probeCreating') && !creating) throw new AppError('recovery', '上次创建结果待核对，尚未重新创建。');
        creating ??= (async () => {
          store.set('probeCreating', 'true');
          const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id });
          store.set('probeSession', sessionId);
          return sessionId;
        })().finally(() => { creating = undefined; });
        return { ok: true, value: { sessionId: await creating } };
      }
      throw new AppError('not-found', '未知操作。');
    } catch (error) {
      return { ok: false, error: { code: error instanceof AppError ? error.code : 'internal',
        message: error instanceof AppError ? error.message : '操作未完成，请检查宿主日志并核对状态。', details: {} } };
    }
  }
  // Exact routes are authenticated and owner-only by DSH Connection on every carrier.
  // Do not take its sole shared-RPC interceptor (that belongs to the API Gateway).
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/super-bot', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const envelope = body as { type?: string; rpcId?: string; method?: string; payload?: Record<string,unknown> } | null;
      if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
        || envelope.method !== 'super-bot' || typeof envelope.payload?.action !== 'string') {
        return new Response('Invalid command envelope', { status: 400 });
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId,
        result: await invoke(envelope.payload.action, envelope.payload) });
    },
  }));
}
