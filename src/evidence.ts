import { createHash } from 'node:crypto';
import { constants,existsSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
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
type InspectedEvidence=Evidence&{text:string;truncated:boolean};
export function evidencePaths(paths:unknown):string[] {
  if(!Array.isArray(paths)||paths.length<1||paths.length>10||paths.some(p=>typeof p!=='string'))throw new AppError('invalid-evidence','请提供 1～10 个任务目录内的文件路径。');
  return [...new Set(paths as string[])];
}
async function inspectFiles(cwd:string,paths:unknown,previewBytes=0):Promise<InspectedEvidence[]> {
  const evidence:InspectedEvidence[]=[];let total=0;
  for(const path of evidencePaths(paths)) {
    let canonical:string;
    try{canonical=containedPath(cwd,path);}catch(error){if(error instanceof AppError)throw error;throw new AppError('evidence-unavailable','任务成果目录无法读取，请恢复目录后再核对。');}
    const maximum=Math.min(10*1024*1024,20*1024*1024-total);
    try {
      const file=await open(canonical,constants.O_RDONLY|constants.O_NONBLOCK);
      try {
        const metadata=await file.stat();
        if(!metadata.isFile()||metadata.size>maximum)throw new AppError('evidence-size','证据需为普通文件，单个不超过 10 MB、合计不超过 20 MB。');
        const buffer=Buffer.allocUnsafe(65536),hash=createHash('sha256'),preview:Buffer[]=[];let bytes=0,captured=0;
        while(true) {
          const read=await file.read(buffer,0,Math.min(buffer.length,maximum+1-bytes),null);if(!read.bytesRead)break;
          bytes+=read.bytesRead;if(bytes>maximum)throw new AppError('evidence-size','读取期间文件超出大小限制。');
          hash.update(buffer.subarray(0,read.bytesRead));
          const take=Math.min(read.bytesRead,previewBytes-captured);if(take>0){preview.push(Buffer.from(buffer.subarray(0,take)));captured+=take;}
        }
        total+=bytes;evidence.push({path:canonical,sha256:hash.digest('hex'),bytes,text:Buffer.concat(preview).toString('utf8'),truncated:bytes>captured});
      }finally{await file.close();}
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('evidence-unavailable',`成果文件无法读取，请恢复文件或重新提交：${canonical}`);}
  }
  return evidence;
}
export async function collectEvidence(cwd:string,paths:unknown):Promise<Evidence[]> {
  return (await inspectFiles(cwd,paths)).map(({path,sha256,bytes})=>({path,sha256,bytes}));
}
function assertSameEvidence(current:Evidence[],evidence:Evidence[]):void {
  if(current.length!==evidence.length||current.some((e,i)=>e.path!==evidence[i].path||e.sha256!==evidence[i].sha256||e.bytes!==evidence[i].bytes))throw new AppError('evidence-changed','成果文件已经变化，不能接受旧结果。请重新提交成果。');
}
export async function verifyEvidence(cwd:string,evidence:Evidence[]):Promise<void> {
  const current=await collectEvidence(cwd,evidence.map(e=>e.path));
  assertSameEvidence(current,evidence);
}
export async function previewEvidence(cwd:string,evidence:Evidence[]):Promise<{path:string;text:string;bytes:number;truncated:boolean}[]> {
  const current=await inspectFiles(cwd,evidence.map(file=>file.path),12000);assertSameEvidence(current,evidence);
  return current.map(({path,text,bytes,truncated})=>({path,text,bytes,truncated}));
}
