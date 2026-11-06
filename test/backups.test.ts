import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { createLedgerBackup } from '../src/backups.ts';

test('schema 6 backups restore paused and upgrade to task configuration snapshots',()=>{
  const directory=mkdtempSync(join(tmpdir(),'super-bot-old-backup-'));
  try {
    const file=join(directory,'legacy.sqlite'),store=new Store(file);
    const bot=store.createBot('bot',{name:'Before config snapshots',instructions:'Preserved responsibility'});
    const task=store.createTask('task',{botId:bot.id,goal:'Preserved goal',scope:'Own files',acceptance:'Read result',reviewPolicy:'human'});store.close();
    const legacy=new DatabaseSync(file);legacy.exec('ALTER TABLE tasks DROP COLUMN botContext; ALTER TABLE tasks DROP COLUMN botConfigRevision; ALTER TABLE bots DROP COLUMN materials; PRAGMA user_version=6;');legacy.close();
    const destination=join(directory,'restored');const result=spawnSync(process.execPath,[resolve('scripts/restore-ledger.mjs'),file,destination],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const restored=new Store(join(destination,'ledger.sqlite'));try{assert.equal(restored.getTask(task.id).status,'recovery');assert.equal(restored.getTask(task.id).controlMode,'paused');assert.equal(restored.taskBotContext(task.id).instructions,'Preserved responsibility');}finally{restored.close();}
    const unchanged=new DatabaseSync(file,{readOnly:true});try{assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version,6);}finally{unchanged.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

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
