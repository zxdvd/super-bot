import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,realpath,lstat,readFile,appendFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {AppError} from './model.ts';

const git=promisify(execFile);
/** Reuse only our deterministic task/generation directory; never fall back to the project root. */
export async function taskWorkspace(root:string,taskId:string,generation:number):Promise<string> {
  const project=await realpath(root),parent=join(project,'.super-bot-workspaces');
  await mkdir(parent,{recursive:true});
  if(await realpath(parent)!==parent)throw new AppError('workspace-unsafe','任务目录不能是符号链接。');
  const target=join(parent,generation===1?taskId:`${taskId}-g${generation}`);
  let repository=false;
  try{await lstat(join(project,'.git'));repository=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(repository) {
    // Keep nested task worktrees out of the project checkout's `git status`.
    const exclude=(await git('git',['-C',project,'rev-parse','--git-path','info/exclude'])).stdout.trim();
    const file=isAbsolute(exclude)?exclude:join(project,exclude);
    const current=await readFile(file,'utf8').catch(()=>'');
    if(!current.split('\n').includes('/.super-bot-workspaces/')){await mkdir(join(file,'..'),{recursive:true});await appendFile(file,`${current&&!current.endsWith('\n')?'\n':''}/.super-bot-workspaces/\n`);}
    // Git serializes its own metadata updates. A retry may find the worktree already created.
    const listing=await git('git',['-C',project,'worktree','list','--porcelain']);
    if(!listing.stdout.split('\n').includes(`worktree ${target}`)) {
      try{await git('git',['-C',project,'worktree','add','--detach',target,'HEAD']);}
      catch{throw new AppError('workspace-prepare','无法创建任务 Git worktree，请检查项目提交和目录状态；没有退回共享目录。');}
    }
  }else await mkdir(target,{recursive:true});
  if(await realpath(target)!==target)throw new AppError('workspace-unsafe','任务目录不能是符号链接。');
  return target;
}
