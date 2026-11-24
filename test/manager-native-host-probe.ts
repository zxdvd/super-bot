// Runs only in the isolated native Manager smoke. All model and Feishu traffic is synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-user-approval/types';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { handlers, fixtureCredentials, existingGroup } from './feishu-host-transport.ts';

export const name = 'super-bot-trusted-probe';
export const inject = ['agents', 'llm', 'sessionController', 'connection', 'tools', 'systemPrompt', 'workingDirectory', 'typertGateway', 'remoteAccess'];
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'synthetic-share': { readonly kind: 'synthetic-share' };
  }
}
const provider = 'synthetic-trusted-native';
type Trial = 'trusted' | 'context' | 'continuation' | 'mixed' | 'cancel' | 'automatic' | 'share' | 'unknown'
  | 'host-denial' | 'host-approval' | 'no-wait' | 'feishu' | 'feishu-detach' | 'review' | 'delivery' | 'files-counter';
type Trace = {
  phase: string;
  turn?: number;
  step?: number;
  sources?: string[];
  matchedClaim?: boolean;
  claimedObject?: boolean;
  shared?: boolean;
  feishu?: boolean;
  sameSignal?: boolean;
  sameToolSet?: boolean;
  extraToolOffered?: boolean;
  approvalOutcome?: string;
  resultError?: boolean;
  aborted?: boolean;
};
const marker = '本机隔离原生工具探针';
const added = 'manager_probe_count';

export function apply(ctx: Context) {
  const home = process.env.DSH_HOME;
  assert.match(home ?? '', /\/super-bot-native-proof-[^/]+\/super-bot\/\.runtime\/dsh$/);
  let agent: Agent | undefined, worker: Agent | undefined, trial: Trial | undefined, trace: Trace[] = [];
  let workerProof: { owner: boolean; report: boolean; manager: boolean; count: number } | undefined;
  let review: { taskId: string; expectedRowVersion: number; resultId: string } | undefined;
  let epoch = 0, target = added, signal: AbortSignal | undefined, tools: unknown;
  const claims = new Map<string, object>();
  let releasePendingTool: (() => void) | undefined;
  let removeScopedCounter: (() => void) | undefined;
  let lastCall: ToolCallId | undefined;
  let entered = false, body = 0;
  const push = (row: Trace) => trace.push(row);
  const flags = (exec: { agent?: Agent; signal: AbortSignal; toolSet?: unknown }) => ({
    sameSignal: exec.signal === signal, sameToolSet: !!tools && exec.toolSet === tools,
  });
  const source = (message: { source?: { kind: string } }) => message.source?.kind ?? 'none';
  const isTrigger = (message: GenerateOptions['messages'][number]) => trial === 'delivery'
    ? message.source?.kind === 'super-bot-manager' && message.source.eventId.startsWith('manager-event:delivery:')
    : trial === 'automatic' ? source(message) === 'super-bot-manager'
      : message.content.some(block => block.type === 'text' && block.text === marker);

  function* invoke(name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    const id = ToolCallId(randomUUID()), encoded = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: encoded };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: encoded } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }

  class Adapter extends LlmAdapter {
    async listModels() { return [{ provider, id: 'count', name: '隔离计数器' }]; }
    async resolveModel(p: string, m: string) { return { provider: p, id: m, name: m, context: { contextWindow: 32000 }, defaultMaxTokens: 600 }; }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      options.signal?.throwIfAborted();
      if (worker && options.sessionId === worker.id) {
        const inbound = options.messages.findLastIndex(message => message.role === 'user' && source(message) === 'super-bot');
        if (inbound >= 0) {
          const offered = (options.tools ?? []).map(({ name }) => name);
          workerProof ??= { owner: false, report: offered.includes('super_bot_report'), manager: offered.includes('super_bot_manage'), count: 0 };
          const attempted = options.messages.slice(inbound + 1).flatMap(message =>
            message.content.flatMap(block => block.type === 'tool-call' ? [block.name] : []));
          const cwd = ctx.workingDirectory.get(worker.session);
          const file = join(cwd, 'synthetic-result.md');
          assert.ok(cwd.startsWith(join(home!, 'super-bot') + '/'));
          if (!attempted.includes(added) && offered.includes(added)) { yield* invoke(added, {}); return; }
          if (!attempted.includes('write')) { yield* invoke('write', { file_path: file, content: '合成任务证据\n' }); return; }
          if (!attempted.includes('super_bot_report')) {
            yield* invoke('super_bot_report', { kind: 'ready', summary: '合成证据', checks: '已写入隔离目录。', files: [file] });
            return;
          }
        }
      }
      if (options.sessionId === agent?.id && trial && !entered && options.messages.some(message =>
        message.role === 'user' && isTrigger(message))) {
        entered = true;
        if (trial === 'review') {
          assert.ok(review);
          yield* invoke('super_bot_manage', { action: 'review', ...review, verdict: 'human', note: '请对照合成成果。' });
          return;
        }
        const offered = options.tools?.some(tool => tool.name === target);
        push({ phase: offered ? 'model-offered' : 'model-hidden', extraToolOffered: options.tools?.some(tool => tool.name === added) ?? false });
        if (offered) {
          const args = target === 'bash' ? trial === 'no-wait'
            ? { command: 'synthetic-counter' } : { command: 'synthetic-counter', timeoutMs: 1000 }
            : target === 'super_bot_manage' ? { action: 'list' } : {};
          yield* invoke(target, args);
          return;
        }
      }
      const text = '隔离计数流程结束';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([provider], new Adapter()));
  const definition = {
    description: 'Pure synthetic counter. Never executes commands or accesses external services.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, additionalProperties: false } as const,
    output: { schema: { type: 'string' } as const, render: () => [{ type: 'text' as const, text: 'Counted' }] },
    async execute(_args: unknown, exec: { agent?: Agent; signal: AbortSignal; toolSet?: unknown; concludeTurn(): void }) {
      if (exec.agent === worker && workerProof) {
        workerProof.owner = ctx.agents.get(worker!.id) === worker;
        workerProof.count++;
        return 'Counted';
      }
      assert.equal(exec.agent, agent);
      ++body;
      push({ phase: 'body', aborted: exec.signal.aborted, ...flags(exec) });
      if (trial === 'continuation' && body === 1) entered = false;
      else exec.concludeTurn();
      return 'Counted';
    },
  };
  ctx.effect(() => ctx.tools.register({ name: added, ...definition }));
  ctx.on('session/event', (session, event) => {
    if (!trial || session !== agent?.session) return;
    if (event.type === 'user/message') {
      const origin = event.data.source;
      push({ phase: 'committed', sources: [source(event.data)], matchedClaim: claims.has(event.data.id), claimedObject: claims.get(event.data.id) === event.data, shared: 'principal' in origin, feishu: 'feishuMessageId' in origin });
    }
    if (event.type === 'turn/start' || event.type === 'turn/end') push({ phase: event.type, turn: event.data.turn });
    if (event.type === 'approval/asked') push({ phase: 'approval/asked' });
    if (event.type === 'approval/decided') push({ phase: 'approval/decided', approvalOutcome: event.data.outcome });
    if (event.type === 'step/start' || event.type === 'step/end') push({ phase: event.type, turn: event.data.turn, step: event.data.step });
    if (event.type === 'tool/call' && event.data.name === target) {
      lastCall = event.data.callId;
      push({ phase: 'call', turn: event.data.turn, step: event.data.step });
    }
    if (event.type === 'tool/result' && event.data.message.toolCallId === lastCall) {
      push({ phase: 'result', resultError: event.data.message.isError });
    }
  });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/super-bot-trusted-probe', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const plan = await request.json() as { action: 'attach' | 'worker' | 'plan' | 'prompt' | 'inspect' | 'cancel' | 'release' | 'feishu';
        sessionId: string; trial?: Trial; files?: boolean; review?: typeof review };
      const found = await ctx.sessionController.resolveAgent(SessionId(plan.sessionId));
      assert.ok('agent' in found);
      const current = found.agent;
      assert.ok(current.session.header.cwd?.startsWith(join(home!, 'super-bot') + '/'));
      if (plan.action === 'attach') {
        assert.equal(agent, undefined);
        agent = current;
        agent.model.select({ provider, model: 'count' });
        if (!plan.files) agent.ctx.tools.register({ name: 'bash', ...definition });
        const remoteAccess: unknown = ctx.get('remoteAccess');
        assert.ok(remoteAccess && typeof remoteAccess === 'object' && 'registerPolicy' in remoteAccess);
        const access = remoteAccess as Pick<RemoteAccessService, 'registerPolicy'>;
        access.registerPolicy('synthetic-share', {
          bindings: () => [{ resource: { kind: 'session', id: current.id },
            role: { name: 'synthetic-prompt-only', resource: 'session', actions: ['session/prompt'] } }],
        });
        agent.ctx.systemPrompt.context({ name: 'probe:isolated-context', order: 400, required: true, text: () => 'Synthetic epoch ' + epoch });
        agent.ctx.on('agent/inbox/claimed', payload => {
          if (trial) {
            claims.set(payload.message.id, payload.message);
            push({ phase: 'claimed', turn: payload.turn, sources: [source(payload.message)] });
          }
        });
        agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          if (trial && context.signal) { tools = context.toolSet; signal = context.signal; }
          return next();
        });
        agent.ctx.on('agent/pre-step', async (payload, next) => {
          if (trial) push({ phase: 'proposed', sources: payload.messages.map(source), turn: payload.turn, step: payload.step, sameSignal: payload.signal === signal, claimedObject: payload.messages.every(message => claims.get(message.id) === message) });
          const decision = await next();
          if (trial && decision.kind === 'enter') push({ phase: 'accepted', sources: decision.messages.map(source), turn: payload.turn, step: payload.step });
          return decision;
        });
        agent.ctx.on('tools/pre-execute', async (exec, next) => {
          if (trial && exec.name === target) {
            push({ phase: 'policy', ...flags(exec) });
            if (trial === 'host-denial') return { kind: 'deny', reason: 'Synthetic host policy denied a counter request.' };
            if (trial === 'host-approval') return { kind: 'ask', reason: 'Synthetic approval for the isolated counter.' };
          }
          return next();
        });
        agent.ctx.on('approval/request', (_req, next) => trial === 'host-approval' ? Promise.resolve('rejected' as const) : next(), { prepend: true });
        agent.ctx.tools.guard(exec => {
          if (trial && exec.name === target) push({ phase: 'guard', ...flags(exec) });
        });
        agent.ctx.on('tools/execute', async (exec, next) => {
          if (!trial || exec.name !== target) return next();
          push({ phase: 'execute', ...flags(exec) });
          if (trial === 'cancel' || trial === 'feishu-detach') {
            await new Promise<void>(resolve => { releasePendingTool = resolve; });
            releasePendingTool = undefined;
            push({ phase: 'released', aborted: exec.signal.aborted });
          }
          return next();
        });
      } else if (plan.action === 'worker') {
        worker = current;
        worker.model.select({ provider, model: 'count' });
      } else {
        assert.equal(current, agent);
        if (plan.action === 'plan') {
          assert.equal(current.status, 'idle');
          assert.ok(plan.trial);
          trial = plan.trial; trace = []; body = 0; entered = false; signal = undefined; tools = undefined; claims.clear();
          target = trial === 'delivery' || trial === 'no-wait' ? 'bash' : added;
          removeScopedCounter?.();
          removeScopedCounter = undefined;
          if (plan.files) {
            target = trial === 'files-counter' ? added : 'super_bot_manage';
            if (trial === 'files-counter') {
              // DSH allows a host to bind a tool directly to this Agent. The files guard still rejects it.
              removeScopedCounter = agent!.ctx.tools.register({ name: added, ...definition });
            }
          }
          if (trial === 'review') review = plan.review;
          if (trial === 'context') epoch++;
          if (trial === 'mixed') {
            const directory = join(home!, 'super-bot', 'synthetic-move');
            await mkdir(directory, { recursive: true });
            await ctx.workingDirectory.set(current, directory);
          }
        }
        if (plan.action === 'prompt') {
          const input = { requestId: randomUUID() as SessionRequestId, sessionId: current.id, mode: 'queue' as const,
            content: [{ type: 'text' as const, text: marker }] };
          if (trial === 'share') {
            const peer = ctx.connection.createPeer({ principal: { kind: 'synthetic-share' }, interactions: 'none' });
            await ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: { request: input }, peer, signal: request.signal });
          } else if (trial === 'unknown') current.followup(createUserMessage({ content: input.content, source: { kind: 'user' } }));
          else await ctx.sessionController.prompt(input, request.signal);
        }
        if (plan.action === 'feishu') {
          assert.ok(handlers);
          await handlers.onMessage({ chatId: existingGroup.chatId, messageId: randomUUID(), senderOpenId: fixtureCredentials.ownerOpenId,
            receiptKind: 'plain', text: marker, createdAt: Date.now() });
        }
        if (plan.action === 'cancel') ctx.sessionController.cancel({ sessionId: current.id });
        if (plan.action === 'release') { assert.ok(releasePendingTool); releasePendingTool(); }
      }
      return Response.json({ status: current.status, paused: !!releasePendingTool, body, trace, workerProof });
    },
  }));
}
