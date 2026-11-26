// Starts a fresh localhost DSH Web profile and exercises real tool bodies with only synthetic traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { authenticateHost } from './host-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = process.argv.includes('--files');
const hostModules = process.env.SUPER_BOT_TEST_DSH_NODE_MODULES ?? join(root, 'node_modules');
const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } =
  process.env;
assert.ok(playwright && executablePath, 'Use local Playwright and browser binaries.');
const base = await mkdtemp(join(await realpath(tmpdir()), 'super-bot-native-proof-'));
const osHome = join(base, 'os-home'),
  home = join(base, 'super-bot/.runtime/dsh');
const env = {
  PATH: process.env.PATH,
  HOME: osHome,
  TMPDIR: osHome,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
};
const bundle = join(base, 'bundle'),
  lib = join(bundle, 'lib');
const profile = join(home, 'profiles', 'native-trusted');
function done(child) {
  return new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code) => (code === 0 ? ok() : fail(Error('Process exit ' + code))));
  });
}
await Promise.all([
  mkdir(osHome),
  mkdir(lib, { recursive: true }),
  mkdir(join(bundle, 'node_modules'), { recursive: true }),
  mkdir(join(profile, 'node_modules/@zxdvd'), { recursive: true }),
]);
await Promise.all([
  symlink(join(hostModules, '@deepseek-ai'), join(bundle, 'node_modules/@deepseek-ai')),
  symlink(join(root, 'node_modules', 'marked'), join(bundle, 'node_modules/marked')),
  symlink(join(hostModules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai')),
  symlink(bundle, join(profile, 'node_modules/@zxdvd/super-bot')),
]);
const fixtureTransport = join(root, 'test/feishu-host-transport.ts');
const synthetic = await import(pathToFileURL(fixtureTransport).href);
const replacement = {
  name: 'synthetic-feishu',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/feishu-sdk\.ts$/ }, () => ({ path: fixtureTransport }));
  },
};
const manifest = await readFile(join(root, 'package.json'), 'utf8');
await Promise.all([
  writeFile(join(bundle, 'package.json'), manifest),
  cp(join(root, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml')),
  writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'native-trusted-isolated',
      private: true,
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zxdvd/super-bot'],
        },
      },
    }),
  ),
  writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      { id: 'hmr', disabled: true },
      { id: 'super-bot', config: { dataDir: join(home, 'super-bot/ledger'), fullAccess: !files } },
    ]),
  ),
  done(
    spawn(process.execPath, ['scripts/build.mjs'], {
      cwd: root,
      env: { ...env, SUPER_BOT_BUILD_OUTDIR: lib },
      stdio: 'inherit',
    }),
  ),
]);
await build({
  absWorkingDir: root,
  stdin: {
    contents:
      'import * as product from ' +
      JSON.stringify(join(root, 'src/index.ts')) +
      ';\n' +
      'import * as proof from ' +
      JSON.stringify(join(root, 'test/manager-native-host-probe.ts')) +
      ';\n' +
      'export const { name, Config } = product;\n' +
      'export const inject = [...new Set([...product.inject, ...proof.inject])];\n' +
      'export async function apply(ctx, config) { await product.apply(ctx, config); proof.apply(ctx); }',
    resolveDir: root,
    sourcefile: 'native-trusted-synthetic-host.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: join(lib, 'index.js'),
  plugins: [replacement],
});
async function wait(predicate, label) {
  for (let i = 0; i < 300; i++) {
    const result = await predicate();
    if (result) return result;
    await sleep(60);
  }
  assert.fail('Timed out: ' + label + ' (' + base + ')');
}
let browser, host;
async function launch(label) {
  const log = join(base, label + '.log');
  const out = await open(log, 'wx', 0o600);
  const child = spawn(
    process.execPath,
    [
      join(hostModules, '@deepseek-ai/dsh/lib/bin.js'),
      '--profile',
      'native-trusted',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ],
    { cwd: root, env, stdio: ['ignore', out.fd, out.fd] },
  );
  let exited = false,
    fault;
  const exit = new Promise((ok) => {
    child.once('error', (error) => {
      fault = error;
    });
    child.once('close', () => {
      exited = true;
      ok();
    });
  });
  host = {
    async close() {
      if (!exited) child.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 4000);
      await exit;
      clearTimeout(timeout);
      await out.close();
      host = undefined;
    },
  };
  const url = await wait(async () => {
    assert.ok(!exited && !fault, 'Isolated DSH failed (see private log in ' + base + ')');
    return (await readFile(log, 'utf8')).match(
      /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/,
    )?.[1];
  }, 'native ready');
  return { url, client: await authenticateHost(url) };
}
try {
  let { url, client } = await launch('host');
  async function call(action, payload) {
    const response = await client.post('/api/super-bot', {
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'super-bot',
      payload: { action, ...payload },
    });
    assert.equal(response.status, 200, action);
    const result = (await response.json()).result;
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  }
  const bot = await call('bot.create', {
    requestId: randomUUID(),
    name: '合成工具信任样例',
    instructions: '仅验证隔离计数器',
  });
  const { sessionId } = await call('manager.prepare', { requestId: randomUUID(), botId: bot.id });
  const runtime = (await call('status')).runtime;
  async function probe(action, payload) {
    const response = await client.post('/api/super-bot-trusted-probe', {
      action,
      sessionId,
      ...payload,
    });
    const text = await response.text();
    assert.equal(response.status, 200, action + ': ' + text.slice(0, 300));
    return JSON.parse(text);
  }
  await probe('attach', { files });
  await call('feishu.settings.save', synthetic.fixtureCredentials);
  const preview = await call('feishu.preview', {
    botId: bot.id,
    chatId: synthetic.existingGroup.chatId,
  });
  const { binding } = await call('feishu.bind', {
    botId: bot.id,
    confirmationToken: preview.confirmationToken,
  });
  const results = {};
  async function trial(label, origin) {
    await probe('plan', { trial: label, files });
    if (origin === 'edge') {
      const { chromium } = await import(pathToFileURL(playwright).href);
      browser ??= await chromium.launch({
        executablePath,
        args: [
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        ],
        env,
      });
      const context = await browser.newContext();
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === client.base ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      const welcome = page.getByRole('button', { name: 'Continue', exact: true });
      await page.addLocatorHandler(welcome, (button) => button.click(), { times: 1 });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Super Bot', exact: true }).click({ timeout: 15000 });
      await page.locator('.bot-row').filter({ hasText: bot.name }).locator('.bot-open').click();
      const composer = page.locator('[data-composer-input]');
      await composer.click();
      await page.keyboard.insertText('本机隔离原生工具探针');
      await composer.press('Enter');
      await wait(
        async () => (await probe('inspect')).trace.find((row) => row.phase === 'proposed'),
        label + ' proposed from UI',
      );
    } else if (label === 'automatic') {
      await call('task.create', {
        requestId: randomUUID(),
        botId: bot.id,
        goal: '合成定向通知',
        scope: '隔离会话',
        acceptance: '只记录工具结果',
        reviewPolicy: 'human',
      });
    } else if (label === 'feishu' || label === 'feishu-detach') await probe('feishu');
    else await probe('prompt');
    if (label === 'cancel' || label === 'feishu-detach') {
      await wait(async () => (await probe('inspect')).paused, 'tool suspended in normal wrapper');
      if (label === 'cancel') await probe('cancel');
      else await call('feishu.unbind', { botId: bot.id, bindingId: binding.id });
      await probe('release');
    }
    return wait(async () => {
      const state = await probe('inspect');
      return (
        state.status === 'idle' && state.trace.some((row) => row.phase === 'turn/end') && state
      );
    }, label + ' idle');
  }
  const trials = files
    ? ['files-counter', 'trusted']
    : [
        'trusted',
        'context',
        'continuation',
        'mixed',
        'host-denial',
        'host-approval',
        'no-wait',
        'cancel',
        'unknown',
        'share',
        'feishu',
        'feishu-detach',
        'automatic',
      ];
  for (const label of trials) {
    const result = await trial(label, label === 'trusted' ? 'edge' : 'in-process');
    results[label] = { body: result.body, trace: result.trace };
    const granted = !files && ['trusted', 'context', 'continuation', 'feishu'].includes(label);
    assert.equal(result.body, label === 'continuation' ? 2 : Number(granted), label);
    if (files && label === 'trusted') {
      assert.ok(result.trace.some((row) => row.phase === 'result' && !row.resultError));
      assert.ok(result.trace.every((row) => row.extraToolOffered !== true));
    } else if (!granted)
      assert.ok(
        result.trace.some((row) => row.phase === 'result' && row.resultError),
        label,
      );
    if (label === 'files-counter') {
      assert.ok(result.trace.some((row) => row.phase === 'model-offered' && row.extraToolOffered));
      assert.ok(result.trace.some((row) => row.phase === 'call'));
    }
    if (granted) {
      assert.ok(result.trace.some((row) => row.phase === 'body' && row.sameToolSet));
      assert.ok(result.trace.some((row) => row.phase === 'proposed' && row.sameSignal));
    }
    if (label === 'context') {
      assert.ok(
        result.trace.some(
          (row) => row.phase === 'committed' && row.sources.includes('runtime-context'),
        ),
      );
      assert.ok(
        result.trace.some(
          (row) => row.phase === 'proposed' && !row.sources.includes('runtime-context'),
        ),
      );
    }
    if (label === 'mixed') {
      assert.ok(
        result.trace.some(
          (row) =>
            row.phase === 'proposed' &&
            row.sources.includes('working-directory') &&
            row.sources.includes('user'),
        ),
      );
    }
    if (label === 'share')
      assert.ok(result.trace.some((row) => row.phase === 'committed' && row.shared));
    if (label === 'feishu')
      assert.ok(result.trace.some((row) => row.phase === 'committed' && row.feishu));
    if (label === 'automatic')
      assert.ok(
        result.trace.some(
          (row) => row.phase === 'committed' && row.sources.includes('super-bot-manager'),
        ),
      );
    if (label === 'host-denial') assert.ok(result.trace.some((row) => row.phase === 'policy'));
    if (label === 'host-approval') {
      assert.ok(result.trace.some((row) => row.phase === 'approval/asked'));
      assert.ok(
        result.trace.some(
          (row) => row.phase === 'approval/decided' && row.approvalOutcome === 'rejected',
        ),
      );
    }
    if (label === 'cancel')
      assert.ok(result.trace.some((row) => row.phase === 'released' && row.aborted));
    if (label === 'feishu-detach') {
      assert.ok(result.trace.some((row) => row.phase === 'released'));
      assert.ok(result.trace.some((row) => row.phase === 'result' && row.resultError));
    }
  }
  if (!files) {
    const task = await call('task.create', {
      requestId: randomUUID(),
      botId: bot.id,
      goal: '生成隔离证据',
      scope: '任务临时目录',
      acceptance: '保留一份合成文本',
      reviewPolicy: 'human',
    });
    const binding = await call('session.prepare', {
      requestId: randomUUID(),
      id: task.id,
      expectedRowVersion: task.rowVersion,
    });
    await probe('worker', { sessionId: binding.sessionId });
    const ready = await call('task.detail', { id: task.id });
    await call('task.dispatch', {
      requestId: randomUUID(),
      id: task.id,
      expectedRowVersion: ready.task.rowVersion,
    });
    const result = await wait(async () => {
      const current = await call('task.detail', { id: task.id });
      return current.result && current.task.lifecycle === 'review' && current;
    }, 'actual Worker result');
    assert.equal(result.result.evidence.length, 1);
    const worker = (await probe('inspect')).workerProof;
    assert.deepEqual(worker, { owner: true, report: true, manager: false, count: 1 });
    results.worker = { body: worker.count, worker };
    await wait(
      async () => (await probe('inspect')).status === 'idle',
      'Manager idle before review',
    );
    await probe('plan', {
      trial: 'review',
      review: {
        taskId: task.id,
        expectedRowVersion: result.task.rowVersion,
        resultId: result.result.id,
      },
    });
    await probe('prompt');
    await wait(async () => {
      const current = await call('task.detail', { id: task.id });
      return current.task.managerReviewed && (await probe('inspect')).status === 'idle';
    }, 'Manager reviews actual candidate');
    await probe('plan', { trial: 'delivery' });
    const delivery = await wait(async () => {
      const state = await probe('inspect');
      return state.status === 'idle' && state.trace.some((row) => row.phase === 'result') && state;
    }, 'delivery-only automatic thread');
    assert.ok(delivery.trace.some((row) => row.phase === 'result' && row.resultError));
    assert.equal(delivery.body, 0);
    results.delivery = { body: delivery.body, trace: delivery.trace };
  }
  if (!files) {
    await browser.close();
    browser = undefined;
    await host.close();
    const ledger = new DatabaseSync(join(home, 'super-bot/ledger/ledger.sqlite'), {
      readOnly: true,
    });
    try {
      const receipt = ledger
        .prepare(
          'SELECT count(*) AS count FROM feishu_inbound_receipts WHERE nativeSeq IS NOT NULL',
        )
        .get();
      assert.equal(receipt.count, 2);
      results.feishu.boundReceipts = receipt.count;
    } finally {
      ledger.close();
    }
    ({ url, client } = await launch('restart'));
    const existing = await call('manager.prepare', { requestId: randomUUID(), botId: bot.id });
    assert.equal(existing.sessionId, sessionId);
    await probe('attach');
    const afterRestart = await trial('automatic', 'in-process');
    assert.equal(afterRestart.body, 0);
    assert.ok(afterRestart.trace.some((row) => row.phase === 'result' && row.resultError));
    assert.ok(
      afterRestart.trace.some(
        (row) => row.phase === 'committed' && row.sources.includes('super-bot-manager'),
      ),
    );
    results.reattachedAutomatic = { body: afterRestart.body, trace: afterRestart.trace };
    const fresh = await trial('context', 'in-process');
    assert.equal(fresh.body, 1);
    results.reattachedTrusted = { body: fresh.body, trace: fresh.trace };
  }
  console.log(JSON.stringify({ runtime, files, results }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    await host?.close();
    await rm(base, { recursive: true });
  }
}
