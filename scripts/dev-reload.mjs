/** Ask the current Super Bot instance before staging a development build. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { liveReloadEndpoints, reloadId, reloadStage } from '../src/dev-reload-paths.ts';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const profile = process.env.SUPER_BOT_PROFILE ?? process.env.DSH_PROFILE ?? 'web';
const id = randomUUID();
const stage = reloadStage(root, id);
const cancellation = new AbortController();
const stop = () => cancellation.abort(Error('cancelled by signal'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let endpoint;
let building = false;
let commitRequested = false;
let requested = false;
let resultId;

async function call(action, signal) {
  const address = `http://127.0.0.1:${endpoint.port}/${action}/${id}`;
  const response = await fetch(address, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${endpoint.token}`, 'x-super-bot-instance': endpoint.instance,
      ...(resultId ? { 'x-super-bot-result': resultId } : {}) },
  }).catch(error => { throw Error(`${action}: live host disconnected or request timed out`, { cause: error }); });
  if (!response.ok) throw Error(`${action}: live host refused the protocol (${response.status})`);
  const reply = await response.json();
  if (reply.from !== endpoint.instance || reply.id !== id || reply.dir !== endpoint.dir) {
    throw Error(`${action}: reply does not identify the selected live instance and profile`);
  }
  return reply;
}

function build(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/build.mjs')], {
      cwd: root, stdio: 'inherit', signal,
      env: { ...process.env, SUPER_BOT_BUILD_OUTDIR: stage, SUPER_BOT_RELOAD_BUILD_ID: id },
    });
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (code, killedBy) => {
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0) reject(failure ?? Error(`build failed (${code ?? killedBy})`));
      else resolve();
    });
  });
}

const limited = (ms, signal = cancellation.signal) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

try {
  const args = process.argv.slice(2);
  let wait = 0;
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2);
    if (flag === '--wait' && !wait && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 120) {
      wait = Number(value);
    } else if (flag === '--result' && !resultId && reloadId.test(value ?? '')) {
      resultId = value;
    } else throw Error('Usage: npm run dev:reload -- [--wait 1-120] [--result RESULT_ID]');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw Error('invalid profile name');
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dir = realpathSync(join(home, 'profiles', profile));
  const [owner, ...others] = liveReloadEndpoints(dir);
  if (!owner || others.length || owner.profile !== profile || owner.root !== root) {
    throw Error('live reload host unavailable or ambiguous for this profile/checkout. Use the existing install entry point for first enablement.');
  }
  endpoint = owner;
  const deadline = Date.now() + wait * 1000;
  let lease;
  let waitingFor;
  for (;;) {
    const remaining = deadline - Date.now();
    if (waitingFor && remaining <= 0) throw Error(`wait expired (${waitingFor})`);
    requested = true;
    lease = await call('claim', limited(wait ? Math.min(5000, Math.max(1, remaining)) : 5000));
    if (lease.state === 'granted') {
      if (resultId && lease.resultId !== resultId) throw Error('live host does not support result attribution');
      break;
    }
    const blockers = (lease.blockers ?? []).join('; ');
    const status = `${lease.state}${blockers ? `: ${blockers}` : ''}`;
    if (!wait || !['busy', 'reserved'].includes(lease.state)) throw Error(status);
    if (status !== waitingFor) console.log(`Waiting for ${profile}: ${status}`);
    waitingFor = status;
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal: cancellation.signal });
  }
  if (!Number.isSafeInteger(lease.expires) || lease.expires <= Date.now()) throw Error('invalid or expired permission');
  console.log(`Granted by ${profile} instance ${owner.instance}; building staged artifacts.`);
  const leaseSignal = limited(lease.expires - Date.now());
  leaseSignal.throwIfAborted();
  mkdirSync(join(root, '.runtime'), { recursive: true, mode: 0o700 });
  if (realpathSync(join(root, '.runtime')) !== join(root, '.runtime')) throw Error('build staging directory is a symlink');
  mkdirSync(stage, { mode: 0o700 });
  building = true;
  await build(leaseSignal);
  leaseSignal.throwIfAborted();
  commitRequested = true;
  console.log(`Waiting for ${profile} to publish and confirm the new instance (${id}).`);
  const reply = await call('commit', limited(150_000));
  if (reply.state !== 'applied') {
    commitRequested = reply.state === 'unconfirmed';
    throw Error(`${reply.state}${reply.blockers?.length ? `: ${reply.blockers.join('; ')}` : ''}`);
  }
  if (!reloadId.test(reply.to) || reply.to === owner.instance || reply.build !== id || reply.pid !== owner.pid) {
    throw Error('reload receipt does not match the expected successor');
  }
  console.log(`Applied ${profile} build ${id} in the same host (PID ${reply.pid}), instance ${owner.instance} → ${reply.to}.`);
  if (resultId) {
    if (reply.resultId === resultId && reply.recordedResult === true) console.log(`Recorded the reload receipt for result ${resultId}.`);
    else console.warn(`The build applied, but its receipt for result ${resultId} was not recorded.`);
  }
} catch (error) {
  const state = cancellation.signal.aborted ? 'cancelled' : 'stopped';
  const reason = cancellation.signal.aborted ? cancellation.signal.reason.message : error.message;
  console.error(`dev:reload ${state} (${profile}): ${reason}${commitRequested ? ' Check native HMR logs and the active instance before retrying.' : ''}`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
} finally {
  if (endpoint && requested && process.exitCode) {
    await call('cancel', AbortSignal.timeout(1000)).catch(() => {});
  }
  if (building && existsSync(stage) && realpathSync(stage) === stage) rmSync(stage, { force: true, recursive: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
