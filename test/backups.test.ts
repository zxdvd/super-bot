import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.ts';
import { createLedgerBackup } from '../src/backups.ts';

test('consistent ledger backup survives later writes and restores without overwriting original data',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'super-bot-backup-'));const store=new Store(join(directory,'ledger.sqlite'));
  try {
    const bot=store.createBot('first',{name:'Original bot',instructions:'Synthetic fixture'});
    const task=store.createTask('task',{botId:bot.id,goal:'Backup pending task',scope:'synthetic files',acceptance:'read file',reviewPolicy:'human'});
    const [first,duplicate]=await Promise.all([createLedgerBackup(store,directory,'backup'),createLedgerBackup(store,directory,'backup')]);
    assert.deepEqual(first,duplicate);assert.equal(first.counts.bots,1);assert.equal(statSync(first.path).mode&0o777,0o600);
    store.createBot('second',{name:'Later bot',instructions:'Not in first snapshot'});
    assert.deepEqual(await createLedgerBackup(store,directory,'backup'),first);
    const restoredDirectory=join(directory,'restored');
    const restore=spawnSync(process.execPath,[resolve('scripts/restore-ledger.mjs'),first.path,restoredDirectory],{encoding:'utf8'});
    assert.equal(restore.status,0,restore.stderr);
    const restored=new Store(join(restoredDirectory,'ledger.sqlite'));try{
      assert.equal(restored.listBots().length,1);assert.equal(restored.getTask(task.id).controlMode,'paused');assert.equal(restored.getTask(task.id).status,'recovery');
      assert.equal(restored.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state='pending'").get()?.n,0);
      const reviewed=restored.resolveRunRecovery('confirm',task.id,restored.getTask(task.id).rowVersion);assert.equal(reviewed.controlMode,'paused');assert.equal(reviewed.status,'paused');
    }finally{restored.close();}
    assert.equal(store.listBots().length,2);
    const overwrite=spawnSync(process.execPath,[resolve('scripts/restore-ledger.mjs'),first.path,restoredDirectory],{encoding:'utf8'});
    assert.notEqual(overwrite.status,0);assert.equal(store.listBots().length,2);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='ledger.backup'").get()?.n,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
