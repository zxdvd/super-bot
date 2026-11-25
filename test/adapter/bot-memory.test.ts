import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { BotMemory } from '../../src/bot-memory.ts';
import type { DshExecution } from '../../src/dsh.ts';
import { Managers } from '../../src/manager.ts';
import { Store } from '../../src/store.ts';
import { workUrl } from '../../src/work-links.ts';

function fixture(t: TestContext) {
  const runtime = join(realpathSync(process.cwd()), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const dataDir = mkdtempSync(join(runtime, 'bot-memory-test-'));
  const memory = new BotMemory(dataDir);
  const store = new Store(':memory:', memory);
  const bot = store.createBot('a', { name: 'A', instructions: 'Fixture' });
  const other = store.createBot('b', { name: 'A', instructions: 'Fixture' });
  t.after(() => {
    store.close();
    assert.ok(dataDir.startsWith(join(runtime, 'bot-memory-test-')) && realpathSync(dataDir) === dataDir);
    rmSync(dataDir, { recursive: true });
  });
  return { bot, other, store, memory, dataDir };
}

test('task creation snapshots the applied convention after idempotency checks', t => {
  const { bot, store, memory } = fixture(t);
  const input = { botId: bot.id, goal: 'Document', scope: 'Local', acceptance: 'Read it back', reviewPolicy: 'human' as const };
  const legacy = store.createTask('legacy', input);
  assert.equal(store.taskBotContext(legacy.id).workConvention, undefined);
  memory.saveConvention(bot.id, 'Read the file back', 1, 4);
  const original = store.createTask('default', input);
  const oneTime = store.createTask('override', input, undefined, 'Check the title');
  memory.saveConvention(bot.id, 'Check links', 1, 9);
  assert.equal(store.createTask('default', input).id, original.id);
  assert.equal(store.createTask('override', input, undefined, 'Check the title').id, oneTime.id);
  assert.throws(() => store.createTask('override', input, undefined, 'Check links'), { code: 'idempotency-conflict' });
  assert.throws(() => memory.saveConvention(bot.id, 'Read the file back', 1, 4), { code: 'memory-stale' });
  assert.doesNotThrow(() => memory.saveConvention(bot.id, 'Check links', 1, 9));
  assert.deepEqual(store.taskBotContext(original.id).workConvention, { source: 'default', text: 'Read the file back' });
  assert.deepEqual(store.taskBotContext(oneTime.id).workConvention, { source: 'override', text: 'Check the title' });
  assert.deepEqual(store.taskBotContext(store.createTask('new', input).id).workConvention, { source: 'default', text: 'Check links' });
});

test('registered memory actions require current native Bot authority, user text, and a Bot-owned ledger source', async t => {
  const { bot, other, store, memory, dataDir } = fixture(t);
  const manager = store.beginManager('manager', bot.id, dataDir);
  const sessionId = manager.requestedSessionId;
  store.confirmManager(manager.id, sessionId);
  let execute!: (args: unknown, exec: unknown) => Promise<any>;
  const listeners = new Map<string, Function>();
  const ctx = {
    effect: (setup: () => void) => setup(),
    tools: { register: (tool: { execute: typeof execute }) => { execute = tool.execute; } },
    on: (event: string, handler: Function) => listeners.set(event, handler),
    agents: { list: () => [] },
  } as unknown as Context;
  const managers = new Managers(ctx, store, {} as DshExecution, dataDir, () => 'http://127.0.0.1:6001');
  managers.install(); t.after(() => managers.dispose());
  const call = (args: Record<string, unknown>, id = sessionId) => execute(args, { agent: { id }, signal: new AbortController().signal, callId: 'test' });
  const save = (text: string) => call({ action: 'memory-save-convention', text });
  await assert.rejects(save('User convention'), { code: 'human-message-required' });
  const event = listeners.get('session/event')!;
  event({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } });
  event({ id: sessionId }, { type: 'user/message', surfaceOp: 'append', seq: 3, data: { id: 'native-message', source: { kind: 'user', rpcId: 'rpc' },
    content: [{ type: 'text', text: 'Please save this work convention: User convention.' }] } });
  await assert.rejects(save('Model-generated convention'), { code: 'memory-human-text' });
  await save('User convention.');
  assert.equal(memory.defaultConvention(bot.id), 'User convention.');
  assert.equal(memory.defaultConvention(other.id), undefined);
  const foreignTask = store.createTask('foreign', { botId: other.id, goal: 'Fixture', scope: '', acceptance: '', reviewPolicy: 'human' });
  const directory = join(dataDir, 'memory', bot.id);
  const index = join(directory, 'index.md');
  writeFileSync(index, `${readFileSync(index, 'utf8')}\n- [主题](decisions/theme.md)\n`);
  mkdirSync(join(directory, 'decisions'));
  const entry = 'decisions/theme.md';
  writeFileSync(join(directory, entry), `[来源](${workUrl({ kind: 'task', taskId: foreignTask.id })})\n\nOther Bot decision\n`);
  await assert.rejects(call({ action: 'memory-read', entry }), { code: 'memory-source' });
  await assert.rejects(call({ action: 'memory-read', entry: '../work-convention.md' }), { code: 'memory-entry' });
  await assert.rejects(call({ action: 'memory-read', entry }, 'unbound-session'), { code: 'manager-scope' });
  writeFileSync(index, `${readFileSync(index, 'utf8')}- [链接](decisions/link.md)\n`);
  symlinkSync(join(directory, 'work-convention.md'), join(directory, 'decisions', 'link.md'));
  await assert.rejects(call({ action: 'memory-read', entry: 'decisions/link.md' }), { code: 'memory-path' });
  store.releaseManager('release', bot.id, manager.generation);
  await assert.rejects(save('User convention.'), { code: 'manager-scope' });
});
