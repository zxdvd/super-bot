import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developerSettings } from '../../src/developer-reload.ts';
import { profilePackage, profileSource } from '../../src/dev-reload-paths.ts';
import { loadFeishuSettings, saveFeishuSettings } from '../../src/feishu-settings.ts';

test('developer setting belongs to one profile, coexists with imported Feishu credentials, and never authorizes a shared build', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'super-bot-settings-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  function host(name: string) {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    return { name, dir, home };
  }
  const web = host('web'), desktop = host('desktop');
  const settings = developerSettings(web, home, '', () => undefined);
  const other = developerSettings(desktop, home, '', () => undefined);
  const file = join(web.dir, 'super-bot.json');
  const reload = () => settings('developer.reload', { requestId: randomUUID() });
  assert.equal((await settings('developer.get', {})).enabled, false);
  await assert.rejects(reload, { code: 'disabled' });
  writeFileSync(file, '{"theme":"custom"}', { mode: 0o600 });
  const credentials = { appId: 'cli_fixture', appSecret: 'fixture-secret', ownerOpenId: 'ou_' + 'a'.repeat(32) };
  writeFileSync(join(web.dir, 'super-bot.feishu.json'), JSON.stringify(credentials), { mode: 0o600 });
  await settings('developer.save', { enabled: true });
  const { saved } = loadFeishuSettings(web.dir, true);
  assert.equal(saved?.ownerOpenId, credentials.ownerOpenId);
  saveFeishuSettings(web.dir, { ...credentials, enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'custom', developerMode: true, feishu: { ...credentials, enabled: false } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await other('developer.get', {})).enabled, false);
  await assert.rejects(reload, { code: 'unavailable' });
  await assert.rejects(() => settings('developer.save', { enabled: false, dir: desktop.dir }), { code: 'invalid-input' });
  const target = profilePackage(home, web.dir);
  assert.equal(profileSource(target, web.dir), home);
  assert.equal(profileSource(target, desktop.dir), undefined);
  assert.equal((await settings('developer.save', { enabled: false })).enabled, false);
});
