import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService, type Principal } from '@deepseek-ai/dsh-client-connection';
import { apply } from '../../src/index.ts';
import { Store } from '../../src/store.ts';
import { readLocalMirror } from '../../src/mirror-queries.ts';
import { parseMirrorQuery } from '../../src/mirror-host.ts';
import { SystemIssues } from '../../src/ui/work/SystemIssues.tsx';
import { LinkedTaskContent, TaskDetailHeader } from '../../src/ui/work/TaskDetail.tsx';
import { ResultCard } from '../../src/ui/work/ResultCard.tsx';
import { ConfirmAction } from '../../src/ui/kit.tsx';
import { ReplyForm } from '../../src/ui/work/forms.tsx';
import type { WorkspaceState } from '../../src/ui/work/useWorkspace.ts';
import type { WorkLink } from '../../src/work-links.ts';

async function fixture(t: TestContext) {
  const root = join(realpathSync(process.cwd()), '.runtime');
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(join(root, 'notification-fixture-'));
  const database = join(dataDir, 'ledger.sqlite');
  const store = new Store(database);
  const effects: Array<() => unknown> = [];
  async function close() { for (const dispose of effects.splice(0).reverse()) await dispose(); }
  t.after(async () => {
    await close();
    assert.equal(realpathSync(dataDir), dataDir);
    assert.ok(dataDir.startsWith(join(root, 'notification-fixture-')));
    rmSync(dataDir, { recursive: true });
  });
  const bot = store.createBot('bot', { name: 'Synthetic owner', instructions: 'Fixture' });
  const other = store.createBot('other', { name: 'Other synthetic owner', instructions: 'Fixture' });
  const manager = store.beginManager('manager', bot.id, dataDir);
  const otherManager = store.beginManager('other-manager', other.id, dataDir);
  for (const item of [manager, otherManager]) store.confirmManager(item.id, item.requestedSessionId);
  const sessionId = manager.requestedSessionId;
  const task = store.createTask('task', { botId: bot.id, goal: '合成版本核对', scope: 'Files', acceptance: 'Read', reviewPolicy: 'human' });
  const binding = store.beginBinding('binding', task.id, task.rowVersion, dataDir);
  store.confirmBinding(binding.id, binding.requestedSessionId);
  function result(label: string) {
    const run = store.reserveRun(`run-${label}`, task.id, store.getTask(task.id).rowVersion);
    store.saveRunMessage(run.id, `input-${label}`, '{}');
    store.claimDispatch(run.id);
    store.inputEntered(run.id, `input-${label}`, 1);
    store.workerReport(run.id, `progress-${label}`, { kind: 'progress', summary: `进度 ${label}` });
    const report = store.workerReport(run.id, `report-${label}`, { kind: 'ready', summary: `成果 ${label}`, checks: 'Synthetic',
      evidence: [{ path: join(dataDir, `${label}.md`), bytes: 1, sha256: 'synthetic' }] });
    store.settleRun(run.id);
    const resultId = report.resultId!;
    store.managerDeliver(`draft-${label}`, bot.id, sessionId, `call-${label}`, { taskId: task.id, resultId, text: label });
    return { runId: run.id, resultId, eventId: `manager-event:delivery:${resultId}` };
  }
  const old = result('old');
  store.rejectResult('rework', task.id, store.getTask(task.id).rowVersion, old.resultId, 'Second version');
  const current = result('current');
  const otherNotices = Array.from({ length: 24 }, (_, i) => `other-${i}`);
  for (const key of otherNotices) store.enqueueManager(bot.id, key, 'Unrelated pending event', task.id);
  store.db.prepare("UPDATE outbox SET createdAt=1 WHERE id GLOB 'manager-event:other-*'").run();
  const inbox = [old, current].map((item, index) => {
    const message = { id: `message-${index}`, source: { kind: 'super-bot-manager', botId: bot.id, managerId: manager.id, eventId: item.eventId } };
    assert.ok(store.claimManagerEvent(item.eventId, message.id, JSON.stringify(message)));
    store.managerEventUnknown(item.eventId);
    return message;
  });
  store.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.deliveryAttemptEnd',json(?)) WHERE id=?")
    .run(JSON.stringify({ sessionId, turn: 4, endSeq: 46, messageId: inbox[0]!.id }), old.eventId);
  const reasons = ['原聊天已有成果链接，但当前文件无法按该版本打开。', '补交付轮次已被中断，请打开 Bot 对话核对。'];
  store.managerProblem(bot.id, reasons[0]!, old.eventId);
  store.managerProblem(bot.id, reasons[1]!, current.eventId);
  const generic = 'manager-event:general-unknown';
  store.enqueueManager(bot.id, 'general-unknown', 'Unrelated unknown', task.id);
  assert.ok(store.claimManagerEvent(generic, 'generic-message', '{}'));
  store.managerEventUnknown(generic);
  const mirror = readLocalMirror(store, { op: 'detail', botId: bot.id, id: task.id });
  store.close();
  const connection = new HostConnectionService(new Context(), [], {
    isAuthenticated: () => false, authenticateApi: () => undefined,
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  const { fetch } = connection.createSharedFetchHandler('/api');
  const tools = new Map<string, any>();
  let resolves = 0, sends = 0, cancels = 0;
  const removed: string[] = [];
  const agent = { id: sessionId, followup() { sends++; }, cancel() { cancels++; }, inbox: {
    nextTurn: [...inbox, { id: 'human-message', source: { kind: 'user' } }], nextStep: [],
    remove(id: string) { removed.push(id); this.nextTurn = this.nextTurn.filter(message => message.id !== id); },
  } };
  let loaded = false;
  await apply({
    connection, effect(start: () => unknown) { const dispose = start(); if (typeof dispose === 'function') effects.push(dispose as () => unknown); },
    inject: async () => {}, on: () => () => {}, get: () => undefined,
    tools: { register(tool: { name: string }) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    agents: { get: () => undefined, list: () => loaded ? [agent] : [] }, jobs: { list: () => [] },
    sessionController: { resolveAgent: async () => { resolves++; return { error: 'Synthetic cold session' }; } },
  } as unknown as Context, { dataDir });
  loaded = true;
  const raw = (action: string, data: Record<string, unknown>, peer = connection.browserPeer) => fetch(new Request('http://localhost/api/super-bot', {
    method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'super-bot', payload: { action, ...data } }),
  }), peer);
  const call = async (action: string, data: Record<string, unknown>) => {
    const response = await raw(action, data); assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  async function lateNativeCheck() {
    await close();
    const reopened = new Store(database);
    try {
      reopened.supersedeManagerDelivery(old.eventId);
      reopened.managerProblem(bot.id, 'Late native diagnostic', old.eventId);
      return { problem: reopened.managerInfo(bot.id).problem, status: reopened.chatDeliveryStatus(task, reopened.resultById(old.resultId), true) };
    } finally { reopened.close(); }
  }
  return { botId: bot.id, otherBotId: other.id, task, sessionId, otherSessionId: otherManager.requestedSessionId, old, current,
    reasons, mirror, tools, raw, call, removed, agent, lateNativeCheck, counts: () => ({ resolves, sends, cancels }),
    guest: connection.createPeer({ principal: { kind: 'synthetic-other' } as unknown as Principal }) };
}

// Inspect production component elements and invoke navigation/confirmation callbacks at the client boundary.
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  if (typeof node.type === 'function' && ![ConfirmAction, TaskDetailHeader, ReplyForm].includes(node.type)) {
    return elements(node.type(node.props));
  }
  return [node, ...elements(node.props.children)];
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? text(node.props.children) : '';
}

test('unknown result deliveries stay identifiable and one owner confirmation handles only the selected notice', async t => {
  const f = await fixture(t);
  const status = async () => (await f.call('manager.status', { botId: f.botId })).value;
  const detail = async (resultId: string) => (await f.call('task.detail', { id: f.task.id, resultId, sessionId: f.sessionId })).value;
  const before = await status(), beforeDetail = await detail(f.current.resultId);
  assert.equal(before.uncertain, 3);
  assert.equal(before.notifications.some((notice: { id: string }) => notice.id === f.old.eventId), false, 'general status window is full');
  const opened: string[] = [], selected: WorkLink[] = [], mutations: Record<string, unknown>[] = [];
  const w = { bot: { id: f.botId, managerSessionId: f.sessionId }, botId: f.botId, managerInfo: before, locked: false,
    api: { openSession: (id: string) => { opened.push(id); } },
    select(id: string, target: WorkLink) { assert.equal(id, f.task.id); selected.push(target); },
    mutate: async (action: string, payload: Record<string, unknown>) => {
      assert.equal(action, 'manager.notification.resolve'); mutations.push(payload);
      const result = await f.call(action, { ...payload, sessionId: f.sessionId });
      assert.equal(result.ok, true); return result.ok;
    },
  } as unknown as WorkspaceState;
  const inbox = elements(SystemIssues({ w }));
  assert.ok(inbox.some(node => node.type === 'summary' && /3 条通知送达待核对/.test(text(node))), 'the inbox exposes the delivery review list');
  const targets = inbox.filter(node => node.type === 'button' && text(node) === '查看这份成果');
  assert.equal(targets.length, 2);
  assert.equal(inbox.filter(node => node.type === ConfirmAction).length, 2);
  for (const target of targets) target.props.onClick();
  for (const [index, item] of [f.old, f.current].entries()) {
    assert.ok(selected.some(link => link.kind === 'result' && link.taskId === f.task.id && link.resultId === item.resultId));
    assert.ok(inbox.some(node => node.type === 'p' && text(node).includes(f.reasons[index]!)), 'each result keeps its own cause');
  }
  const oldLink = selected.find(link => link.kind === 'result' && link.resultId === f.old.resultId);
  assert.ok(oldLink?.kind === 'result');
  const historical = () => detail(f.old.resultId).then(d => elements(LinkedTaskContent({ w, detail: d, link: oldLink, close: () => {} })));
  const oldNodes = await historical();
  assert.ok(oldNodes.some(node => node.type === 'h3' && text(node) === '历史成果 · 只读'));
  assert.equal(oldNodes.find(node => node.type === TaskDetailHeader)?.props.controls, false);
  assert.ok(oldNodes.some(node => node.type === 'p' && text(node).includes(f.reasons[0]!)));
  assert.ok(oldNodes.some(node => node.type === 'p' && /原聊天核对第 4 轮/.test(text(node))));
  const chat = oldNodes.find(node => node.type === 'button' && text(node) === '打开原聊天');
  assert.ok(chat); chat.props.onClick(); assert.deepEqual(opened, [f.sessionId]);
  let returned = 0;
  const fromChat = elements(SystemIssues({ w: { ...w, sessionId: f.sessionId }, onReturn: () => { returned++; } }));
  fromChat.find(node => node.type === 'button' && text(node) === '打开原聊天').props.onClick();
  assert.equal(returned, 1); assert.deepEqual(opened, [f.sessionId]);
  assert.equal(SystemIssues({ w: { ...w, mirror: { owner: 'desktop', bot: { id: f.botId, name: 'Mirror' } } } }), null);
  const confirm = oldNodes.find(node => node.type === ConfirmAction && node.props.label === '标记此通知已处理');
  assert.ok(confirm); assert.equal(mutations.length, 0);
  const args = { requestId: 'other-attempt', botId: f.botId, eventId: f.old.eventId, resolution: 'handled', acknowledged: true };
  assert.equal((await f.raw('manager.notification.resolve', args, f.guest)).status, 403);
  for (const [extra, code] of [[{ acknowledged: false }, 'confirmation-required'], [{ resolution: 'retry-unsent' }, 'notification-uncertain'],
    [{ botId: f.otherBotId }, 'not-found'], [{ sessionId: f.otherSessionId }, 'not-found'], [{ owner: 'desktop' }, 'invalid-input']] as const) {
    assert.equal((await f.call('manager.notification.resolve', { ...args, ...extra })).error.code, code);
  }
  assert.throws(() => parseMirrorQuery({ op: 'manager.notification.resolve', ...args }));
  assert.equal(JSON.stringify(f.mirror).includes(f.sessionId), false);
  assert.equal(JSON.stringify(f.mirror).includes(f.old.eventId), false);
  const tool = f.tools.get('super_bot_manage');
  assert.ok(tool?.parameters?.properties?.action?.enum);
  assert.equal(tool.parameters.properties.action.enum.includes('manager.notification.resolve'), false);
  assert.equal(await confirm.props.submit(), true);
  assert.deepEqual(mutations, [{ ...args, requestId: `notification-handled:${f.old.eventId}` }]);
  assert.equal(await confirm.props.submit(), true, 'repeat confirmation is idempotent');
  const after = await status();
  assert.equal(after.uncertain, 2); assert.equal(after.pending, before.pending); assert.equal(after.hourlyWakes, before.hourlyWakes);
  assert.deepEqual(after.uncertainDeliveries, before.uncertainDeliveries.filter((notice: { id: string }) => notice.id !== f.old.eventId));
  const afterDetail = await detail(f.current.resultId);
  for (const key of ['task', 'progress', 'run', 'result', 'chatDelivery', 'attentions']) assert.deepEqual(afterDetail[key], beforeDetail[key]);
  assert.equal(afterDetail.result.humanAcceptedAt, null);
  assert.equal(afterDetail.events.filter((event: { kind: string }) => event.kind === 'manager.notification-resolved').length, 1);
  assert.equal(afterDetail.events.some((event: { kind: string }) => event.kind === 'manager.delivered'), false);
  w.managerInfo = after;
  assert.ok((await historical()).some(node => node.type === 'p' && /交付通知已由用户处理/.test(text(node))));
  assert.ok(elements(ResultCard({ w, detail: afterDetail })).some(node => node.type === ConfirmAction));
  assert.deepEqual(f.removed, ['message-0']);
  assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), ['message-1', 'human-message']);
  assert.deepEqual(f.counts(), { resolves: 0, sends: 0, cancels: 0 });
  assert.deepEqual(await f.lateNativeCheck(), { problem: after.problem, status: { state: 'handled', reason: f.reasons[0] } });
});
