import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import {
  isLinkedCheckout, liveReloadEndpoints, profileSource, reloadArtifacts, reloadDirectory, reloadId, reloadProtocol, reloadStage,
  type ReloadEndpoint,
} from './dev-reload-paths.ts';
import type { ReloadAdmission } from './reload-admission.ts';
import type { Evidence, ReloadReceipt } from './model.ts';

type AppliedReload = Omit<ReloadReceipt, 'at'>;
type ReloadResult = { evidence: (id: string) => Evidence[]; record: (receipt: AppliedReload) => void };

interface Profile {
  name: string;
  dir: string;
  home: string;
  patchPath: string;
}

export interface ReloadHmr {
  config: { root: string[] };
  watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>;
  reconcileProfile(requiredIds: readonly string[]): Promise<{ restartReason?: string; pending?: readonly { reason: string }[] }>;
}

interface Handoff {
  id: string;
  from: string;
  root: string;
  retired: boolean;
  successor?: Promise<ReloadEndpoint>;
  record?: ReloadResult['record'];
  releaseSuccessor?: () => void;
}

type CommitResult = { state: string; blockers?: string[]; to?: string; pid?: number; build?: string; recordedResult?: boolean };

interface Lease {
  id: string;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  release: () => void;
  publishing: boolean;
  resultId?: string;
  commit?: { response: ServerResponse; finish: (result: CommitResult) => void };
}

// Cordis replaces the plugin module. Only the outgoing and incoming apply calls in
// the same process can complete this one-shot handoff. Process restarts lose it.
const handoffKey = Symbol.for('@zxdvd/super-bot/dev-reload-handoffs');
const processScope = globalThis as typeof globalThis & { [handoffKey]?: Map<string, Handoff> };

function verifyStagedResult(root: string, stage: string, files: Evidence[]): void {
  const bundled = new Map<string, string>();
  for (const name of ['index.js.map', 'client.js.map']) {
    const { sources, sourcesContent } = JSON.parse(readFileSync(join(stage, name), 'utf8')) as {
      sources: string[]; sourcesContent: (string | null)[];
    };
    sources.forEach((source, i) => {
      const content = sourcesContent[i];
      if (typeof content !== 'string') return;
      const path = resolve(root, 'lib', source), hash = createHash('sha256').update(content).digest('hex');
      const earlier = bundled.get(path);
      if (earlier && earlier !== hash) throw Error('Host and Client builds disagree on the source snapshot.');
      bundled.set(path, hash);
    });
  }
  const included = files.filter(file => bundled.has(file.path));
  if (!included.length || included.some(file => bundled.get(file.path) !== file.sha256)) {
    throw Error('Staged build does not match the selected result’s bundled source evidence.');
  }
}

function publishBuild(root: string, source: string, id: string, evidence: Evidence[] | undefined, beforeWrite: () => void): void {
  const stage = reloadStage(root, id);
  const lib = join(root, 'lib');
  for (const directory of [stage, lib]) {
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw Error('unsafe build directory');
  }
  for (const file of reloadArtifacts) {
    if (!lstatSync(join(stage, file)).isFile()) throw Error(`missing staged artifact ${file}`);
    const destination = join(lib, file);
    if (existsSync(destination) && !lstatSync(destination).isFile()) throw Error(`unsafe build destination ${file}`);
  }
  if (evidence) verifyStagedResult(source, stage, evidence);
  beforeWrite();
  // Same filesystem renames. Publish the host module last, after its client and maps.
  for (const file of reloadArtifacts) renameSync(join(stage, file), join(lib, file));
}

/** The profile and HMR services are supplied by the launcher in both supported DSH versions. */
export function startReloadHost(options: {
  profile: Profile;
  hmr: ReloadHmr;
  root: string;
  build: string;
  admission: ReloadAdmission;
  blockers: () => string[];
  checkLease?: (id: string) => string[];
  leaseMs?: number;
  reloadResult?: ReloadResult;
  log: (message: string) => void;
}) {
  const { profile, hmr, root, build, admission, blockers, log } = options;
  const dir = realpathSync(profile.dir);
  if (realpathSync(join(profile.home, 'profiles', profile.name)) !== dir
    || resolve(profile.patchPath) !== resolve(profile.dir, 'cordis.patch.yml')
    || !isLinkedCheckout(dir, root) || hmr.config.root.length !== 0) return;

  const handoffs = processScope[handoffKey] ??= new Map();
  const instance = randomUUID();
  const token = randomBytes(32).toString('hex');
  const directory = reloadDirectory(dir);
  const descriptor = join(directory, `${instance}.json`);
  const temporary = join(directory, `${instance}.tmp`);
  const trigger = join(directory, `${instance}.apply`);
  const granted = new Set<string>();
  let lease: Lease | undefined;
  let stopWatching: (() => Promise<void>) | undefined;
  let ownsTrigger = false;
  let closed = false;
  let outgoing: Handoff | undefined;

  const inspect = (id: string) => {
    try {
      const owners = liveReloadEndpoints(dir);
      if (owners.length !== 1 || owners[0]?.instance !== instance || !isLinkedCheckout(dir, root) || hmr.config.root.length !== 0) {
        throw Error('profile ownership or checkout link has changed');
      }
      const work = [...admission.blockers(), ...blockers(), ...(options.checkLease?.(id) ?? [])];
      return work.length ? { state: 'busy', blockers: work } : null;
    } catch (error) {
      return { state: 'unknown', blockers: [error instanceof Error ? error.message : 'host activity is unverifiable'] };
    }
  };
  function release(candidate: Lease, result: CommitResult = { state: 'expired-or-cancelled' }) {
    if (lease !== candidate) return;
    clearTimeout(candidate.timer);
    candidate.release();
    lease = undefined;
    candidate.commit?.finish(result);
  }
  function expireLease(candidate: Lease) {
    if (candidate.publishing) return;
    release(candidate, { state: 'expired-or-cancelled', blockers: ['permission expired before native HMR could publish'] });
  }
  function expire() {
    if (lease && Date.now() >= lease.expires) expireLease(lease);
  }
  async function commit(id: string, response: ServerResponse): Promise<CommitResult> {
    const candidate = lease;
    if (!candidate || candidate.id !== id) return { state: 'expired-or-cancelled' };
    if (candidate.commit) return { state: 'reserved', blockers: ['this permission already has a commit request'] };
    const disconnect = () => { if (!candidate.publishing) release(candidate); };
    response.once('close', disconnect);
    try {
      return await new Promise<CommitResult>(finish => {
        candidate.commit = { response, finish };
        // The listener itself may have been created in a native HMR transaction.
        // Queue through watchConfig so the application runs in a fresh native transaction.
        try { writeFileSync(trigger, id, { flag: 'r+' }); }
        catch (error) {
          release(candidate, { state: 'unavailable', blockers: [error instanceof Error ? error.message : 'could not signal native HMR'] });
        }
      });
    } finally { response.removeListener('close', disconnect); }
  }

  async function refresh(): Promise<void> {
    expire();
    const candidate = lease;
    if (closed || !candidate?.commit || candidate.publishing) return;
    if (candidate.commit.response.destroyed) { release(candidate); return; }
    let result: CommitResult;
    try {
      if (readFileSync(trigger, 'utf8') !== candidate.id) return;
      result = inspect(candidate.id) ?? await applyBuild(candidate);
    } catch (error) {
      result = { state: candidate.publishing ? 'unconfirmed' : 'unavailable',
        blockers: [error instanceof Error ? error.message : 'native HMR operation failed'] };
    }
    if (outgoing?.id === candidate.id) {
      outgoing.releaseSuccessor?.();
      if (handoffs.get(dir) === outgoing) handoffs.delete(dir);
      outgoing = undefined;
    }
    release(candidate, result);
  }

  async function applyBuild(candidate: Lease): Promise<CommitResult> {
    const { id, resultId } = candidate;
    let evidence: Evidence[] | undefined;
    if (resultId) {
      try { evidence = options.reloadResult!.evidence(resultId); }
      catch (cause) { return { state: 'unavailable', blockers: [cause instanceof Error ? cause.message : 'Result could not be checked'] }; }
    }
    publishBuild(root, profileSource(root, dir) ?? root, id, evidence, () => {
      candidate.publishing = true;
      clearTimeout(candidate.timer);
    });
    const handoff: Handoff = { id, from: instance, root, retired: false };
    outgoing = handoff;
    handoffs.set(dir, handoff);
    const native = await hmr.reconcileProfile(['super-bot']);
    if (native.restartReason) return { state: 'unconfirmed', blockers: [`native HMR reports ${native.restartReason}`] };
    if (!handoff.retired || !handoff.successor) {
      const reasons = native.pending?.map(item => item.reason) ?? [];
      return { state: 'unconfirmed', blockers: ['matching replacement did not mount',
        handoff.retired ? 'old instance retired' : 'old instance still mounted', ...new Set(reasons)] };
    }
    const successor = await handoff.successor;
    let recordedResult: boolean | undefined;
    if (resultId) {
      recordedResult = false;
      try {
        if (handoff.record) {
          handoff.record({ resultId, build: id, from: instance, to: successor.instance, pid: successor.pid });
          recordedResult = true;
        }
      } catch { log('The build applied, but its result receipt could not be recorded.'); }
    }
    return { state: 'applied', to: successor.instance, pid: successor.pid, build: id, recordedResult };
  }

  const server = createServer(async (request, response) => {
    const [, action, id, extra] = (request.url ?? '').split('/');
    const resultId = request.headers['x-super-bot-result'];
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`
      || request.headers['x-super-bot-instance'] !== instance || !id || !reloadId.test(id) || extra !== undefined
      || !['claim', 'cancel', 'commit'].includes(action ?? '')
      || (resultId !== undefined && (typeof resultId !== 'string' || !reloadId.test(resultId) || !options.reloadResult))) {
      response.writeHead(403).end();
      return;
    }
    const reply = (body: object) => {
      if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ ...body, dir, from: instance, id, resultId }));
    };
    expire();
    if (closed) { reply({ state: 'unavailable' }); return; }
    if (lease?.id === id && lease.resultId !== resultId) { reply({ state: 'unavailable' }); return; }
    if (action === 'commit') { reply(await commit(id, response)); return; }
    if (action === 'cancel') {
      if (lease?.id === id && !lease.publishing) release(lease);
      reply({ state: lease?.id === id ? 'publishing' : 'cancelled' });
      return;
    }
    if (lease) {
      if (lease.id === id && !lease.commit) reply({ state: 'granted', expires: lease.expires });
      else reply({ state: 'reserved', blockers: ['another protected reload holds admission'] });
      return;
    }
    if (granted.has(id)) { reply({ state: 'expired-or-cancelled' }); return; }
    const blocked = inspect(id);
    if (blocked) { reply(blocked); return; }
    if (handoffs.has(dir)) { reply({ state: 'reserved', blockers: ['native reload is still settling'] }); return; }
    const leaseMs = options.leaseMs ?? 120_000;
    const candidate: Lease = { id, resultId, expires: Date.now() + leaseMs, publishing: false,
      release: admission.pause(), timer: setTimeout(() => expireLease(candidate), leaseMs) };
    candidate.timer.unref();
    granted.add(id);
    lease = candidate;
    reply({ state: 'granted', expires: candidate.expires });
  });

  function closeWatcher(stop: () => Promise<void>) {
    // Native disposal can drain the refresh currently replacing this plugin.
    // Start closing the watcher without making Cordis teardown depend on that refresh.
    void stop().catch(() => log('Could not close the old development reload watcher.'));
  }

  function close() {
    if (closed) return;
    closed = true;
    if (lease && !lease.publishing) release(lease);
    if (stopWatching) closeWatcher(stopWatching);
    // A commit response can be on this very server. Do not await its closure during unload.
    server.close();
    if (ownsTrigger) {
      for (const path of [temporary, descriptor, trigger]) {
        try { rmSync(path, { force: true }); }
        catch { log('Could not remove old development reload metadata.'); }
      }
    }
  }

  const ready = (async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    liveReloadEndpoints(dir); // Validate the owner-only directory before writing into it.
    writeFileSync(trigger, '', { flag: 'wx', mode: 0o600 });
    ownsTrigger = true;
    const stop = await hmr.watchConfig(trigger, refresh);
    if (closed) {
      closeWatcher(stop);
      throw Error('reload watcher closed during startup');
    }
    stopWatching = stop;
    return await new Promise<ReloadEndpoint>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        try {
          const address = server.address();
          if (closed || !address || typeof address === 'string') {
            server.close();
            throw Error('reload listener closed during startup');
          }
          const endpoint = { protocol: reloadProtocol, profile: profile.name, dir, root, pid: process.pid,
            instance, port: address.port, token };
          writeFileSync(temporary, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 });
          renameSync(temporary, descriptor);
          resolve(endpoint);
        } catch (error) { reject(error); }
      });
      server.unref();
    });
  })();
  void ready.catch(error => { log(`Development reload unavailable: ${error.message}`); close(); });
  const handoff = handoffs.get(dir);
  if (handoff?.retired && handoff.from !== instance && handoff.id === build && handoff.root === root && !handoff.successor) {
    handoff.releaseSuccessor = admission.pause();
    handoff.successor = ready;
    handoff.record = options.reloadResult?.record;
  }
  return { ready, close, available: () => !closed && !!stopWatching, retired: () => { if (outgoing) outgoing.retired = true; } };
}
