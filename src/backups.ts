import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod,mkdir,readFile,rename,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError,requiredText } from './model.ts';
import type { Store } from './store.ts';

export interface BackupInfo {path:string;manifestPath:string;createdAt:string;schema:number;counts:{bots:number;tasks:number;results:number};sessions:string[];artifactDirectories:string[];scope:string}
const running=new Map<string,Promise<BackupInfo>>();
export function createLedgerBackup(store:Store,dataDir:string,requestId:string):Promise<BackupInfo> {
  const key=createHash('sha256').update(requiredText(requestId,'备份请求标识',200)).digest('hex').slice(0,24);
  const operationKey=join(dataDir,key);const prior=running.get(operationKey);if(prior)return prior;
  const operation=writeBackup(store,dataDir,key).finally(()=>running.delete(operationKey));running.set(operationKey,operation);return operation;
}
async function writeBackup(store:Store,dataDir:string,key:string):Promise<BackupInfo> {
  const directory=join(dataDir,'backups');await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,`ledger-${key}.sqlite`),manifestPath=path+'.json';
  try{const info=JSON.parse(await readFile(manifestPath,'utf8')) as BackupInfo;store.recordBackup(key,path);return info;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const pending=path+'.partial';await rm(pending,{force:true});
  // No await between snapshot start and completion: the small ledger is copied by SQLite itself.
  store.backupLedger(pending);
  const snapshot=new DatabaseSync(pending,{readOnly:true});let info:BackupInfo;
  try {
    if(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new AppError('backup-invalid','备份校验失败，未发布备份。');
    const count=(table:string)=>Number(snapshot.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    info={path,manifestPath,createdAt:new Date().toISOString(),schema:Number(snapshot.prepare('PRAGMA user_version').get()?.user_version),counts:{bots:count('bots'),tasks:count('tasks'),results:count('results')},
      sessions:snapshot.prepare('SELECT sessionId FROM bindings WHERE sessionId IS NOT NULL UNION SELECT sessionId FROM managers WHERE sessionId IS NOT NULL').all().map(r=>String(r.sessionId)),
      artifactDirectories:snapshot.prepare('SELECT cwd FROM bindings UNION SELECT cwd FROM managers').all().map(r=>String(r.cwd)),
      scope:'含 SQLite 账本、参考文本快照、成果索引和审计。DSH 会话、模型凭证与成果文件不在此备份中；请按清单单独保留。'};
  }finally{snapshot.close();}
  await rename(pending,path);await chmod(path,0o600);await writeFile(manifestPath+'.partial',JSON.stringify(info,null,2),{mode:0o600});await rename(manifestPath+'.partial',manifestPath);
  store.recordBackup(key,path);
  return info;
}
