/** Authenticated smoke probe for the dedicated test host; never prints its launch token. */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const log = await readFile(process.argv[2] ?? '.runtime/host.log', 'utf8');
const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
assert.ok(match, 'dedicated host has not announced a URL');
const base = new URL(match[1]).origin;
const command = { type: 'client-request', rpcId: 'smoke-status', method: 'super-bot', payload: { action: 'status' } };
const unauthenticated = await fetch(base + '/api/super-bot', { method: 'POST',
  headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(command) });
assert.equal(unauthenticated.status, 401, 'unauthenticated requests must be refused');
const cookies = new Map();
let url = match[1];
for (let redirects = 0; redirects < 5; redirects++) {
  const response = await fetch(url, { redirect: 'manual', headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') } });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';'); const index = pair.indexOf('=');
    cookies.set(pair.slice(0,index), pair.slice(index+1));
  }
  if (!response.headers.has('location')) break;
  url = new URL(response.headers.get('location'), url).href;
}
const response = await fetch(base + '/api/super-bot', { method: 'POST', headers: {
  cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), origin: base, 'content-type': 'application/json',
}, body: JSON.stringify(command) });
assert.equal(response.status, 200, 'Super Bot status endpoint must be available');
const result = await response.json();
assert.equal(result.result.ok, true, 'status command succeeds');
assert.equal(result.result.value.product, 'Super Bot');
assert.equal(result.result.value.journalMode, 'wal');
const crossOrigin = await fetch(base + '/api/super-bot', { method: 'POST', headers: {
  cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), origin: 'https://untrusted.example', 'content-type': 'application/json',
}, body: JSON.stringify(command) });
assert.equal(crossOrigin.status, 403, 'cross-origin requests must be refused');
console.log(JSON.stringify({ status: 'pass', runtime: result.result.value.runtime, sqlite: result.result.value.sqliteVersion, journalMode: result.result.value.journalMode }));
