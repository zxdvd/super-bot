/** Fresh home/profile/ledger and deterministic host, with cleanup of only our child. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, open, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const root = resolve('.');
await mkdir(join(root, '.runtime'), { recursive: true });
const base = await mkdtemp(join(root, '.runtime/reliability-'));
const home = join(base, 'super-bot/.runtime/dsh'),
  osHome = join(base, 'os-home'),
  log = join(base, 'host.log');
await mkdir(home, { recursive: true });
await mkdir(osHome, { recursive: true });
// Deliberately do not inherit provider secrets, production dataDir, home, or profile.
const env = {
  PATH: process.env.PATH,
  HOME: osHome,
  DSH_HOME: home,
  LANG: 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
};
const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
async function run(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env, ...options });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, `command failed: ${args[0]}`);
}
await run(['scripts/build.mjs'], { stdio: 'inherit' });
await run(['scripts/build-probe.mjs'], { stdio: 'inherit' });
const init = await open(join(base, 'bootstrap.log'), 'w');
try {
  await run([cli, '--profile', 'reliability', '--from-default-profile', 'web', '--dump-config'], {
    stdio: ['ignore', init.fd, init.fd],
  });
} finally {
  await init.close();
}
const patch = join(base, 'host.patch.json');
await writeFile(
  patch,
  JSON.stringify([
    { id: 'hmr', disabled: true },
    {
      insert: [
        {
          id: 'super-bot',
          name: join(root, 'lib/index.js'),
          config: { fullAccess: process.env.SUPER_BOT_TEST_FULL_ACCESS === 'true' },
        },
        { id: 'super-bot-contract-probe', name: join(root, '.runtime/probe-plugin/index.js') },
      ],
    },
  ]),
);
let active;
async function launch() {
  const out = await open(log, 'w');
  const host = spawn(
    process.execPath,
    [cli, '--profile', 'reliability', '--patch', patch, '--no-open', '--port', '0'],
    { cwd: root, env, stdio: ['ignore', out.fd, out.fd] },
  );
  const state = { host, out, exited: false };
  state.exit = new Promise((resolve) =>
    host.once('exit', () => {
      state.exited = true;
      resolve();
    }),
  );
  active = state;
  for (let i = 0; i < 300; i++) {
    assert.equal(
      state.exited,
      false,
      `isolated host exited; see ${log} (contains local launch token, do not share raw)`,
    );
    if ((await readFile(log, 'utf8')).includes('dsh web:')) return;
    await delay(50);
  }
  throw Error('isolated host startup timed out');
}
async function stop(signal = 'SIGTERM') {
  const state = active;
  if (!state) return;
  if (!state.exited) state.host.kill(signal);
  const timer = setTimeout(() => {
    if (!state.exited) state.host.kill('SIGKILL');
  }, 5000);
  await state.exit;
  clearTimeout(timer);
  await state.out.close();
  active = undefined;
}
const scenario = async (name) =>
  run(['scripts/smoke-steering.mjs', name], {
    env: {
      ...env,
      SUPER_BOT_TEST_LOG: log,
      SUPER_BOT_TEST_FULL_ACCESS: process.env.SUPER_BOT_TEST_FULL_ACCESS ?? 'false',
    },
    stdio: 'inherit',
  });
try {
  await launch();
  await run(['scripts/smoke-notification-owner.mjs'], {
    env: { ...env, SUPER_BOT_TEST_LOG: log },
    stdio: 'inherit',
  });
  for (const name of ['steer', 'queue', 'normal', 'handoff', 'background', 'error', 'missing'])
    await scenario(name);
  await scenario('restart-prepare');
  await stop('SIGKILL');
  await rename(log, join(base, 'host-before-restart.log'));
  await launch();
  await scenario('restart-verify');
  for (const window of [
    'ready-before-end',
    'end-durable',
    'settled',
    'receipt-loss',
    'unknown-job',
    'pending-input',
  ]) {
    const crash = (phase) =>
      run(['scripts/smoke-run-recovery.mjs', phase, window], {
        env: { ...env, SUPER_BOT_TEST_LOG: log },
        stdio: 'inherit',
      });
    await crash('prepare');
    await stop('SIGKILL');
    await rename(log, join(base, `host-${window}-before.log`));
    await launch();
    await crash('verify');
    await stop('SIGKILL');
    await rename(log, join(base, `host-${window}-first-recovery.log`));
    await launch();
    await crash('verify');
  }
  console.log(
    `PASS all isolated reliability scenarios; fullAccess=${process.env.SUPER_BOT_TEST_FULL_ACCESS === 'true'}; evidence: ${base}`,
  );
} finally {
  await stop();
}
