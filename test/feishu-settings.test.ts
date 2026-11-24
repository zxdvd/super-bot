import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadFeishuSettings, saveFeishuSettings } from '../src/feishu-settings.ts';

const credentials = { appId: 'cli_fixture', appSecret: 'synthetic-secret', ownerOpenId: 'ou_fixtureOwner' };

function profile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-feishu-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('legacy owner migration and skipped tests carry no private test evidence', t => {
  const dir = profile(t);
  writeFileSync(join(dir, 'super-bot.feishu.json'), JSON.stringify(credentials), { mode: 0o600 });
  const loaded = loadFeishuSettings(dir, true);
  assert.equal(loaded.saved?.ownerOpenId, credentials.ownerOpenId);
  assert.equal(loaded.saved?.selfTestEvidence, undefined);
  assert.equal(loadFeishuSettings(dir, false).saved?.selfTestEvidence, undefined);
  saveFeishuSettings(dir, { ...credentials, ownerOpenId: undefined, enabled: true, selfTestSkipped: true });
  assert.equal(loadFeishuSettings(dir, false).saved?.selfTestSkipped, true);
  assert.equal(loadFeishuSettings(dir, false).saved?.selfTestEvidence, undefined);
});

test('confirmed private test evidence persists and is scoped to the exact app and owner', t => {
  const dir = profile(t);
  const evidence = { appId: credentials.appId, ownerOpenId: credentials.ownerOpenId, confirmedAt: 1795427300000 };
  saveFeishuSettings(dir, { ...credentials, enabled: true, selfTestEvidence: evidence });
  const saved = loadFeishuSettings(dir, false).saved;
  assert.deepEqual(saved?.selfTestEvidence, evidence);
  const safe = JSON.parse(readFileSync(join(dir, 'super-bot.json'), 'utf8'));
  assert.deepEqual(safe.feishu.selfTestEvidence, evidence);
  assert.equal(safe.feishu.credentialStatus, undefined);
  for (const mismatched of [{ appId: 'cli_other' }, { ownerOpenId: 'ou_other' }]) {
    saveFeishuSettings(dir, { ...credentials, enabled: true, selfTestEvidence: evidence, ...mismatched });
    const loaded = loadFeishuSettings(dir, false);
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.saved?.selfTestEvidence, undefined);
  }
});
