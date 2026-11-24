// Two isolated, real launchers. The Desktop child is the installed Electron app's actual Host entry.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, open, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { authenticateHost } from './host-client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = resolve(process.argv[2] ?? join(root, '.runtime', `mirror-${randomUUID().slice(0, 8)}`));
assert.ok(base.startsWith(join(root, '.runtime') + '/'));
await mkdir(base, { mode: 0o700 });
assert.equal(await realpath(base), base);
const cli = process.env.SUPER_BOT_TEST_WEB_ENTRY ?? join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const electron = process.env.SUPER_BOT_TEST_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const desktopRuntime = process.env.SUPER_BOT_TEST_DESKTOP_RUNTIME ?? resolve(electron, '../../Resources/app.asar/dsh');
const desktopHost = join(desktopRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const skipHmr = process.env.SUPER_BOT_TEST_SKIP_HMR === '1';
const pairs = join(base, 'pair');
await mkdir(pairs, { mode: 0o700 });
const shellHome = join(base, 'os');
await mkdir(shellHome);
const tmp = join(base, 'tmp');
await mkdir(tmp);
const roles = Object.fromEntries(['web', 'desktop'].map(role => {
  const home = join(base, role, 'super-bot/.runtime/dsh');
  return [role, { role, home, profile: join(home, 'profiles', role), data: join(home, 'super-bot') }];
}));
const secret = randomBytes(32).toString('hex');
const pairConfig = { key: secret,
  ...Object.fromEntries(Object.entries(roles).map(([role, { profile, data }]) => [role, { profileDir: profile, dataDir: data }])),
};
await writeFile(join(pairs, 'pair.json'), JSON.stringify(pairConfig), { mode: 0o600 });

const bundle = join(base, 'bundle');
await mkdir(join(bundle, 'lib'), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.exports['./mirror-probe'] = './lib/probe.js';
await writeFile(join(bundle, 'package.json'), JSON.stringify(manifest));
await mkdir(join(bundle, 'node_modules'));
await symlink(join(root, 'node_modules/marked'), join(bundle, 'node_modules/marked'));
await copyFile(join(root, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml'));
const commonBuild = { bundle: true, platform: 'node', format: 'esm', packages: 'external', absWorkingDir: root };
await build({ ...commonBuild, entryPoints: ['test/host-probe.ts'], outfile: join(bundle, 'lib/probe.js') });
const prebuilt = process.env.SUPER_BOT_TEST_BUILD_DIR;
if (prebuilt) {
  for (const name of ['index.js', 'index.js.map', 'client.js', 'client.js.map']) {
    await copyFile(join(prebuilt, name), join(bundle, 'lib', name));
  }
} else {
  const built = spawn(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SUPER_BOT_BUILD_OUTDIR: join(bundle, 'lib') },
  });
  assert.equal(await new Promise((resolve, reject) => { built.once('error', reject); built.once('exit', resolve); }), 0);
}

async function configure(role, { bundleDir = bundle, ...options } = {}) {
  const { profile, data } = roles[role];
  await mkdir(join(profile, 'node_modules/@zxdvd'), { recursive: true });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await symlink(bundleDir, join(profile, 'node_modules/@zxdvd/super-bot'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-${role}`, private: true, dependencies: { '@zxdvd/super-bot': `link:${bundleDir}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zxdvd/super-bot'] } },
  }));
  await patch(role, options);
}
async function patch(role, { paired = false, mirrorDir = pairs, hmr = !skipHmr, limit = 2, probeModule = '@zxdvd/super-bot/mirror-probe', data = roles[role].data } = {}) {
  const { profile } = roles[role];
  const path = join(profile, 'cordis.patch.yml');
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify([
    ...(hmr ? [] : [{ id: 'hmr', disabled: true }]),
    { id: 'super-bot', config: { dataDir: data, fullAccess: false, maxRunningTasks: limit, ...(paired ? { mirrorDir } : {}) } },
    { insert: [{ id: 'super-bot-contract-probe', name: probeModule }] },
  ]));
  await rename(temp, path);
}

const children = new Map();
async function launch(role, generation) {
  const { home, profile } = roles[role];
  const env = { PATH: process.env.PATH, HOME: shellHome, TMPDIR: tmp, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  const logPath = join(base, `${role}-${generation}.log`);
  const log = await open(logPath, 'wx', 0o600);
  const desktop = role === 'desktop';
  const child = spawn(desktop ? electron : process.execPath, desktop
    ? ['--expose-internals', desktopHost, desktopRuntime, profile, join(base, 'desktop-primary')]
    : [cli, '--profile', role, '--no-open', '--port', '0'], {
    cwd: desktop ? profile : root, env: desktop ? { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_CLIENT_VERSION: '0.2.2-rc.5' } : env,
    stdio: ['ignore', log.fd, log.fd, ...(desktop ? ['ipc'] : [])],
  });
  let announcement;
  child.on('message', message => { if (message.type === 'ready') announcement = message; });
  const state = { child, log, exited: false, error: undefined };
  state.exit = new Promise(resolve => {
    child.on('error', error => { state.error = error; });
    child.once('close', (code, signal) => { state.exited = true; resolve({ code, signal }); });
  });
  children.set(role, state);
  const url = await wait(async () => {
    assert.ok(!state.error && !state.exited, `Isolated ${role} failed to start. See ${logPath}`);
    return desktop ? announcement?.url : (await readFile(logPath, 'utf8')).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1];
  }, `${role} native ready`, 300);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const client = await authenticateHost(url);
  return { ...client, launchUrl: url, pid: child.pid, logPath, injections: announcement?.injections };
}

async function stop(role, abrupt = false) {
  const state = children.get(role);
  if (!state) return;
  if (!state.exited) {
    if (abrupt) state.child.kill('SIGKILL');
    else if (state.child.connected) state.child.send({ type: 'shutdown' });
    else state.child.kill('SIGTERM');
  }
  const timer = setTimeout(() => { if (!state.exited) state.child.kill('SIGKILL'); }, 5000);
  await state.exit;
  clearTimeout(timer);
  await state.log.close();
  children.delete(role);
}

async function wait(query, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const value = await query();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}

async function rpc(host, action, payload = {}) {
  const response = await host.post('/api/super-bot', { type: 'client-request', rpcId: randomUUID(), method: 'super-bot',
    payload: { ...payload, action } });
  assert.equal(response.status, 200, `owner HTTP route ${action} at ${host.base}; see ${host.logPath}`);
  return (await response.json()).result;
}
async function call(host, action, payload) {
  const result = await rpc(host, action, payload);
  assert.ok(result.ok, `${action}: ${JSON.stringify(result)}`);
  return result.value;
}
async function makeBot(host, name) {
  const bot = await call(host, 'bot.create', { requestId: randomUUID(), name, instructions: 'Synthetic local mirror test' });
  const manager = await call(host, 'manager.prepare', { requestId: randomUUID(), botId: bot.id });
  assert.ok(manager.sessionId);
  assert.equal((await call(host, 'bot.for-session', { sessionId: manager.sessionId })).id, bot.id);
  return { ...bot, managerId: manager.sessionId };
}

const rolesUnderTest = ['web', 'desktop'];
const owners = { web: 'desktop', desktop: 'web' };
async function verifyClient(role, host, candidate) {
  let boot;
  if (role === 'desktop') boot = host.injections.find(row => row.name === '__DSH_BOOT__')?.value;
  else {
    const response = await host.get('/');
    assert.equal(response.status, 200);
    const html = await response.text();
    const match = html.match(/globalThis\["__DSH_BOOT__"\] = (\{[^<]+\})<\/script>/);
    assert.ok(match, 'native Web index includes the client graph');
    boot = JSON.parse(match[1]);
  }
  const entry = boot?.entries.find(row => row.id === '@zxdvd/super-bot');
  assert.ok(entry, `${role} lists the Super Bot client in the native boot graph`);
  const path = new URL(entry.url, host.base);
  assert.equal(path.origin, host.base);
  const asset = await host.get(path.pathname + path.search);
  assert.equal(asset.status, 200);
  const script = await asset.text();
  assert.match(script, /mirror\.catalog/);
  if (candidate) {
    // DSH's single-resource combo appends a separator and rewrites the debug trailer.
    const executable = text => text.replace(/\/\/# source(?:Mapping)?URL=[^\r\n]*(?:\r?\n)?$/, '').replace(/\n;\n$/, '\n');
    assert.ok(executable(script) === executable(candidate), `${role} serves the candidate client executable`);
  }
  return entry.rev;
}
const ledger = role => join(roles[role].data, 'ledger.sqlite');
const dbIdentity = async role => { const { ino, dev } = await stat(ledger(role)); return { ino, dev }; };
const endpoint = async role => JSON.parse(await readFile(join(pairs, `${role}.json`), 'utf8'));
async function replaceEndpoint(role, value) {
  const filename = join(pairs, `${role}.json`), temp = `${filename}.test`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temp, filename);
}
const ownerEnvelope = (action, payload = {}) => ({ type: 'client-request', rpcId: randomUUID(), method: 'super-bot',
  payload: { action, ...payload } });
const probe = async (host, action, sessionId, text) => {
  const res = await host.post('/api/super-bot-probe', { action, sessionId, text });
  const body = await res.json();
  assert.equal(body.ok, true, `native ${action} at ${host.base}: ${JSON.stringify(body)}`);
  return body;
};
async function newTask(host, bot, goal) {
  return call(host, 'task.create', { requestId: randomUUID(), botId: bot.id, goal, scope: 'LOCAL_SCOPE_SAMPLE',
    acceptance: 'LOCAL_ACCEPTANCE_SAMPLE', reviewPolicy: 'human', startPaused: true });
}
async function chatWork(host, bot) {
  await probe(host, 'select-test-model', bot.managerId);
  await probe(host, 'native-prompt', bot.managerId, 'MIRROR_PROGRESS_PROBE');
  const task = await wait(async () => (await call(host, 'task.list', { botId: bot.id, q: 'MIRROR_PROGRESS_PROBE' })).items
    .find(item => item.lifecycle === 'review' && item.managerReviewed), 'native chat task, Worker and Manager review');
  const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
  assert.equal(detail.run.state, 'settled');
  assert.equal(detail.result.humanAcceptedAt, null);
  assert.equal(detail.result.evidence.length, 1);
  const session = await wait(async () => {
    const current = await probe(host, 'inspect-session', bot.managerId);
    return current.status === 'idle' && current.assistantTexts.some(text => text.includes('等待你确认')) && current;
  }, 'persisted reply in the original native chat');
  assert.ok(session.executedTools.includes('super_bot_manage'));
  return detail;
}
const catalog = host => call(host, 'mirror.catalog');
const list = (host, owner, botId, extra = {}) => call(host, 'mirror.tasks', { owner, botId, ...extra });
const detail = (host, owner, botId, id) => call(host, 'mirror.detail', { owner, botId, id });
const remoteActions = ['manager.prepare', 'manager.replace', 'bot.create', 'bot.update', 'bot.delete', 'task.create',
  'task.dispatch', 'task.stop', 'task.control', 'task.revise', 'task.cancel', 'task.delete', 'attention.respond',
  'result.accept', 'result.reject', 'session.attach', 'session.detach', 'run.recover-and-continue', 'backup.create', 'workdir.cleanup'];
const route = '/super-bot-mirror/v1/query';
const mac = (key, ...parts) => createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify([route, ...parts])).digest('hex');
const pairPaths = rolesUnderTest.flatMap(role => [roles[role].profile, roles[role].data]);
const pairIdentity = mac(secret, 'pair', ...pairPaths);

async function restrictedTransport(role, taskId) {
  const { id, port } = await endpoint(role);
  const peer = owners[role];
  function make(body, { from = peer, to = id, key = secret, identity = pairIdentity, at = Date.now() } = {}) {
    const text = JSON.stringify(body), nonce = randomUUID();
    return { text, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text),
      'x-sb-from': from, 'x-sb-to': to, 'x-sb-nonce': nonce, 'x-sb-at': at,
      'x-sb-proof': mac(key, identity, 'read', from, role, to, nonce, at, text) } };
  }
  function send(message, { method = 'POST', path = route, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, signal: AbortSignal.timeout(3000),
        headers: { ...message.headers, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on('error', reject);
      req.end(message.text);
    });
  }
  const read = { op: 'catalog' };
  for (const options of [{ headers: { 'x-sb-proof': '' } }, { headers: { origin: 'https://other.example' } },
    { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { cookie: 'owner=untrusted' } },
    { headers: { host: `localhost:${port}` } }]) {
    assert.equal((await send(make(read), options)).status, 403);
  }
  for (const options of [{ from: role }, { to: randomUUID() }, { key: randomBytes(32).toString('hex') },
    { identity: mac(secret, 'pair', ...pairPaths.map(path => `${path}-wrong-profile`)) }, { at: Date.now() - 10000 }]) {
    assert.equal((await send(make(read, options))).status, 403);
  }
  const good = make(read);
  const response = await send(good);
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-sb-proof'], mac(secret, pairIdentity, 'reply', role, peer, id, good.headers['x-sb-nonce'], response.text));
  assert.equal((await send(good)).status, 403, 'authenticated replay refused');
  for (const options of [{ path: `${route}?url=https://other.example` }, { path: '/api/super-bot' },
    { path: '/api/super-bot-file' }, { path: `http://127.0.0.1:${port}${route}` }, { method: 'PUT' }]) {
    assert.equal((await send(make(read), options)).status, 404);
  }
  for (const body of [{ op: 'catalog', url: 'http://127.0.0.1:3080' }, { op: 'detail', botId: taskId, id: taskId, path: 'result.md' },
    { op: 'tasks', botId: taskId, limit: 26 }, { method: 'super-bot', payload: { action: 'task.stop', id: taskId } },
    ...remoteActions.map(op => ({ op, id: taskId }))]) {
    assert.deepEqual(JSON.parse((await send(make(body))).text), { ok: false, code: 'invalid-input' });
  }
  console.log(`${role} peer listener: unauthenticated, wrong key/role/profile/instance, replay, cross-site, URL/RPC, attachments and writes denied`);
}

const files = {};
try {
  if (process.env.SUPER_BOT_TEST_RESULT_ATTACHMENTS === '1') {
    assert.ok(prebuilt, 'Pass SUPER_BOT_TEST_BUILD_DIR from the isolated build');
    const { smokeResultAttachments } = await import('./smoke-result-attachments.mjs');
    await smokeResultAttachments({ root, base, bundle, ledger, configure, patch, launch, stop, rpc, call, makeBot, probe, wait, verifyClient });
  } else if (process.env.SUPER_BOT_TEST_WORK_ACTIVITY === '1') {
    const { smokeWorkActivity } = await import('./smoke-work-activity.mjs');
    await smokeWorkActivity({ configure, launch, call, makeBot, probe, wait });
  } else if (process.env.SUPER_BOT_TEST_CHAT_LINKS === '1') {
    const { smokeChatResultLinks } = await import('./smoke-chat-result-links.mjs');
    await smokeChatResultLinks({ base, configure, launch, stop, rpc, call, makeBot, probe, wait });
  } else if (process.env.SUPER_BOT_TEST_DEVELOPER_RELOAD === '1') {
    const { smokeDeveloperReload } = await import('./smoke-developer-reload.mjs');
    await smokeDeveloperReload({ root, base, bundle, roles, configure, launch, rpc, call, makeBot, newTask, probe, wait });
  } else await smokeMirror();
} finally {
  await Promise.all([...children.keys()].map(role => stop(role)));
}

async function smokeMirror() {
  if (process.env.SUPER_BOT_TEST_BOT_MEMORY === '1') {
    assert.ok(prebuilt, 'Pass SUPER_BOT_TEST_BUILD_DIR from the isolated build');
    const { smokeBotMemory } = await import('./smoke-bot-memory.mjs');
    const data = Object.fromEntries(rolesUnderTest.map(role => [role, roles[role].data]));
    return smokeBotMemory({ base, bundle, data, configure, launch, rpc, call, makeBot, probe, wait, verifyClient });
  }
  await Promise.all(rolesUnderTest.map(role => configure(role, { hmr: false })));
  const hosts = {}, oldBots = {}, oldTasks = {}, identities = {}, newBots = {}, work = {}, proof = {};
  for (const role of rolesUnderTest) {
    hosts[role] = await launch(role, 'existing');
    const local = hosts[role];
    assert.deepEqual(await catalog(local), { owner: role, peer: owners[role], state: 'disabled', bots: [] });
    assert.equal((await rpc(local, 'mirror.tasks', { owner: owners[role], botId: randomUUID() })).error?.code, 'mirror-unverified');
    await assert.rejects(endpoint(role), { code: 'ENOENT' });
    oldBots[role] = await makeBot(local, '同名 Bot');
    oldTasks[role] = await newTask(local, oldBots[role], `PAIR_DISABLED_${role}`);
    identities[role] = await dbIdentity(role);
  }
  await Promise.all(rolesUnderTest.map(role => stop(role)));
  await Promise.all(rolesUnderTest.map(role => patch(role, { paired: true })));
  hosts.web = await launch('web', 'paired');
  assert.equal((await catalog(hosts.web)).state, 'offline');
  const initialWeb = await call(hosts.web, 'bot.list');
  assert.deepEqual(initialWeb.map(bot => [bot.id, bot.managerSessionId]), [[oldBots.web.id, oldBots.web.managerId]]);
  hosts.desktop = await launch('desktop', 'paired');
  for (const role of rolesUnderTest) {
    const local = hosts[role], peer = owners[role], remote = hosts[peer];
    const saved = oldBots[role];
    assert.deepEqual(await catalog(remote), { owner: peer, peer: role, state: 'online', bots: [{ id: saved.id, name: '同名 Bot' }] });
    assert.equal((await call(local, 'bot.for-session', { sessionId: saved.managerId })).id, saved.id);
    assert.equal((await call(local, 'manager.prepare', { requestId: randomUUID(), botId: saved.id })).sessionId, saved.managerId);
    assert.equal((await list(remote, role, saved.id)).items[0].id, oldTasks[role].id);
    assert.equal((await detail(remote, role, saved.id, oldTasks[role].id)).task.acceptance, 'LOCAL_ACCEPTANCE_SAMPLE');
    await call(local, 'task.revise', { requestId: randomUUID(), id: oldTasks[role].id, expectedRowVersion: oldTasks[role].rowVersion,
      goal: `LOCAL_EDIT_${role}`, scope: 'LOCAL_SCOPE_SAMPLE', acceptance: 'LOCAL_ACCEPTANCE_SAMPLE' });
    assert.equal((await list(remote, role, saved.id, { q: 'LOCAL_EDIT_', lifecycle: 'open', limit: 1 })).items[0].goal, `LOCAL_EDIT_${role}`);
  }
  for (const role of rolesUnderTest) {
    const local = hosts[role];
    newBots[role] = await makeBot(local, '同名 Bot');
    await chatWork(local, oldBots[role]);
    work[role] = await chatWork(local, newBots[role]);
  }
  for (const role of rolesUnderTest) {
    const local = hosts[role], peer = owners[role], remote = hosts[peer], bot = newBots[role], task = work[role].task, result = work[role].result;
    const catalogAtPeer = await catalog(remote);
    assert.deepEqual(catalogAtPeer.bots, [oldBots[role], bot].map(({ id, name }) => ({ id, name })));
    assert.ok((await call(remote, 'bot.list')).every(b => b.id !== bot.id));
    assert.equal(await call(remote, 'bot.for-session', { sessionId: bot.managerId }), null);
    for (const sessionId of [bot.managerId, work[role].binding.sessionId]) {
      assert.deepEqual(await call(local, 'session.origin', { sessionId }), { owner: role, local: true });
      assert.deepEqual(await call(remote, 'session.origin', { sessionId }), { owner: role, local: false });
    }
    assert.equal(await call(remote, 'session.origin', { sessionId: `session-${randomUUID()}` }), null);
    assert.equal((await rpc(remote, 'session.origin', { sessionId: bot.managerId, owner: role })).error?.code, 'invalid-input');
    const page = await list(remote, role, bot.id, { lifecycle: 'review', q: 'PROGRESS', limit: 1, offset: 0 });
    assert.equal(page.total, 1); assert.equal(page.counts.review, 1); assert.equal(page.items[0].id, task.id);
    assert.equal((await list(remote, role, bot.id, { limit: 1, offset: 1 })).items.length, 0);
    assert.equal((await rpc(remote, 'mirror.detail', { owner: role, botId: oldBots[role].id, id: task.id })).error?.code, 'not-found');
    const mirrored = await detail(remote, role, bot.id, task.id);
    assert.equal(mirrored.task.lifecycle, 'review');
    assert.equal(mirrored.run.id, work[role].run.id);
    assert.equal(mirrored.result.id, result.id);
    assert.equal(mirrored.result.humanAcceptedAt, null);
    assert.equal(mirrored.result.fileCount, 1);
    assert.equal(mirrored.result.checks, result.checks);
    assert.ok(mirrored.records.reviews.some(review => review.actor === 'bot' && review.verdict === 'human' && review.resultId === result.id));
    assert.ok(mirrored.events.some(event => event.report?.kind === 'progress' && event.report.summary === 'MIRROR_NATIVE_PROGRESS'));
    assert.equal(mirrored.progress.worker.summary, 'MIRROR_NATIVE_PROGRESS');
    assert.equal(mirrored.progress.worker.runId, work[role].run.id);
    assert.equal(typeof mirrored.progress.worker.at, 'number');
    assert.equal(typeof mirrored.progress.inputEnteredAt, 'number');
    assert.equal(mirrored.progress.acceptance, null);
    assert.equal(mirrored.progress.reload, null);
    assert.ok(mirrored.events.some(event => event.kind === 'run.settled'));
    for (const privateField of [bot.managerId, work[role].binding.sessionId, work[role].binding.cwd, '"evidence"',
      '"source"', '"messageJson"', '"botContext"', '"workdirRequest"']) assert.ok(!JSON.stringify(mirrored).includes(privateField));
    const filePath = `/api/super-bot-file?resultId=${result.id}&index=0`;
    assert.match(await (await local.get(filePath)).text(), /事实一/);
    assert.equal((await remote.get(filePath)).status, 404);
    const evidenceFile = work[role].result.evidence[0].path;
    assert.ok(evidenceFile.startsWith(`${base}/`));
    const original = await readFile(evidenceFile);
    await writeFile(evidenceFile, 'Synthetic changed bytes');
    const retained = await local.get(filePath);
    assert.equal(retained.status, 200);
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()), original);
    assert.equal((await detail(remote, role, bot.id, task.id)).result.fileCount, 1);
    await writeFile(evidenceFile, original);
    const localBefore = await call(local, 'task.detail', { id: task.id });
    for (const action of remoteActions) {
      const payload = { requestId: randomUUID(), owner: role, id: task.id, botId: bot.id, resultId: result.id,
        expectedRowVersion: task.rowVersion, name: 'invalid', instructions: 'invalid' };
      assert.equal((await rpc(remote, action, payload)).ok, false, action);
    }
    assert.equal((await rpc(remote, 'manager.prepare', { requestId: randomUUID(), botId: bot.id })).ok, false);
    assert.equal((await rpc(remote, 'task.detail', { id: task.id })).error?.code, 'not-found');
    assert.equal((await rpc(remote, 'mirror.tasks', { owner: peer, botId: bot.id })).error?.code, 'invalid-input');
    assert.equal((await rpc(remote, 'mirror.detail', { owner: role, botId: bot.id, id: task.id, url: local.base })).error?.code, 'invalid-input');
    for (const envelope of [ownerEnvelope('mirror.catalog'), { ...ownerEnvelope('session.origin'),
      payload: { action: 'session.origin', sessionId: bot.managerId } }]) {
      assert.notEqual((await fetch(`${local.base}/api/super-bot`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })).status, 200);
      assert.notEqual((await local.post('/api/super-bot', envelope, { origin: 'https://other.example' })).status, 200);
    }
    await restrictedTransport(role, task.id);
    const active = await endpoint(role);
    try {
      await replaceEndpoint(role, { ...active, id: randomUUID() });
      const unavailable = await catalog(remote);
      assert.deepEqual({ ...unavailable, reason: undefined }, { owner: peer, peer: role, state: 'unverified', bots: [], reason: undefined });
      assert.match(unavailable.reason, /不匹配/);
    } finally { await replaceEndpoint(role, active); }
    const localAfter = await call(local, 'task.detail', { id: task.id });
    assert.equal(localAfter.task.rowVersion, localBefore.task.rowVersion);
    assert.equal(localAfter.result.humanAcceptedAt, null);
    assert.equal(localAfter.run.id, localBefore.run.id);
    const accepted = await call(local, 'result.accept', { id: task.id, requestId: randomUUID(), resultId: result.id,
      sessionId: bot.managerId, expectedRowVersion: localAfter.task.rowVersion });
    assert.equal(accepted.lifecycle, 'completed');
    const confirmed = await detail(remote, role, bot.id, task.id);
    assert.ok(confirmed.result.humanAcceptedAt);
    assert.deepEqual(confirmed.progress.acceptance, { actor: 'user', at: confirmed.result.humanAcceptedAt });
    assert.ok(confirmed.records.reviews.some(review => review.actor === 'user' && review.verdict === 'accepted'));
    assert.ok(confirmed.events.some(event => event.kind === 'result.accepted'));
    proof[role] = { legacy: oldBots[role].id, bot: bot.id, task: task.id, run: confirmed.run.id, result: result.id,
      acceptance: confirmed.result.humanAcceptedAt, actualRuntime: (await call(local, 'status')).runtime,
      clientRevision: await verifyClient(role, local) };
  }
  console.log('Both real owners reopened existing ledgers, used native deterministic chat and tools, accepted locally, and mirrored progress/results/reviews');

  roles.wrong = { home: roles.web.home, profile: join(roles.web.home, 'profiles', 'wrong'), data: roles.web.data };
  await configure('wrong', { paired: true, hmr: false });
  const wrong = await launch('wrong', 'rejected');
  assert.notEqual((await wrong.post('/api/super-bot', ownerEnvelope('bot.list'))).status, 200);
  assert.match(await readFile(wrong.logPath, 'utf8'), /此账本已绑定原宿主 profile/);
  await stop('wrong');

  const pairFile = join(pairs, 'pair.json');
  const originalPair = await readFile(pairFile);
  assert.equal(await realpath(pairFile), pairFile);
  await chmod(pairFile, 0o644);
  try {
    for (const role of rolesUnderTest) {
      const host = hosts[role], view = await catalog(host);
      assert.equal(view.state, 'unverified'); assert.deepEqual(view.bots, []); assert.match(view.reason, /权限/);
      assert.equal(await call(host, 'session.origin', { sessionId: newBots[owners[role]].managerId }), null);
      await newTask(host, oldBots[role], `LOCAL_WHILE_PAIR_DENIED_${role}`);
    }
  } finally { await chmod(pairFile, 0o600); }
  for (const role of rolesUnderTest) assert.equal((await catalog(hosts[role])).state, 'online');

  await stop('web');
  const missingPair = join(base, 'missing-pair');
  await mkdir(missingPair, { mode: 0o700 });
  const wrongPair = join(base, 'mismatched-pair');
  await mkdir(wrongPair, { mode: 0o700 });
  await writeFile(join(wrongPair, 'pair.json'), JSON.stringify({ ...pairConfig, web: pairConfig.desktop }), { mode: 0o600 });
  const restrictedPair = join(base, 'restricted-pair');
  await mkdir(restrictedPair, { mode: 0o700 });
  await writeFile(join(restrictedPair, 'pair.json'), originalPair, { mode: 0o644 });
  for (const [name, mirrorDir, reason] of [['missing', missingPair, /找不到/], ['wrong-pair', wrongPair, /不匹配/],
    ['permissions', restrictedPair, /权限/]]) {
    await patch('web', { paired: true, mirrorDir, hmr: false });
    const local = await launch('web', name), view = await catalog(local);
    assert.equal(view.state, 'unverified'); assert.deepEqual(view.bots, []); assert.match(view.reason, reason);
    assert.equal((await call(local, 'status')).mirrorIssue, view.reason);
    assert.deepEqual(await call(local, 'session.origin', { sessionId: oldBots.web.managerId }), { owner: 'web', local: true });
    assert.equal((await call(local, 'bot.list')).length, 2);
    await newTask(local, oldBots.web, `LOCAL_STARTUP_${name}`);
    assert.deepEqual(await dbIdentity('web'), identities.web);
    await stop('web');
  }
  await patch('web', { paired: true });
  hosts.web = await launch('web', 'pair-restored');
  console.log('Marked ledger remained writable with missing, non-private or mismatched pairing; runtime permission revocation stopped only mirror reads');
  for (const role of rolesUnderTest) {
    const active = await endpoint(role);
    const openers = execFileSync('lsof', ['-t', ledger(role)], { encoding: 'utf8' }).trim().split(/\s+/);
    assert.deepEqual([...new Set(openers)], [String(hosts[role].pid)]);
    assert.deepEqual(await dbIdentity(role), identities[role]);
    if (skipHmr) continue;
    await patch(role, { paired: true, limit: 3 });
    const refreshed = await wait(async () => {
      try { const next = await endpoint(role); return next.id !== active.id && next; } catch { return; }
    }, `${role} native profile HMR`);
    assert.equal(refreshed.pid, active.pid);
    assert.equal((await call(hosts[role], 'bot.for-session', { sessionId: oldBots[role].managerId })).id, oldBots[role].id);
    const remote = hosts[owners[role]];
    assert.equal((await detail(remote, role, proof[role].bot, proof[role].task)).result.humanAcceptedAt, proof[role].acceptance);
    proof[role].hmr = { pid: active.pid, before: active.id, after: refreshed.id };
  }
  const oldDesktopPort = new URL(hosts.desktop.base).port, stale = await endpoint('desktop');
  await stop('desktop', true);
  assert.deepEqual(await endpoint('desktop'), stale, 'forced exit leaves the old descriptor');
  assert.deepEqual(await catalog(hosts.web), { owner: 'web', peer: 'desktop', state: 'offline', bots: [] });
  assert.equal((await rpc(hosts.web, 'mirror.detail', { owner: 'desktop', botId: proof.desktop.bot, id: proof.desktop.task })).error?.code,
    'mirror-offline');
  const duringOffline = await newTask(hosts.web, oldBots.web, 'LOCAL_WHILE_DESKTOP_OFFLINE');
  hosts.desktop = await launch('desktop', 'reconnected');
  assert.notEqual(new URL(hosts.desktop.base).port, oldDesktopPort);
  assert.notEqual((await endpoint('desktop')).id, stale.id);
  assert.equal((await detail(hosts.desktop, 'web', oldBots.web.id, duringOffline.id)).task.id, duringOffline.id);
  await stop('web');
  assert.deepEqual(await catalog(hosts.desktop), { owner: 'desktop', peer: 'web', state: 'offline', bots: [] });
  await assert.rejects(endpoint('web'), { code: 'ENOENT' });
  const desktopOffline = await newTask(hosts.desktop, oldBots.desktop, 'LOCAL_WHILE_WEB_OFFLINE');
  hosts.web = await launch('web', 'reconnected');
  assert.equal((await detail(hosts.web, 'desktop', oldBots.desktop.id, desktopOffline.id)).task.id, desktopOffline.id);
  for (const role of rolesUnderTest) {
    const remote = hosts[owners[role]], expected = proof[role], owner = hosts[role];
    assert.equal((await call(owner, 'bot.for-session', { sessionId: oldBots[role].managerId })).id, oldBots[role].id);
    const actual = await detail(remote, role, expected.bot, expected.task);
    assert.equal(actual.run.id, expected.run);
    assert.equal(actual.result.id, expected.result);
    assert.equal(actual.result.humanAcceptedAt, expected.acceptance);
    assert.equal((await list(remote, role, expected.bot)).total, 1);
    assert.deepEqual(await dbIdentity(role), identities[role]);
    files[role] = { ...expected, ledger: identities[role], reconnectPort: new URL(owner.base).port };
  }
  files.desktop.previousPort = oldDesktopPort;
  await writeFile(join(base, 'proof.json'), JSON.stringify(files, null, 2));
  console.log(`PASS ${skipHmr ? '' : 'native HMR and '}exit/reconnect both ways; Desktop carrier ${oldDesktopPort} → ${files.desktop.reconnectPort}; proof ${base}/proof.json`);
}
