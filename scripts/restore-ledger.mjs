/** Restore into a NEW directory. Never overwrite a live ledger or the backup. */
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { copyFile,mkdir,chmod } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import assert from 'node:assert/strict';
import schemaVersion from '../schema-version.json' with {type:'json'};
const [sourceArgument,destinationArgument]=process.argv.slice(2);
assert.ok(sourceArgument&&destinationArgument,'Usage: node scripts/restore-ledger.mjs <backup.sqlite> <new-directory>');
const source=resolve(sourceArgument),destination=resolve(destinationArgument);
function inspect(file) {const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');return {schema:db.prepare('PRAGMA user_version').get().user_version,bots:db.prepare('SELECT count(*) AS n FROM bots').get().n,tasks:db.prepare('SELECT count(*) AS n FROM tasks').get().n,results:db.prepare('SELECT count(*) AS n FROM results').get().n};}finally{db.close();}}
const before=inspect(source);
assert.ok(before.schema>=6&&before.schema<=schemaVersion,'This restore supports schema 6 through the current version; use the matching older plugin for earlier backups');
await mkdir(destination,{mode:0o700});
const target=join(destination,'ledger.sqlite');await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);
assert.deepEqual(inspect(target),before);
// A restored ledger may predate effects already present in DSH/files. Never resume it blindly.
const restored=new DatabaseSync(target);
try {
  const now=Date.now();restored.exec('BEGIN IMMEDIATE');
  for(const task of restored.prepare("SELECT id,taskRevision FROM tasks WHERE lifecycle IN ('open','review')").all()) {
    restored.prepare("UPDATE tasks SET controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(now,task.id);
    restored.prepare('INSERT OR REPLACE INTO attentions(id,taskId,kind,question,taskRevision,state,createdAt) VALUES (?,?,?,?,?,?,?)').run(`restore:${task.id}`,task.id,'recovery','账本已从备份恢复；备份之后可能发生过执行。请核对原生会话、文件及外部效果，再决定是否继续。',task.taskRevision,'open',now);
  }
  restored.prepare("UPDATE runs SET state='interrupted',finishedAt=?,note='从备份恢复，执行效果待核对' WHERE finishedAt IS NULL").run(now);
  restored.prepare("UPDATE attentions SET state='stale' WHERE kind='approval' AND state='open'").run();
  restored.prepare("UPDATE outbox SET state='unknown' WHERE state='sending' OR (kind='manager.notify' AND state='pending')").run();
  restored.prepare("INSERT INTO metadata(key,value) VALUES ('restoredAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
  restored.prepare('INSERT INTO events(taskId,kind,data,createdAt) VALUES (NULL,?,?,?)').run('ledger.restored',JSON.stringify({source}),now);
  restored.exec('COMMIT');
}finally{restored.close();}
try{await copyFile(source+'.json',join(destination,'backup-manifest.json'),constants.COPYFILE_EXCL);}catch(error){if(error.code!=='ENOENT')throw error;}
console.log(JSON.stringify({ok:true,dataDir:destination,...before,note:'账本已恢复到新目录；未完成任务全部暂停并标记待核对。先停止宿主，再把插件 dataDir 指向此目录。原账本/备份未改变；DSH 会话和成果文件需按清单保留。'},null,2));
