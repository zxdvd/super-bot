import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError, optionalText, requiredText } from './model.ts';
import { managedSessionId, oppositeOwner, type BotOwner } from './mirror.ts';

const host = '127.0.0.1';
const route = '/super-bot-mirror/v1/query';
const timeout = 2000;
const maxQueryBytes = 4096;
const maxReplyBytes = 4 * 1024 * 1024;
const token = /^[a-f0-9]{64}$/;
const instanceId = /^[a-f0-9-]{36}$/;
const error = (code: 'mirror-offline' | 'mirror-unverified', reason?: string) => new AppError(code, reason ?? (
  code === 'mirror-offline' ? '来源端离线，暂时无法读取。' : '暂时无法核对来源端的配对或查询结果。'));
const pairMismatch = () => error('mirror-unverified', '两端配对身份、密钥或宿主实例不匹配。');

interface Profile { name: string; dir: string }
interface Member { profileDir: string; dataDir: string }
interface Pair { directory: string; owner: BotOwner; key: string; identity: string; verify: () => void }
interface MirrorBinding { pair?: Pair; issue?: string }
interface Endpoint { id: string; pid: number; port: number }
export type MirrorQuery = { op: 'catalog' }
  | { op: 'tasks'; botId: string; q: string; lifecycle: string; offset: number; limit: number }
  | { op: 'detail'; botId: string; id: string }
  | { op: 'session-origin'; sessionId: string };

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT';

function privateJson(path: string): JsonRecord {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 8192) {
      throw Object.assign(Error('Unsafe mirror file'), { code: 'EACCES' });
    }
    const bytes = Buffer.alloc(8193);
    const size = readSync(fd, bytes);
    if (size > 8192) throw Error('Oversize mirror file');
    return record(JSON.parse(bytes.toString('utf8', 0, size)));
  } finally { closeSync(fd); }
}

function member(value: unknown): Member {
  const { profileDir, dataDir } = record(value);
  for (const path of [profileDir, dataDir]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw pairMismatch();
    try {
      if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw pairMismatch();
    } catch (cause) { if (!missing(cause)) throw cause; }
  }
  return { profileDir: profileDir as string, dataDir: dataDir as string };
}

function pairingConfig(directory: string): JsonRecord {
  try {
    if (!isAbsolute(directory) || !process.getuid) throw error('mirror-unverified', '配对目录必须是本机私有绝对路径。');
    const info = lstatSync(directory);
    if (realpathSync(directory) !== directory || !info.isDirectory() || info.uid !== process.getuid()
      || (info.mode & 0o077) !== 0) throw error('mirror-unverified', '配对目录权限或归属不符。');
    return privateJson(join(directory, 'pair.json'));
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    throw error('mirror-unverified', code === 'ENOENT' ? '找不到配对目录或 pair.json。'
      : code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' ? 'pair.json 或配对目录的读取权限不符。'
        : '配对文件无法读取或格式无效。');
  }
}

function pairIdentity(config: JsonRecord, owner: BotOwner, local: Member): { key: string; identity: string } {
  const configured = record(config[owner]);
  if (configured.profileDir !== local.profileDir || configured.dataDir !== local.dataDir) {
    throw error('mirror-unverified', '配对配置中的本端 profile 或账本目录不匹配。');
  }
  const peer = member(config[oppositeOwner(owner)]);
  const key = config.key;
  if (typeof key !== 'string' || !token.test(key)) throw error('mirror-unverified', '配对密钥格式无效。');
  if (local.profileDir === peer.profileDir || local.dataDir === peer.dataDir) throw pairMismatch();
  const [web, desktop] = owner === 'web' ? [local, peer] : [peer, local];
  return { key, identity: sign(key, ['pair', web.profileDir, web.dataDir, desktop.profileDir, desktop.dataDir]) };
}

function ownerMarker(path: string): JsonRecord | undefined {
  try { return privateJson(path); }
  catch (cause) {
    if (!missing(cause)) throw new AppError('mirror-owner', '无法核实本地账本归属标记，请检查文件和权限。');
  }
}

function requireLocalOwner(existing: JsonRecord | undefined, owner: BotOwner, profileDir: string): void {
  if (!existing || existing.owner !== owner || existing.profileDir !== profileDir) {
    throw new AppError('mirror-owner', '此账本已绑定原宿主 profile，请在创建端打开。');
  }
}

function independentLedger(dataDir: string): void {
  try {
    const db = lstatSync(join(dataDir, 'ledger.sqlite'));
    if (!db.isFile() || db.nlink !== 1) throw Error('Mirrored ledger must be an independent file');
  } catch (cause) {
    if (!missing(cause)) throw new AppError('mirror-owner', '无法确认此文件为独立的本地账本，请检查账本路径和权限。');
  }
}

/** An existing local owner mark takes precedence over optional pairing configuration. */
export function bindMirror(dataDir: string, owner: BotOwner, profile: Profile | undefined, directory?: string): MirrorBinding {
  const mark = join(dataDir, '.mirror-owner.json');
  const existing = ownerMarker(mark);
  if (!existing && directory === undefined) {
    independentLedger(dataDir);
    return {}; // Legacy unpaired local startup.
  }
  let local: Member;
  try {
    if (!profile) throw Error('Missing profile');
    local = { profileDir: realpathSync(profile.dir), dataDir: realpathSync(dataDir) };
    if (!lstatSync(local.profileDir).isDirectory() || !lstatSync(local.dataDir).isDirectory()) throw Error('Invalid local path');
  } catch { throw new AppError('mirror-owner', '无法核实本地 profile 和账本目录，未打开账本。'); }
  if (existing) requireLocalOwner(existing, owner, local.profileDir);
  independentLedger(local.dataDir);
  if (directory === undefined) return {};

  let config: JsonRecord;
  try { config = pairingConfig(directory); }
  catch (cause) {
    const issue = (cause as AppError).message;
    if (!existing) throw new AppError('mirror-owner', `本地账本归属尚未确认。${issue}`);
    return { issue };
  }
  if (!existing) {
    const configured = record(config[owner]);
    const other = record(config[oppositeOwner(owner)]);
    if (configured.profileDir !== local.profileDir || configured.dataDir !== local.dataDir
      || other.profileDir === local.profileDir || other.dataDir === local.dataDir) {
      throw new AppError('mirror-owner', '配对配置未能证明本地账本归属，未打开账本。');
    }
    const temp = `${mark}.${randomUUID()}`;
    try {
      writeFileSync(temp, JSON.stringify({ owner, profileDir: local.profileDir }), { mode: 0o600, flag: 'wx' });
      try { linkSync(temp, mark); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
      finally { unlinkSync(temp); }
    } catch { throw new AppError('mirror-owner', '未能建立并核实本地账本归属标记。'); }
    requireLocalOwner(ownerMarker(mark), owner, local.profileDir);
  }
  try {
    const { key, identity } = pairIdentity(config, owner, local);
    const verify = () => {
      if (pairIdentity(pairingConfig(directory), owner, local).identity !== identity) {
        throw error('mirror-unverified', '配对配置已变更，需重新加载宿主镜像。');
      }
    };
    return { pair: { directory, owner, key, identity, verify } };
  } catch (cause) {
    return { issue: cause instanceof AppError ? cause.message : '无法核实来源端的配对目录或权限。' };
  }
}

export function parseMirrorQuery(value: unknown): MirrorQuery {
  const fields = record(value);
  const keys = { catalog: ['op'], tasks: ['op', 'botId', 'q', 'lifecycle', 'offset', 'limit'],
    detail: ['op', 'botId', 'id'], 'session-origin': ['op', 'sessionId'] } as const;
  const { op } = fields;
  const invalid = () => new AppError('invalid-input', '镜像只允许指定的只读查询。');
  if (op !== 'catalog' && op !== 'tasks' && op !== 'detail' && op !== 'session-origin') throw invalid();
  if (Object.keys(fields).some(key => !(keys[op] as readonly string[]).includes(key))) throw invalid();
  if (op === 'catalog') return { op };
  if (op === 'session-origin') {
    if (typeof fields.sessionId !== 'string' || !managedSessionId.test(fields.sessionId)) throw invalid();
    return { op, sessionId: fields.sessionId };
  }
  const botId = requiredText(fields.botId, 'Bot 标识', 200);
  if (op === 'detail') return { op, botId, id: requiredText(fields.id, '任务标识', 200) };
  const offset = fields.offset ?? 0, limit = fields.limit ?? 25;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw invalid();
  const q = optionalText(fields.q, '搜索', 200), lifecycle = optionalText(fields.lifecycle, '状态', 30);
  if (!['', 'open', 'review', 'completed', 'cancelled'].includes(lifecycle)) throw invalid();
  return { op, botId, q, lifecycle, offset, limit };
}

function sign(key: string, parts: unknown[]): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify([route, ...parts])).digest('hex');
}
function matches(header: unknown, expected: string) {
  return typeof header === 'string' && token.test(header) && timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(expected, 'hex'));
}
async function readBounded(message: IncomingMessage, max: number) {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const bytes of message) {
    size += bytes.length;
    if (size > max) throw Error('Oversize mirror message');
    buffers.push(bytes);
  }
  return Buffer.concat(buffers).toString('utf8');
}
function send(response: ServerResponse, status: number, body = '', proof?: string) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(proof ? { 'x-sb-proof': proof } : {}), Connection: 'close' });
  response.end(body);
}

export async function startMirror(pair: Pair, query: (value: MirrorQuery) => unknown) {
  const { owner, key, identity, directory } = pair, peer = oppositeOwner(owner), id = randomUUID();
  const configurationIssue = () => {
    try { pair.verify(); }
    catch (cause) { return cause instanceof AppError ? cause.message : '无法核实配对目录或权限。'; }
  };
  const proofFor = (...parts: unknown[]) => sign(key, [identity, ...parts]);
  const filename = join(directory, `${owner}.json`), peerFilename = join(directory, `${peer}.json`);
  const recent = new Map<string, number>();
  const outgoing = new AbortController();
  let port = 0;
  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.socket.remoteAddress !== host || req.headers.host !== `${host}:${port}` || req.headers.origin !== undefined
      || req.headers['sec-fetch-site'] !== undefined || req.headers.cookie !== undefined) return send(res, 403);
    if (req.method !== 'POST' || req.url !== route || req.headers['content-type'] !== 'application/json') return send(res, 404);
    const from = req.headers['x-sb-from'], to = req.headers['x-sb-to'], nonce = req.headers['x-sb-nonce'];
    const timestamp = Number(req.headers['x-sb-at']), now = Date.now();
    if (from !== peer || to !== id || typeof nonce !== 'string' || !instanceId.test(nonce)
      || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > timeout || !req.headers['x-sb-proof']) return send(res, 403);
    const body = await readBounded(req, maxQueryBytes);
    if (outgoing.signal.aborted || !matches(req.headers['x-sb-proof'], proofFor('read', from, owner, to, nonce, timestamp, body))
      || configurationIssue()) {
      return send(res, 403);
    }
    for (const [seen, until] of recent) if (until < now) recent.delete(seen);
    if (recent.has(nonce) || recent.size >= 1024) return send(res, 403);
    recent.set(nonce, timestamp + timeout);
    let result;
    try { result = { ok: true, value: query(parseMirrorQuery(JSON.parse(body))) }; }
    catch (cause) { result = { ok: false, code: cause instanceof AppError ? cause.code : 'invalid-input' }; }
    const response = JSON.stringify(result);
    if (Buffer.byteLength(response) > maxReplyBytes) return send(res, 413);
    send(res, 200, response, proofFor('reply', owner, from, to, nonce, response));
  }
  const server = createServer((req, res) => {
    const timer = setTimeout(() => req.destroy(), timeout);
    void serve(req, res).catch(() => { if (!res.headersSent) send(res, 400); }).finally(() => clearTimeout(timer));
  });
  server.maxConnections = 32;
  server.setTimeout(timeout, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  const temp = `${filename}.${id}`;
  try {
    writeFileSync(temp, JSON.stringify({ id, pid: process.pid, port } satisfies Endpoint), { mode: 0o600, flag: 'wx' });
    try { renameSync(temp, filename); } catch (cause) { unlinkSync(temp); throw cause; }
  } catch (cause) { server.close(); throw cause; }

  async function read(value: MirrorQuery): Promise<unknown> {
    const issue = configurationIssue();
    if (issue) throw error('mirror-unverified', issue);
    let endpoint: Endpoint;
    try {
      const raw = privateJson(peerFilename);
      if (typeof raw.id !== 'string' || !instanceId.test(raw.id) || typeof raw.pid !== 'number'
        || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || typeof raw.port !== 'number'
        || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) throw Error('Invalid mirror endpoint');
      endpoint = { id: raw.id, pid: raw.pid, port: raw.port };
      process.kill(endpoint.pid, 0);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') throw error('mirror-offline');
      throw error('mirror-unverified', '来源端的镜像端点身份或读取权限不符。');
    }
    const nonce = randomUUID(), timestamp = Date.now(), body = JSON.stringify(value);
    const [response, proof] = await new Promise<[string, unknown]>((resolve, reject) => {
      const req = request({ hostname: host, port: endpoint.port, path: route, method: 'POST', agent: false,
        signal: AbortSignal.any([AbortSignal.timeout(timeout), outgoing.signal]), headers: {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-sb-from': owner, 'x-sb-to': endpoint.id,
          'x-sb-nonce': nonce, 'x-sb-at': timestamp, 'x-sb-proof': proofFor('read', owner, peer, endpoint.id, nonce, timestamp, body),
        } }, res => {
        if (res.statusCode !== 200) { res.destroy(); reject(res.statusCode === 403 ? pairMismatch() : error('mirror-unverified')); return; }
        void readBounded(res, maxReplyBytes).then(text => resolve([text, res.headers['x-sb-proof']]),
          () => reject(error('mirror-unverified')));
      });
      req.on('error', (cause: NodeJS.ErrnoException) =>
        reject(error(cause.code === 'ECONNREFUSED' ? 'mirror-offline' : 'mirror-unverified')));
      req.end(body);
    });
    const changed = configurationIssue();
    if (changed) throw error('mirror-unverified', changed);
    if (!matches(proof, proofFor('reply', peer, owner, endpoint.id, nonce, response))) throw pairMismatch();
    const result = record(JSON.parse(response));
    if (result.ok === true) return result.value;
    if (result.code === 'not-found') throw new AppError('not-found', '来源端没有此 Bot 或任务。');
    if (result.code === 'invalid-input') throw new AppError('invalid-input', '来源端拒绝了查询参数。');
    throw error('mirror-unverified');
  }

  return { read, configurationIssue, close: async () => {
    outgoing.abort();
    // Retire the descriptor before releasing the local ledger. A forced exit leaves a dead PID.
    try { if (privateJson(filename).id === id) unlinkSync(filename); } catch { /* Already retired or unavailable. */ }
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  } };
}
