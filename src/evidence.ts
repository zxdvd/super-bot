import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError, type Evidence } from './model.ts';

/** Also checks existing ancestors: an in-directory symlink cannot authorize an outside file. */
export function containedPath(cwd:string,path:string):string {
  const root=realpathSync(cwd);const target=resolve(root,path);let ancestor=target;
  while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const canonical=resolve(realpathSync(ancestor),relative(ancestor,target));
  const rel=relative(root,canonical);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new AppError('path-outside','文件必须位于当前任务的专用工作目录。');
  return canonical;
}
export async function collectEvidence(cwd:string,paths:unknown):Promise<Evidence[]> {
  if(!Array.isArray(paths)||paths.length<1||paths.length>10||paths.some(p=>typeof p!=='string'))throw new AppError('invalid-evidence','请提供 1～10 个任务目录内的文件路径。');
  const evidence:Evidence[]=[];let total=0;
  for(const path of new Set(paths as string[])) {
    const canonical=containedPath(cwd,path);const metadata=await stat(canonical);
    if(!metadata.isFile()||metadata.size>10*1024*1024||total+metadata.size>20*1024*1024)throw new AppError('evidence-size','证据需为普通文件，单个不超过 10 MB、合计不超过 20 MB。');
    const data=await readFile(canonical);total+=data.length;
    if(data.length>10*1024*1024||total>20*1024*1024)throw new AppError('evidence-size','读取期间文件超出大小限制。');
    evidence.push({path:canonical,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});
  }
  return evidence;
}
export async function verifyEvidence(cwd:string,evidence:Evidence[]):Promise<void> {
  const current=await collectEvidence(cwd,evidence.map(e=>e.path));
  if(current.length!==evidence.length||current.some((e,i)=>e.path!==evidence[i].path||e.sha256!==evidence[i].sha256||e.bytes!==evidence[i].bytes))throw new AppError('evidence-changed','成果文件已经变化，不能接受旧结果。请重新提交成果。');
}
