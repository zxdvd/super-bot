import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { startReloadHost, type ReloadHmr } from '../../src/dev-reload-host.ts';
import { reloadArtifacts, reloadDirectory, type ReloadEndpoint } from '../../src/dev-reload-paths.ts';
import { ReloadAdmission } from '../../src/reload-admission.ts';
import { DshExecution } from '../../src/dsh.ts';
import { Managers } from '../../src/manager.ts';
import { Store } from '../../src/store.ts';

const checkout = realpathSync(process.cwd());
const runtime = join(checkout, '.runtime');
const originalPatch = '# synthetic DF-09 profile\n';

function fixture(t: TestContext) {
  mkdirSync(runtime, { recursive: true });
  const root = mkdtempSync(join(runtime, 'df09-test-'));
  const home = join(root, 'home');
  const name = 'fixture';
  const dir = join(home, 'profiles', name);
  const patchPath = join(dir, 'cordis.patch.yml');
  const built = join(root, 'built');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  copyFileSync(join(checkout, 'scripts/dev-reload.mjs'), join(root, 'scripts/dev-reload.mjs'));
  copyFileSync(join(checkout, 'src/dev-reload-paths.ts'), join(root, 'src/dev-reload-paths.ts'));
  const manifest = join(dir, 'package.json');
  const linkManifest = JSON.stringify({ dependencies: { '@zxdvd/super-bot': `link:${root}` } });
  writeFileSync(manifest, linkManifest);
  writeFileSync(patchPath, originalPatch);
  const scope = join(dir, 'node_modules', '@zxdvd');
  mkdirSync(scope, { recursive: true });
  symlinkSync(root, join(scope, 'super-bot'), 'junction');
  const lib = join(root, 'lib');
  mkdirSync(lib);
  for (const file of reloadArtifacts) writeFileSync(join(lib, file), 'outgoing build');
  const hold = join(root, 'hold');
  const releaseBuild = join(root, 'release-build');
  writeFileSync(join(root, 'scripts/build.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    import { join } from 'node:path';
    const id = process.env.SUPER_BOT_RELOAD_BUILD_ID;
    writeFileSync(${JSON.stringify(built)}, id ?? 'no permission');
    while (existsSync(${JSON.stringify(hold)}) && !existsSync(${JSON.stringify(releaseBuild)})) await setTimeout(10);
    for (const file of ${JSON.stringify(reloadArtifacts)}) {
      const data = file.endsWith('.map') ? JSON.stringify({ sources: ['../src/change.ts'], sourcesContent: ['verified source'] }) : id;
      writeFileSync(join(process.env.SUPER_BOT_BUILD_OUTDIR, file), data);
    }
  `);
  const hosts: NonNullable<ReturnType<typeof startReloadHost>>[] = [];
  t.after(() => {
    for (const host of hosts) host.close();
    assert.equal(realpathSync(root), root);
    assert.ok(root.startsWith(join(runtime, 'df09-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  function start(args: string[] = [], selectedProfile = name) {
    const child = spawn(process.execPath, [join(root, 'scripts/dev-reload.mjs'), ...args], {
      cwd: root, env: { ...process.env, DSH_HOME: home, SUPER_BOT_PROFILE: selectedProfile },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const result = new Promise<{ code: number|null; stdout: string; stderr: string }>((done, fail) => {
      child.once('error', fail);
      child.once('close', code => done({ code, stdout, stderr }));
    });
    return { result, child, stdout: () => stdout };
  }
  function mount(hmr: ReloadHmr, admission = new ReloadAdmission(), blockers = () => [] as string[], build = '', leaseMs?: number,
    reloadResult?: Parameters<typeof startReloadHost>[0]['reloadResult']) {
    const host = startReloadHost({ profile: { home, name, dir, patchPath }, root, build, admission, blockers, hmr, leaseMs, reloadResult,
      log: message => t.diagnostic(message) });
    assert.ok(host);
    hosts.push(host);
    return host;
  }
  const published = () => readFileSync(join(lib, 'index.js'), 'utf8');
  const unmodified = () => {
    assert.equal(readFileSync(manifest, 'utf8'), linkManifest);
    assert.equal(readFileSync(patchPath, 'utf8'), originalPatch);
    assert.equal(published(), 'outgoing build');
  };
  return { root, home, name, dir, patchPath, built, hold, releaseBuild, manifest, linkManifest, mount, start, published, unmodified,
    run: (...args: string[]) => start(args).result };
}

test('without a live plugin the real dev:reload command does not build or change the profile', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.deepEqual({ code: result.code, built: existsSync(f.built), patch: readFileSync(f.patchPath, 'utf8') },
    { code: 1, built: false, patch: originalPatch });
  assert.match(result.stderr, /unavailable/);
});

function hmrFixture(
  reconcileProfile: ReloadHmr['reconcileProfile'] = async () => { throw Error('unexpected HMR'); },
  transaction = new AsyncLocalStorage<boolean>(),
) {
  let queue = Promise.resolve();
  let watchers = 0;
  const hmr = {
    config: { root: [] as string[] }, reconcileProfile, watchers: () => watchers,
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      if (transaction.getStore()) return Promise.reject(Error('HMR transactions cannot be nested'));
      const task = queue.then(() => transaction.run(true, operation));
      queue = task.then(() => {}, () => {});
      return task;
    },
    watchConfig(filename: string, refresh: () => Promise<void>) {
      // Model DSH's public watcher contract with a real file event and transaction context.
      return transaction.exit(async () => {
        let running = Promise.resolve();
        const watcher = watch(filename, { persistent: false }, () => { running = hmr.runExclusive(refresh).catch(() => {}); });
        watchers++;
        return async () => {
          watcher.close();
          await running; // Intentionally drain even when the current callback triggers disposal.
          watchers--;
        };
      });
    },
  };
  return hmr;
}

function holdOperation() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the fixture boundary');
    await delay(10);
  }
}

async function request(endpoint: ReloadEndpoint, action: string, id: string, instance = endpoint.instance) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/${action}/${id}`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${endpoint.token}`, 'x-super-bot-instance': instance },
  });
  return response.ok ? await response.json() : { status: response.status };
}

test('busy refusal and bounded wait report blockers, then require a receipt from the linked successor', async t => {
  const f = fixture(t);
  let work = ['Worker task fixture-task, run fixture-run (running)'];
  let next: ReloadEndpoint | undefined;
  const hmr = hmrFixture(async ids => {
    assert.deepEqual(ids, ['super-bot']);
    const build = readFileSync(f.built, 'utf8');
    assert.equal(f.published(), build);
    old.close();
    old.retired();
    next = await f.mount(hmr, undefined, undefined, build).ready;
    return {};
  });
  const old = f.mount(hmr, undefined, () => work);
  const oldEndpoint = await old.ready;
  const denied = await f.run();
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /busy: Worker task fixture-task, run fixture-run/);
  assert.equal(existsSync(f.built), false);
  f.unmodified();
  const waiting = f.start(['--wait', '3']);
  await until(() => waiting.stdout().includes('Waiting for fixture: busy: Worker task'));
  assert.equal(existsSync(f.built), false);
  work = [];
  const done = await waiting.result;
  assert.equal(done.code, 0, done.stderr);
  assert.ok(next);
  assert.match(done.stdout, /Granted by fixture[\s\S]*Waiting for fixture to publish[\s\S]*Applied fixture/);
  assert.ok(done.stdout.includes(`${oldEndpoint.instance} → ${next.instance}`));
  assert.equal(next.pid, oldEndpoint.pid);
  assert.equal(readFileSync(f.patchPath, 'utf8'), originalPatch);
  assert.equal(readFileSync(f.manifest, 'utf8'), f.linkManifest);
});

test('result attribution needs matching staged source and a confirmed successor', async t => {
  const f = fixture(t), store = new Store(':memory:');
  t.after(() => store.close());
  const bot = store.createBot('bot', { name: 'Bot', instructions: 'Synthetic reload' });
  const task = store.createTask('task', { botId: bot.id, goal: 'Change source', scope: 'Source', acceptance: 'Check', reviewPolicy: 'human' });
  const binding = store.beginBinding('binding', task.id, task.rowVersion, f.root);
  store.confirmBinding(binding.id, binding.requestedSessionId);
  const run = store.reserveRun('run', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(run.id, 'input', '{}'); store.claimDispatch(run.id); store.inputEntered(run.id, 'input', 1);
  const sha256 = createHash('sha256').update('verified source').digest('hex');
  const evidence = [{ path: join(f.root, 'src/change.ts'), sha256, bytes: 15 }];
  const { resultId } = store.workerReport(run.id, 'ready', { kind: 'ready', summary: 'Changed', checks: 'Checked', evidence });
  store.settleRun(run.id);
  let match = false, mounts = 0;
  const reloadResult = {
    evidence: (id: string) => store.devReloadResult(id, f.root).result.evidence.map(file => ({ ...file, sha256: match ? file.sha256 : 'wrong' })),
    record: (receipt: Parameters<Store['recordDevReload']>[1]) => store.recordDevReload(f.root, receipt),
  };
  const hmr = hmrFixture(async () => {
    mounts++;
    old.close(); old.retired();
    await f.mount(hmr, undefined, undefined, f.published(), undefined, reloadResult).ready;
    assert.equal(store.taskDetail(task.id).progress.reload, null);
    return {};
  });
  const old = f.mount(hmr, undefined, undefined, '', undefined, reloadResult);
  const endpoint = await old.ready;
  const bad = await f.run('--result', resultId!);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /does not match/);
  assert.equal(mounts, 0);
  f.unmodified();
  match = true;
  const good = await f.run('--result', resultId!);
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /Recorded the reload receipt/);
  const receipt = store.taskDetail(task.id).progress.reload;
  assert.equal(receipt?.resultId, resultId);
  assert.equal(receipt?.build, f.published());
  assert.equal(receipt?.from, endpoint.instance);
  assert.notEqual(receipt?.to, receipt?.from);
  assert.equal(receipt?.pid, endpoint.pid);
  assert.equal(store.getTask(task.id).lifecycle, 'review');
});

test('an instance mounted in native HMR can apply two consecutive protected CLI reloads', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const transaction = new AsyncLocalStorage<boolean>();
  let mounted: ReturnType<typeof f.mount>;
  let applications = 0;
  const hmr = hmrFixture(async ids => {
    assert.equal(transaction.getStore(), true);
    assert.deepEqual(ids, ['super-bot']);
    mounted.close();
    mounted.retired();
    mounted = f.mount(hmr, undefined, undefined, f.published());
    await mounted.ready;
    applications++;
    return {};
  }, transaction);
  const first = await hmr.runExclusive(async () => {
    mounted = f.mount(hmr);
    return mounted.ready;
  });
  const one = await f.run();
  assert.equal(one.code, 0, one.stderr);
  const second = await mounted!.ready;
  assert.ok(one.stdout.includes(`${first.instance} → ${second.instance}`));
  const two = await f.run();
  assert.equal(two.code, 0, two.stderr);
  assert.ok(two.stdout.includes(`${second.instance} → ${(await mounted!.ready).instance}`));
  assert.equal(applications, 2);
  await until(() => hmr.watchers() === 1);
  assert.equal(readFileSync(f.patchPath, 'utf8'), originalPatch);
  assert.equal(readFileSync(f.manifest, 'utf8'), f.linkManifest);
});

test('copied discovery, mismatched live identity and competing CLI cannot authorize a second build', async t => {
  const f = fixture(t);
  const host = f.mount(hmrFixture());
  const endpoint = await host.ready;
  const otherDir = join(f.home, 'profiles', 'other');
  mkdirSync(reloadDirectory(otherDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(reloadDirectory(otherDir), `${endpoint.instance}.json`), JSON.stringify(endpoint), { mode: 0o600 });
  const foreign = await f.start([], 'other').result;
  assert.equal(foreign.code, 1);
  assert.match(foreign.stderr, /invalid reload discovery record/);
  assert.equal(existsSync(f.built), false);
  const first = randomUUID();
  assert.deepEqual(await request(endpoint, 'claim', first, randomUUID()), { status: 403 });
  const grant = await request(endpoint, 'claim', first);
  assert.equal(grant.state, 'granted');
  assert.deepEqual(await request(endpoint, 'claim', first), grant);
  const refused = await f.run();
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /reserved: another protected reload/);
  assert.equal(existsSync(f.built), false);
  assert.equal((await request(endpoint, 'cancel', first)).state, 'cancelled');
  assert.equal((await request(endpoint, 'claim', first)).state, 'expired-or-cancelled');
  f.unmodified();
});

test('an unavailable blocker inventory refuses safely and a different active instance makes ownership ambiguous', async t => {
  const f = fixture(t);
  const hmr = hmrFixture();
  await f.mount(hmr, undefined, () => { throw Error('native Agent inventory unavailable'); }).ready;
  const unknown = await f.run();
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown: native Agent inventory unavailable/);
  await f.mount(hmr).ready;
  const duplicate = await f.run();
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /ambiguous/);
  assert.equal(existsSync(f.built), false);
  f.unmodified();
});

test('Ctrl-C during staging cancels permission and leaves active build and profile intact', async t => {
  const f = fixture(t);
  writeFileSync(f.hold, 'hold staging');
  const endpoint = await f.mount(hmrFixture()).ready;
  const cli = f.start();
  await until(() => existsSync(f.built));
  const id = readFileSync(f.built, 'utf8');
  const preparing = await request(endpoint, 'claim', randomUUID());
  assert.equal(preparing.state, 'reserved');
  cli.child.kill('SIGINT');
  const cancelled = await cli.result;
  assert.equal(cancelled.code, 130, cancelled.stderr);
  assert.match(cancelled.stderr, /cancelled by signal/);
  assert.equal((await request(endpoint, 'commit', id)).state, 'expired-or-cancelled');
  assert.equal((await request(endpoint, 'claim', randomUUID())).state, 'granted');
  f.unmodified();
});

test('loss of the granting instance during staging cannot publish through a new instance', async t => {
  const f = fixture(t);
  writeFileSync(f.hold, 'hold staging');
  const hmr = hmrFixture();
  const old = f.mount(hmr);
  await old.ready;
  const cli = f.start();
  await until(() => existsSync(f.built));
  old.close();
  old.retired();
  const next = await f.mount(hmr).ready;
  const id = readFileSync(f.built, 'utf8');
  assert.equal((await request(next, 'commit', id)).state, 'expired-or-cancelled');
  writeFileSync(f.releaseBuild, 'resume');
  const failed = await cli.result;
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /live host disconnected/);
  f.unmodified();
});

test('a commit queued behind native recomposition rechecks expiry before publishing', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let queued = false;
  const release = holdOperation();
  const hmr = hmrFixture();
  hmr.runExclusive = async operation => { queued = true; await release.promise; return operation(); };
  const endpoint = await f.mount(hmr, undefined, undefined, '', 500).ready;
  const id = randomUUID();
  const lease = await request(endpoint, 'claim', id);
  assert.equal(lease.state, 'granted');
  const result = request(endpoint, 'commit', id);
  await until(() => queued);
  assert.equal((await request(endpoint, 'commit', id)).state, 'reserved');
  t.mock.timers.tick(501);
  release.release();
  assert.equal((await result).state, 'expired-or-cancelled');
  assert.equal((await request(endpoint, 'claim', id)).state, 'expired-or-cancelled');
  f.unmodified();
});

test('cancelling a queued CLI commit prevents a late native callback from publishing', async t => {
  const f = fixture(t);
  const release = holdOperation();
  let queued = false, checked = false;
  const hmr = hmrFixture();
  const exclusive = hmr.runExclusive;
  hmr.runExclusive = operation => exclusive(async () => {
    queued = true;
    await release.promise;
    try { return await operation(); }
    finally { checked = true; }
  });
  const endpoint = await f.mount(hmr).ready;
  const cli = f.start();
  try {
    await until(() => queued);
    cli.child.kill('SIGINT');
    assert.equal((await cli.result).code, 130);
  } finally { release.release(); }
  await until(() => checked);
  assert.equal((await request(endpoint, 'claim', randomUUID())).state, 'granted');
  f.unmodified();
});

test('an unobserved watcher trigger expires the queued request and releases admission', async t => {
  const f = fixture(t);
  const hmr = hmrFixture();
  hmr.watchConfig = async () => async () => {};
  const admission = new ReloadAdmission();
  const endpoint = await f.mount(hmr, admission, undefined, '', 500).ready;
  const id = randomUUID();
  assert.equal((await request(endpoint, 'claim', id)).state, 'granted');
  const committed = request(endpoint, 'commit', id);
  const trigger = join(reloadDirectory(f.dir), `${endpoint.instance}.apply`);
  await until(() => readFileSync(trigger, 'utf8') === id);
  const expired = await committed;
  assert.equal(expired.state, 'expired-or-cancelled');
  assert.match(expired.blockers[0], /permission expired before native HMR/);
  const leave = admission.tryEnter('synthetic work');
  assert.ok(leave);
  leave();
  f.unmodified();
});

test('native activity appearing after grant is diagnosed before publishing', async t => {
  const f = fixture(t);
  writeFileSync(f.hold, 'hold staging');
  let blockers: string[] = [];
  await f.mount(hmrFixture(), undefined, () => blockers).ready;
  const cli = f.start();
  await until(() => existsSync(f.built));
  blockers = ['Manager session native-input (running)'];
  writeFileSync(f.releaseBuild, 'resume');
  const failed = await cli.result;
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /busy: Manager session native-input/);
  f.unmodified();
});

for (const condition of ['different-build', 'missing-retirement', 'native-restart', 'activation-error'] as const) {
  test(`published build remains unconfirmed on ${condition}`, async t => {
    const f = fixture(t);
    const hmr = hmrFixture(async () => {
      if (condition === 'native-restart') return { restartReason: 'module-comparison' };
      if (condition === 'activation-error') throw Error('fixture plugin could not activate');
      old.close();
      if (condition !== 'missing-retirement') old.retired();
      const build = condition === 'different-build' ? randomUUID() : f.published();
      await f.mount(hmr, undefined, undefined, build).ready;
      return {};
    });
    const old = f.mount(hmr);
    await old.ready;
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unconfirmed/);
    assert.match(result.stderr, /Check native HMR logs/);
    assert.doesNotMatch(result.stdout, /Applied fixture/);
    assert.equal(f.published(), readFileSync(f.built, 'utf8'));
    assert.equal(readFileSync(f.patchPath, 'utf8'), originalPatch);
  });
}

function scheduler(t: TestContext, root: string) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new Store(join(root, 'scheduler', 'ledger.sqlite'));
  const bot = store.createBot('bot', { name: 'Synthetic DF-09', instructions: 'Regression only' });
  const manager = store.beginManager('manager', bot.id, root);
  store.confirmManager(manager.id, manager.requestedSessionId);
  const resolved: string[] = [];
  const wakes: string[] = [];
  const barriers = new Map<string, Promise<void>>();
  const jobs = new Map<string, { owner: string; id: string; status: string }[]>();
  const agents = new Map<string, ReturnType<typeof agentFor>>();
  function agentFor(id: string) {
    let idle = Promise.resolve();
    let settle = () => {};
    const agent = {
      id, session: { id, header: { cwd: root } }, status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => {} },
      model: { current: () => ({ provider: 'fixture', model: 'fixture' }), select: () => {} },
      ctx: { on: () => () => {}, tools: { restrict: () => () => {}, guard: () => () => {} }, systemPrompt: { section: () => () => {} } },
      whenIdle: () => idle,
      followup: () => { wakes.push(id); agent.status = 'running'; idle = new Promise<void>(resolve => { settle = resolve; }); },
      cancel: () => { agent.status = 'idle'; settle(); },
    };
    return agent;
  }
  const managerAgent = agentFor(manager.requestedSessionId);
  agents.set(managerAgent.id, managerAgent);
  const ctx = {
    effect: (install: () => unknown) => install(), on: () => () => {}, tools: { register: () => () => {} },
    agents: { list: () => [...agents.values()], isOwnedBy: () => false }, jobs: { list: (id: string) => jobs.get(id) ?? [] },
    sessionController: { resolveAgent: async (id: string) => {
      resolved.push(id); await barriers.get(id); return { agent: agents.get(id) };
    } },
    workingDirectory: { get: () => root },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: { provider: 'fixture', model: 'fixture' } } } }) },
  } as unknown as Context;
  const admission = new ReloadAdmission();
  const execution = new DshExecution(ctx, store, root, { fullAccess: false }, admission);
  const managers = new Managers(ctx, store, execution, root, () => '', { fullAccess: false }, admission);
  execution.install();
  managers.install();
  t.after(async () => {
    for (const agent of agents.values()) agent.cancel();
    await managers.dispose();
    await execution.dispose();
    store.close();
  });
  function createTask(key: string) {
    const task = store.createTask(`task-${key}`, { botId: bot.id, goal: key, scope: 'Fixture', acceptance: 'Inspect', reviewPolicy: 'human' });
    store.settleManagerEvent(`manager-event:created:${task.id}`);
    const binding = store.beginBinding(`bind-${key}`, task.id, task.rowVersion, root);
    store.claimBindingCreation(binding.id);
    store.confirmBinding(binding.id, binding.requestedSessionId);
    agents.set(binding.requestedSessionId, agentFor(binding.requestedSessionId));
    return { task: store.getTask(task.id), sessionId: binding.requestedSessionId };
  }
  function notify() {
    store.enqueueManager(bot.id, 'df09-notice', 'Synthetic automatic wake', null);
    return () => store.managerInfo(bot.id).notifications.find(event => event.id === 'manager-event:df09-notice');
  }
  const pulse = async () => { t.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve)); };
  const blockers = () => [...execution.reloadBlockers(), ...managers.reloadBlockers()];
  return { admission, store, execution, blockers, managerAgent, wakes, resolved, barriers, jobs, createTask, pulse, notify };
}

test('once granted, Worker dispatch and Manager automatic wake cannot enter before publication', async t => {
  const f = fixture(t);
  const s = scheduler(t, f.root);
  const { task, sessionId } = s.createTask('protected');
  const other = s.createTask('same-directory');
  const notice = s.notify();
  const endpoint = await f.mount(hmrFixture(), s.admission, s.blockers).ready;
  writeFileSync(f.hold, 'hold staging');
  const cli = f.start();
  await until(() => existsSync(f.built));
  await assert.rejects(s.execution.dispatch('dispatch', task.id, task.rowVersion), { code: 'reload-in-progress' });
  await s.pulse();
  assert.deepEqual(s.resolved, []);
  assert.deepEqual(s.wakes, []);
  assert.equal(s.store.latestRun(task.id), null);
  assert.deepEqual(s.store.getTask(task.id), task);
  assert.deepEqual(s.store.heldRuns(), []);
  assert.equal(notice()?.attempts, 0);
  assert.equal(notice()?.state, 'pending');
  f.unmodified();
  cli.child.kill('SIGINT');
  assert.equal((await cli.result).code, 130);

  const run = await s.execution.dispatch('dispatch', task.id, task.rowVersion);
  assert.equal(run.sessionId, sessionId);
  assert.equal(s.store.heldRuns()[0]?.id, run.id);
  assert.equal((await s.execution.dispatch('dispatch', task.id, task.rowVersion)).id, run.id);
  await assert.rejects(s.execution.dispatch('second', other.task.id, other.task.rowVersion), { code: 'resource-conflict' });
  await s.pulse();
  assert.deepEqual(s.wakes, [sessionId, s.managerAgent.id]);
  assert.equal(notice()?.attempts, 1);
  const busy = await request(endpoint, 'claim', randomUUID());
  assert.equal(busy.state, 'busy');
  assert.ok(busy.blockers.some((text: string) => text.includes(run.id) && text.includes('resource held')));
  assert.ok(busy.blockers.some((text: string) => text.includes(s.managerAgent.id)));
  s.store.runRecovery(run.id, 'synthetic missing settlement');
  assert.equal(s.store.heldRuns()[0]?.id, run.id);
  assert.equal((await request(endpoint, 'claim', randomUUID())).state, 'busy');
});

test('Worker and Manager preflights already awaiting the host block a reload claim', async t => {
  const f = fixture(t);
  const s = scheduler(t, f.root);
  const { task, sessionId } = s.createTask('inflight');
  s.notify();
  const blocker = holdOperation();
  s.barriers.set(sessionId, blocker.promise);
  s.barriers.set(s.managerAgent.id, blocker.promise);
  const endpoint = await f.mount(hmrFixture(), s.admission, s.blockers).ready;
  const worker = s.execution.dispatch('dispatch', task.id, task.rowVersion);
  try {
    await s.pulse();
    assert.equal(s.resolved.length, 2);
    const busy = await request(endpoint, 'claim', randomUUID());
    assert.equal(busy.state, 'busy');
    assert.ok(busy.blockers.includes(`Worker task ${task.id} dispatch preflight`));
    assert.ok(busy.blockers.includes('Manager automatic notification preflight'));
    assert.equal(existsSync(f.built), false);
  } finally {
    blocker.release();
    await worker;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

test('native Manager jobs and queued input remain blockers after the model is idle', async t => {
  const f = fixture(t);
  const s = scheduler(t, f.root);
  const endpoint = await f.mount(hmrFixture(), s.admission, s.blockers).ready;
  const session = s.managerAgent.id;
  s.jobs.set(session, [{ owner: session, status: 'stopping', id: 'bash-fixture' }]);
  const busy = await request(endpoint, 'claim', randomUUID());
  assert.equal(busy.state, 'busy');
  assert.ok(busy.blockers.includes(`Manager session ${session}, job bash-fixture (stopping)`));
  s.jobs.clear();
  s.managerAgent.inbox.nextStep.push({} as never);
  assert.ok((await request(endpoint, 'claim', randomUUID())).blockers.includes(`Manager session ${session} (queued native input)`));
  s.managerAgent.inbox.nextStep.length = 0;
  assert.equal((await request(endpoint, 'claim', randomUUID())).state, 'granted');
  f.unmodified();
});
