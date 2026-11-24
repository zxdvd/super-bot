import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { createAssistantMessage, createUserMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { Managers } from '../../src/manager.ts';
import type { DshExecution } from '../../src/dsh.ts';
import { Store } from '../../src/store.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'synthetic-plugin-context': { kind: 'synthetic-plugin-context' };
  }
}

const syntheticTool = 'synthetic_counter';
const allowedResult = { content: [], isError: false };

function fixture(t: TestContext, fullAccess = true) {
  const store = new Store(':memory:');
  const bot = store.createBot('bot', { name: 'Synthetic Bot', instructions: 'Synthetic work' });
  const intent = store.beginManager('prepare', bot.id, '/synthetic/manager');
  const session = { id: intent.requestedSessionId };
  store.confirmManager(intent.id, session.id);
  const scoped = new Map<string, (...args: any[]) => any>();
  const global = new Map<string, (...args: any[]) => any>();
  let guard: (exec: any) => string | undefined = () => undefined;
  const agent = {
    id: session.id, session, status: 'idle', whenIdle: async () => {},
    cancel: () => { agent.status = 'idle'; },
    inbox: { nextTurn: [], nextStep: [] },
    ctx: {
      tools: {
        restrict: () => () => {},
        guard: (callback: typeof guard) => { guard = callback; return () => {}; },
      },
      on: (event: string, callback: (...args: any[]) => any) => { scoped.set(event, callback); return () => scoped.delete(event); },
      systemPrompt: { section: () => () => {} },
    },
  };
  const ctx = {
    permissionPresets: { set: () => {} },
    effect: (callback: () => unknown) => callback(),
    on: (event: string, callback: (...args: any[]) => any) => { global.set(event, callback); return () => global.delete(event); },
    agents: { list: () => [agent], get: (id: string) => id === agent.id ? agent : undefined },
    tools: { register: () => () => {} },
  } as unknown as Context;
  const managers = new Managers(ctx, store, {} as DshExecution, '/synthetic', undefined, { fullAccess });
  managers.install();
  t.after(async () => { await managers.dispose(); store.close(); });

  let seq = 0;
  function event(type: string, data: unknown, surfaceOp?: 'append') {
    const entry = { type, data, seq: ++seq, time: Date.now(), surfaceOp };
    global.get('session/event')?.(session, entry);
    scoped.get('session/event')?.(session, entry);
  }
  function inserted(message: UserMessage) {
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
    scoped.get('agent/inbox/inserted')?.({ agent, message });
    global.get('agent/inbox/inserted')?.({ agent, message });
  }
  function start(turn: number) {
    const controller = new AbortController();
    agent.status = 'running';
    event('turn/start', { turn });
    return { turn, controller, signal: controller.signal };
  }
  async function admitStep(active: ReturnType<typeof start>, number: number, messages: UserMessage[],
    commit = true, context: UserMessage[] = []) {
    const { turn, signal } = active;
    for (const message of messages) {
      scoped.get('agent/inbox/claimed')?.({ agent, turn, message });
      global.get('agent/inbox/claimed')?.({ agent, turn, message });
    }
    let open = true;
    const definition = { name: syntheticTool };
    const toolSet = Object.freeze({
      dispose() { open = false; },
      view(scope: unknown) { return new Map(open && scope === agent ? [[syntheticTool, definition]] : []); },
    });
    const modelSelection = { provider: 'synthetic', model: 'synthetic' };
    await scoped.get('system-prompt/assemble')?.({}, { agent, scope: agent, toolSet, signal, modelSelection }, async () => ({}));
    const proposal = { agent, turn, step: number, messages, signal, modelSelection };
    const entered = [...messages, ...context];
    await scoped.get('agent/pre-step')?.(proposal, async () => ({ kind: 'enter', messages: entered }));
    event('step/start', { turn, step: number });
    if (commit) for (const message of entered) event('user/message', message, 'append');
    return { ...active, number, toolSet };
  }
  let effects = 0, dispatches = 0;
  function call(step: Awaited<ReturnType<typeof admitStep>>, name = syntheticTool) {
    const callId = `call-${step.turn}-${step.number}-${seq}` as ToolCallId;
    const response = createAssistantMessage({
      source: { provider: 'synthetic', model: 'synthetic' },
      content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
    });
    event('assistant/message', { turn: step.turn, step: step.number, message: response, stream: [] }, 'append');
    event('tool/call', { turn: step.turn, step: step.number, callId, name, arguments: '{}' });
    const execution = {
      agent, name, callId, rootCallId: callId, arguments: {},
      signal: step.signal, toolSet: step.toolSet,
    };
    const exec = { ...execution, token: Symbol('synthetic tool execution') };
    return {
      prepare: (withToken = true) => guard(withToken ? exec : execution),
      async dispatch(withToken = true) {
        const next = async () => {
          dispatches++;
          if (step.toolSet.view(agent).has(name) && !exec.signal.aborted) effects++;
          return allowedResult;
        };
        const wrapper = scoped.get('tools/execute');
        return wrapper ? wrapper(withToken ? exec : execution, next) : next();
      },
    };
  }
  function endStep(step: Awaited<ReturnType<typeof admitStep>>) {
    event('step/end', { turn: step.turn, step: step.number });
    step.toolSet.dispose();
  }
  function endTurn(active: ReturnType<typeof start>, aborted = false) {
    if (aborted) active.controller.abort();
    event('turn/end', { turn: active.turn, reason: aborted ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } });
    agent.status = 'idle';
  }
  const prompt = () => createUserMessage({
    source: { kind: 'user', rpcId: randomUUID() as SessionRequestId },
    content: [{ type: 'text', text: 'Run the synthetic counter' }],
  });
  return {
    bot, intent, inserted, start, admitStep, call, endStep, endTurn, prompt,
    effects: () => effects, dispatches: () => dispatches,
  };
}

test('Manager inherits a current host tool after a fresh trusted input is committed', async t => {
  const f = fixture(t);
  const owner = f.prompt();
  f.inserted(owner);
  const turn = f.start(1), first = await f.admitStep(turn, 1, [owner]);
  const firstCall = f.call(first);
  assert.equal(firstCall.prepare(), undefined);
  await firstCall.dispatch();
  f.endStep(first);
  const next = await f.admitStep(turn, 2, []);
  const nextCall = f.call(next);
  assert.equal(nextCall.prepare(), undefined);
  await nextCall.dispatch();
  assert.equal(f.effects(), 2);
  f.endStep(next);
  f.endTurn(turn);
});

test('Manager keeps the restricted boundary when normal inbox input has no fresh admission evidence', async t => {
  const f = fixture(t);
  const turn = f.start(1);
  const restored = await f.admitStep(turn, 1, [f.prompt()]);
  assert.ok(f.call(restored).prepare(), 'a pending message restored from history is not new authority');
  f.endStep(restored);
  f.endTurn(turn);

  const queued = f.prompt();
  f.inserted(queued);
  const interrupted = f.start(2);
  const proposed = await f.admitStep(interrupted, 1, [queued], false);
  assert.ok(f.call(proposed).prepare(), 'an admitted proposal without a committed user message is insufficient');
  f.endStep(proposed);
  f.endTurn(interrupted);
  assert.equal(f.effects(), 0);

  const fresh = f.prompt();
  f.inserted(fresh);
  const current = f.start(3), complete = await f.admitStep(current, 1, [fresh]);
  const invocation = f.call(complete);
  assert.ok(invocation.prepare(false), 'an admitted call still needs the host execution token');
  await assert.rejects(invocation.dispatch(false), { code: 'manager-tool-scope' });
  assert.equal(invocation.prepare(), undefined);
  await assert.rejects(invocation.dispatch(false), { code: 'manager-tool-scope' });
  assert.equal(f.dispatches(), 0, 'dispatch cannot proceed without the token, even after a valid preparation');
  await invocation.dispatch();
  assert.equal(f.effects(), 1);
  f.endStep(complete);
  f.endTurn(current);
});

test('Manager does not widen a turn with mixed trusted and automatic inputs', async t => {
  const f = fixture(t);
  const notice = createUserMessage({
    source: { kind: 'super-bot-manager', botId: f.bot.id, managerId: f.intent.id, eventId: 'synthetic-notice' },
    content: [{ type: 'text', text: 'A synthetic task is ready to review' }],
  });
  const owner = f.prompt();
  f.inserted(notice);
  f.inserted(owner);
  const turn = f.start(1), mixed = await f.admitStep(turn, 1, [notice, owner]);
  assert.ok(f.call(mixed).prepare());
  f.endStep(mixed);
  const later = f.prompt();
  f.inserted(later);
  const steered = await f.admitStep(turn, 2, [later]);
  assert.ok(f.call(steered).prepare(), 'a fresh later input cannot change the turn classification');
  f.endStep(steered);
  f.endTurn(turn);
  assert.equal(f.effects(), 0);
});

test('A cancelled Manager call does not carry trusted authority into the next turn', async t => {
  const f = fixture(t);
  const owner = f.prompt();
  f.inserted(owner);
  const turn = f.start(1), first = await f.admitStep(turn, 1, [owner]);
  const held = f.call(first);
  assert.equal(held.prepare(), undefined);
  f.endStep(first);
  f.endTurn(turn, true);
  const following = f.start(2), step = await f.admitStep(following, 1, []);
  assert.ok(f.call(step).prepare());
  try { await held.dispatch(); } catch { /* The cancelled invocation may settle with a tool error. */ }
  assert.equal(f.effects(), 0);
  assert.equal(f.dispatches(), 0);
  f.endStep(step);
  f.endTurn(following);
});

test('Files Manager keeps rejecting an extra host tool after normal trusted input', async t => {
  const f = fixture(t, false);
  const owner = f.prompt();
  f.inserted(owner);
  const turn = f.start(1), first = await f.admitStep(turn, 1, [owner]);
  assert.ok(f.call(first).prepare());
  assert.equal(f.effects(), 0);
  f.endStep(first);
  f.endTurn(turn);
});

test('An unfamiliar plugin context does not widen a Manager turn with normal host input', async t => {
  const f = fixture(t);
  const owner = f.prompt();
  f.inserted(owner);
  const turn = f.start(1);
  const context = createUserMessage({
    source: { kind: 'synthetic-plugin-context' },
    content: [{ type: 'text', text: 'An ordinary synthetic context contribution' }],
  });
  const first = await f.admitStep(turn, 1, [owner], true, [context]);
  assert.ok(f.call(first).prepare());
  f.endStep(first);
  f.endTurn(turn);
  assert.equal(f.effects(), 0);
});

test('Retained inbox input after Manager cancellation needs fresh admission for extra tools', async t => {
  const f = fixture(t);
  const owner = f.prompt();
  f.inserted(owner);
  const turn = f.start(1), first = await f.admitStep(turn, 1, [owner]);
  const queued = f.prompt();
  f.inserted(queued);
  f.endStep(first);
  f.endTurn(turn, true);

  const resumed = f.start(2), retained = await f.admitStep(resumed, 1, [queued]);
  assert.ok(f.call(retained).prepare(), 'cancelled admission evidence cannot travel with a retained message');
  f.endStep(retained);
  f.endTurn(resumed);

  const fresh = f.prompt();
  f.inserted(fresh);
  const following = f.start(3), current = await f.admitStep(following, 1, [fresh]);
  const invocation = f.call(current);
  assert.equal(invocation.prepare(), undefined);
  await invocation.dispatch();
  assert.equal(f.effects(), 1);
  f.endStep(current);
  f.endTurn(following);
});
