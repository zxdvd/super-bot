import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { bindMirror } from '../../src/mirror-host.ts';

function fixture(t: TestContext) {
  const runtime = join(realpathSync(process.cwd()), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const root = mkdtempSync(join(runtime, 'mirror-owner-'));
  t.after(() => {
    assert.equal(realpathSync(root), root);
    assert.ok(root.startsWith(join(runtime, 'mirror-owner-')));
    rmSync(root, { recursive: true, force: true });
  });
  const profile = { name: 'web', dir: join(root, 'web') };
  const data = join(root, 'data'), pair = join(root, 'pair'), mark = join(data, '.mirror-owner.json');
  const config = { key: randomBytes(32).toString('hex'), web: { profileDir: profile.dir, dataDir: data },
    desktop: { profileDir: join(root, 'desktop'), dataDir: join(root, 'desktop-data') } };
  for (const dir of [profile.dir, data, pair, config.desktop.profileDir, config.desktop.dataDir]) mkdirSync(dir, { mode: 0o700 });
  const writePair = (value: unknown) => writeFileSync(join(pair, 'pair.json'), JSON.stringify(value), { mode: 0o600 });
  const open = (directory?: string) => bindMirror(data, 'web', profile, directory);
  return { profile, data, pair, mark, config, writePair, open };
}

test('an unverified local ledger refuses broken pairing and unsafe owner metadata', t => {
  const f = fixture(t);
  assert.deepEqual(f.open(), {}, 'legacy standalone mode can start without a pair');
  assert.throws(() => f.open(f.pair), { code: 'mirror-owner', message: /找不到/ });
  f.writePair({ ...f.config, web: f.config.desktop });
  assert.throws(() => f.open(f.pair), { code: 'mirror-owner', message: /未能证明/ });
  f.writePair(f.config);
  assert.ok(f.open(f.pair).pair);
  assert.throws(() => bindMirror(f.data, 'desktop', { ...f.profile, dir: f.config.desktop.profileDir }),
    { code: 'mirror-owner', message: /创建端/ });
  chmodSync(f.mark, 0o644);
  assert.throws(() => f.open(f.pair), { code: 'mirror-owner', message: /归属标记/ });
});

test('a validated local owner is preserved when optional pairing is broken, and an aliased ledger is refused', t => {
  const f = fixture(t);
  f.writePair({ ...f.config, key: 'invalid' });
  assert.match(f.open(f.pair).issue!, /密钥格式/);
  assert.deepEqual(f.open(), {});
  f.writePair({ ...f.config, web: f.config.desktop });
  assert.match(f.open(f.pair).issue!, /本端.*不匹配/);
  assert.match(f.open(join(f.pair, 'missing')).issue!, /找不到/);
  const file = join(f.pair, 'pair.json');
  f.writePair(f.config);
  const bound = f.open(f.pair).pair!;
  chmodSync(file, 0o644);
  assert.throws(() => bound.verify(), { code: 'mirror-unverified', message: /权限/ });
  assert.match(f.open(f.pair).issue!, /权限/);
  chmodSync(file, 0o600);
  f.writePair({ ...f.config, key: randomBytes(32).toString('hex') });
  assert.throws(() => bound.verify(), { code: 'mirror-unverified', message: /变更/ });
  symlinkSync(join(f.config.desktop.dataDir, 'ledger.sqlite'), join(f.data, 'ledger.sqlite'));
  assert.throws(() => f.open(), { code: 'mirror-owner', message: /独立/ });
});
