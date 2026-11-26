// Invoked by the isolated native launcher in smoke-mirror.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const first = '交付前回读文件。';
const override = '交付前检查标题。';
const updated = '交付前检查文档链接。';
const theme = '蓝色主题便于区分合成环境。';
const unrelated = '合成归档按季度组织。';
const pathToWork = (task, result) =>
  `/#super-bot-task=${task}${result ? `&resultId=${result}` : ''}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function smokeBotMemory({
  base,
  bundle,
  data,
  configure,
  launch,
  rpc,
  call,
  makeBot,
  probe,
  wait,
  verifyClient,
}) {
  await Promise.all(
    ['web', 'desktop'].map((role) => configure(role, { paired: true, hmr: false })),
  );
  const web = await launch('web', 'memory'),
    desktop = await launch('desktop', 'memory');
  const bundleHostSha256 = sha256(await readFile(join(bundle, 'lib/index.js')));
  const clientCode = await readFile(join(bundle, 'lib/client.js'), 'utf8');
  const bundleClientSha256 = sha256(clientCode);
  const [webClient, desktopClient] = await Promise.all([
    verifyClient('web', web, clientCode),
    verifyClient('desktop', desktop, clientCode),
  ]);
  const [webStatus, desktopStatus] = await Promise.all([
    call(web, 'status'),
    call(desktop, 'status'),
  ]);
  const bot = await makeBot(web, '合成 Bot'),
    other = await makeBot(web, '合成 Bot');
  const dir = join(data.web, 'memory', bot.id),
    index = join(dir, 'index.md');
  const file = join(dir, 'work-convention.md');
  assert.match(await readFile(index, 'utf8'), /\[工作约定\]\(work-convention.md\)/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await Promise.all([bot, other].map((b) => probe(web, 'select-test-model', b.managerId)));

  async function say(session, text, expectedActions) {
    const before = await probe(web, 'inspect-session', session);
    await probe(web, 'native-prompt', session, text);
    const after = await probe(web, 'inspect-session', session);
    assert.deepEqual(
      after.managerAttempts.slice(before.managerAttempts.length).map(({ action }) => action),
      expectedActions,
    );
    return {
      reply: after.assistantTexts.at(-1),
      results: after.toolResults.slice(before.toolResults.length),
    };
  }
  const remember = (session, text) =>
    say(session, `请把「${text}」保存为以后的默认工作约定。`, ['memory-save-convention']);
  assert.equal(JSON.parse((await remember(bot.managerId, first)).reply).text, first);
  assert.match(await readFile(file, 'utf8'), /交付前回读文件。/);
  const manual = async (label, directive, expected) => {
    await say(bot.managerId, `请写一份合成说明 ${label}。${directive}`, ['create']);
    const task = await wait(
      async () =>
        (await call(web, 'task.list', { botId: bot.id, q: `MEMORY_WORK_${label}` })).items.find(
          (item) => item.lifecycle === 'review' && item.managerReviewed,
        ),
      `chat task ${label} settles`,
    );
    const detail = await call(web, 'task.detail', { id: task.id, sessionId: bot.managerId });
    assert.equal(detail.result.humanAcceptedAt, null);
    await wait(async () => {
      const s = await probe(web, 'inspect-session', bot.managerId);
      return (
        s.status === 'idle' &&
        !s.pending &&
        s.assistantTexts.some((text) => text.includes(pathToWork(task.id, detail.result.id)))
      );
    }, `original chat receives task ${label} result`);
    const worker = await probe(web, 'inspect-session', detail.binding.sessionId);
    const workerInput = worker.events.find(
      (e) => e.type === 'user/message' && e.data.source?.runId === detail.run.id,
    );
    const prompt = workerInput?.data.content.find((block) => block.type === 'text')?.text;
    assert.ok(prompt?.includes(`Work convention recorded for this task (${expected.source}).`));
    assert.ok(prompt?.includes(expected.text));
    return {
      task: task.id,
      result: detail.result.id,
      worker: worker.sessionId,
      run: detail.run.id,
      inputSeq: workerInput.seq,
    };
  };

  const a = await manual('A', '', { source: 'default', text: first });
  const b = await manual('B', `这一次请${override}`, { source: 'override', text: override });
  const readDefault = (session) =>
    say(session, '现在默认工作约定是什么？', ['memory-index', 'memory-read']);
  assert.equal(
    JSON.parse((await readDefault(bot.managerId)).reply).text,
    first,
    'one-time override left the default alone',
  );
  assert.equal(
    JSON.parse((await readDefault(other.managerId)).reply).text,
    null,
    'same-name Bot has its own default',
  );
  assert.equal(JSON.parse((await remember(bot.managerId, updated)).reply).text, updated);
  const c = await manual('C', '', { source: 'default', text: updated });
  const snapshot = async (session, task) =>
    JSON.parse((await say(session, `请核对这项任务的实际工作约定：${task}`, ['detail'])).reply);
  assert.deepEqual(await snapshot(bot.managerId, a.task), { source: 'default', text: first });
  assert.deepEqual(await snapshot(bot.managerId, b.task), { source: 'override', text: override });
  assert.deepEqual(await snapshot(bot.managerId, c.task), { source: 'default', text: updated });

  const attachment = await web.get(`/api/super-bot-file?resultId=${a.result}&index=0`);
  assert.equal(attachment.status, 200);
  const sourceDocument = await attachment.text();
  assert.ok(sourceDocument.includes(theme) && sourceDocument.includes(unrelated));
  await mkdir(join(dir, 'decisions'), { mode: 0o700 });
  await writeFile(
    join(dir, 'decisions', 'theme.md'),
    `[来源](${pathToWork(a.task, a.result)})\n\n${theme}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, 'decisions', 'archive.md'),
    `[来源](${pathToWork(a.task, a.result)})\n\n${unrelated}\n`,
    { mode: 0o600 },
  );
  await appendFile(
    index,
    '\n- [主题配色](decisions/theme.md)\n- [归档周期](decisions/archive.md)\n',
  );
  const question = '上次为什么选蓝色主题？';
  const source = `[来源](${web.base}${pathToWork(a.task, a.result)})`;
  const decision = await say(bot.managerId, question, ['memory-index', 'memory-read']);
  assert.equal(decision.reply, `${theme}\n\n${source}`);
  const indexResult = JSON.stringify(decision.results[0]);
  assert.ok(indexResult.includes('主题配色') && indexResult.includes('归档周期'));
  assert.ok(!JSON.stringify(decision.results).includes(unrelated) && !indexResult.includes(theme));
  const linked = await call(web, 'task.detail', {
    id: a.task,
    resultId: a.result,
    sessionId: bot.managerId,
  });
  assert.equal(linked.linkedResult.id, a.result);
  const otherRead = await say(other.managerId, '请查另一 Bot 的决策条目。', [
    'memory-index',
    'memory-read',
  ]);
  assert.ok(otherRead.results.at(-1).message.isError);
  assert.ok(!JSON.stringify(otherRead).includes(theme));
  const replacement = await call(web, 'manager.replace', {
    requestId: randomUUID(),
    botId: bot.id,
    expectedGeneration: 1,
  });
  assert.notEqual(replacement.sessionId, bot.managerId);
  assert.equal(await call(web, 'bot.for-session', { sessionId: bot.managerId }), null);
  await probe(web, 'select-test-model', replacement.sessionId);
  assert.equal(
    (await say(replacement.sessionId, question, ['memory-index', 'memory-read'])).reply,
    decision.reply,
  );
  assert.equal(JSON.parse((await readDefault(replacement.sessionId)).reply).text, updated);
  assert.deepEqual(await snapshot(replacement.sessionId, a.task), {
    source: 'default',
    text: first,
  });
  const oldBefore = await probe(web, 'inspect-session', bot.managerId);
  await probe(
    web,
    'native-prompt',
    bot.managerId,
    '请把「旧会话不能写入。」保存为以后的默认工作约定。',
  );
  const oldAfter = await probe(web, 'inspect-session', bot.managerId);
  assert.equal(oldAfter.executedTools.length, oldBefore.executedTools.length);
  assert.ok(!oldAfter.modelTools.includes('super_bot_manage'));
  assert.equal(JSON.parse((await readDefault(replacement.sessionId)).reply).text, updated);

  const bytes = await readFile(file);
  assert.ok((await call(desktop, 'mirror.catalog')).bots.some((entry) => entry.id === bot.id));
  const mirrored = await call(desktop, 'mirror.detail', {
    owner: 'web',
    botId: bot.id,
    id: a.task,
  });
  assert.equal(mirrored.result.id, a.result);
  assert.ok(!JSON.stringify(mirrored).includes(first));
  for (const action of ['memory-index', 'memory-read', 'memory-save-convention']) {
    assert.equal(
      (await rpc(desktop, action, { owner: 'web', botId: bot.id, text: '镜像写入不可用。' })).error
        ?.code,
      'invalid-input',
    );
    assert.equal((await rpc(desktop, action, { botId: bot.id })).error?.code, 'not-found');
  }
  assert.equal(
    (
      await rpc(desktop, 'mirror.detail', {
        owner: 'web',
        botId: bot.id,
        id: a.task,
        op: 'memory-save-convention',
      })
    ).error?.code,
    'invalid-input',
  );
  assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(stat(join(data.desktop, 'memory', bot.id)), { code: 'ENOENT' });

  const proof = {
    web: { pid: web.pid, origin: web.base, clientRevision: webClient, runtime: webStatus.runtime },
    desktop: {
      pid: desktop.pid,
      origin: desktop.base,
      clientRevision: desktopClient,
      runtime: desktopStatus.runtime,
    },
    bundleHostSha256,
    bundleClientSha256,
    bot: bot.id,
    other: other.id,
    session: bot.managerId,
    replacement: replacement.sessionId,
    tasks: { a, b, c },
    decision: { calls: ['memory-index', 'memory-read'], source },
    checks: [
      'snapshot default and one-time override in native Worker input',
      'updated default leaves both old tasks stable',
      'index and one relevant decision read with exact result citation',
      'current Bot identity and replacement chat',
      'paired mirror rejects memory access and writes',
      'all synthetic results remain awaiting human acceptance',
    ],
  };
  await writeFile(join(base, 'memory-proof.json'), JSON.stringify(proof, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    `PASS isolated native Bot memory on Web and paired Desktop; ${join(base, 'memory-proof.json')}`,
  );
}
