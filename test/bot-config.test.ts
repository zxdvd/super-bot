import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.ts';

test('Bot updates preserve task snapshots, revoke old Manager authority, and survive reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'super-bot-config-')),file=join(dir,'ledger.sqlite'),path=join(dir,'reference.md');let store=new Store(file);
  const material=(text:string)=>({path,text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
  try {
    const input={name:'Bot',instructions:'Original responsibility',referencePaths:[path]};
    const bot=store.createBot('bot',input,[material('ORIGINAL_REFERENCE')]);
    const oldManager=store.beginManager('manager',bot.id,join(dir,'manager'));store.confirmManager(oldManager.id,oldManager.requestedSessionId);
    const task=store.createTask('task',{botId:bot.id,goal:'Original task',scope:'Own directory',acceptance:'Original criterion',reviewPolicy:'human',startPaused:true});
    const next={...input,name:'Updated Bot',instructions:'New responsibility'};
    const updated=store.updateBot('update',bot.id,1,next,[material('NEW_REFERENCE')]);
    assert.equal(updated.configRevision,2);assert.equal(updated.managerSessionId,null);assert.equal(store.managerForSession(oldManager.requestedSessionId),null);
    assert.equal(store.getTask(task.id).botConfigRevision,1);assert.equal(store.taskBotContext(task.id).instructions,'Original responsibility');assert.equal(store.taskBotContext(task.id).materials[0]?.text,'ORIGINAL_REFERENCE');
    assert.equal(JSON.stringify(store.listBots()).includes('NEW_REFERENCE'),false);assert.equal(JSON.stringify(store.listTasks({botId:bot.id})).includes('ORIGINAL_REFERENCE'),false);
    const later=store.createTask('later',{botId:bot.id,goal:'New task',scope:'Own directory',acceptance:'New criterion',reviewPolicy:'human'});
    assert.equal(later.botConfigRevision,2);assert.equal(store.taskBotContext(later.id).materials[0]?.text,'NEW_REFERENCE');
    assert.throws(()=>store.updateBot('stale',bot.id,1,input,[material('STALE')]),/已经更新/);
    assert.equal(store.updateBot('update',bot.id,1,next,[material('DISK_CHANGED_AFTER_RECEIPT')]).configRevision,2);
    const manager=store.beginManager('new-manager',bot.id,join(dir,'manager'));store.confirmManager(manager.id,manager.requestedSessionId);
    const same=store.updateBot('no-change',bot.id,2,next,[material('NEW_REFERENCE')]);assert.equal(same.configRevision,2);assert.equal(same.managerSessionId,manager.requestedSessionId);
    store.db.exec("CREATE TRIGGER fail_config BEFORE INSERT ON events WHEN NEW.kind='bot.updated' BEGIN SELECT RAISE(ABORT,'config fault'); END");
    assert.throws(()=>store.updateBot('failed-update',bot.id,2,input,[material('ORIGINAL_REFERENCE')]),/config fault/);
    assert.equal(store.getBot(bot.id).configRevision,2);assert.equal(store.managerForSession(manager.requestedSessionId)?.id,manager.id);
    store.db.exec('DROP TRIGGER fail_config');store.close();store=new Store(file);
    assert.equal(store.getBot(bot.id).configRevision,2);assert.equal(store.taskBotContext(task.id).materials[0]?.text,'ORIGINAL_REFERENCE');assert.equal(store.taskBotContext(later.id).materials[0]?.text,'NEW_REFERENCE');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
