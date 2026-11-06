import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import version from '../schema-version.json' with {type:'json'};

function oldLedger(file:string) {
  const db=new DatabaseSync(file);
  db.exec(readFileSync(new URL('./fixtures/schema-v2.sql',import.meta.url),'utf8'));
  db.exec("INSERT INTO bots VALUES ('bot','Old Bot','Synthetic responsibility',1,NULL,1); INSERT INTO tasks VALUES ('task','bot','Existing goal','Own files','Read result','human','open','auto',1,1,NULL,1,1); INSERT INTO inputs VALUES ('input','task','goal','Existing goal','accepted',1);");
  db.close();
}
function assertOld(file:string) {
  const db=new DatabaseSync(file);try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,2);
    assert.equal(db.prepare('SELECT goal FROM tasks WHERE id=?').get('task')?.goal,'Existing goal');
    assert.equal(db.prepare('PRAGMA table_info(inputs)').all().some(column=>column.name==='messageId'),false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='bindings'").get()?.n,0);
  }finally{db.close();}
}
function assertUpgraded(file:string) {
  const store=new Store(file);try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,version);
    assert.equal(store.getTask('task').goal,'Existing goal');assert.equal(store.getBot('bot').name,'Old Bot');
    assert.equal(store.db.prepare('SELECT messageId,attentionId FROM inputs WHERE id=?').get('input')?.messageId,null);
    const binding=store.beginBinding('prepare','task',1,'/tmp/synthetic-upgraded-task');
    store.confirmBinding(binding.id,binding.requestedSessionId);
    assert.equal(store.reserveRun('run','task',store.getTask('task').rowVersion).state,'queued');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
  }finally{store.close();}
}

test('a frozen version 2 ledger upgrades with old responsibility and inputs preserved',()=>{
  const dir=mkdtempSync(join(tmpdir(),'super-bot-migrate-'));try {const file=join(dir,'ledger.sqlite');oldLedger(file);assertOld(file);assertUpgraded(file);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('migration failure rolls back new tables and version, leaving old data repairable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'super-bot-migrate-'));try {
    const file=join(dir,'ledger.sqlite');oldLedger(file);
    const corrupt=new DatabaseSync(file);corrupt.exec('CREATE VIEW managers AS SELECT 1 AS botId');corrupt.close();
    assert.throws(()=>new Store(file),/view|index/i);assertOld(file);
    const repair=new DatabaseSync(file);repair.exec('DROP VIEW managers');repair.close();assertUpgraded(file);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('process loss during an uncommitted migration cannot expose half-upgraded state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'super-bot-migrate-'));let child:ReturnType<typeof spawn>|undefined;
  try {
    const file=join(dir,'ledger.sqlite');oldLedger(file);
    child=spawn(process.execPath,['--input-type=module','-e',`
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; ALTER TABLE inputs ADD COLUMN messageId TEXT; CREATE TABLE interrupted_migration(value TEXT); PRAGMA user_version=${version};');
      process.send('migration-uncommitted');setInterval(()=>{},1000);
    `,file],{stdio:['ignore','ignore','pipe','ipc']});
    const exited=once(child,'exit');
    const timer=setTimeout(()=>child?.kill('SIGKILL'),10000);timer.unref();
    try {
      const signal=await Promise.race([once(child,'message').then(([message])=>message),exited.then(()=>{throw new Error('migration child exited before checkpoint');})]);
      assert.equal(signal,'migration-uncommitted');child.kill('SIGKILL');await exited;
    }finally{clearTimeout(timer);}
    assertOld(file);assertUpgraded(file);
  }finally{child?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
