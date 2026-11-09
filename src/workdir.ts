/** Task working directories: Bot-chosen modes inside configured roots. Generic; no user-specific tooling. */
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,realpath,lstat,readFile,appendFile,rm,rmdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,isAbsolute,relative,resolve,sep,dirname,basename,parse} from 'node:path';
import {AppError} from './model.ts';

const exec=promisify(execFile);
export const WORKDIR_MODES=['existing','isolated','worktree','hook'] as const;
export type WorkdirMode=typeof WORKDIR_MODES[number];
export type DefaultWorkdir=Exclude<WorkdirMode,'existing'>|'none';
export type WorkdirCleanup='manual'|'on-complete';
/** What the Bot (or a person) asks for. Every field is untrusted input. */
export interface WorkdirRequest {
  mode:WorkdirMode; path?:string; name?:string; under?:string;
  repo?:string; base?:string; branch?:string; args?:Record<string,string>;
}
export interface WorkdirHook {
  description?:string; create:string; remove?:string; cwd?:string; timeoutSeconds?:number; argNames?:string[];
}
export interface WorkdirConfig {
  allowedRoots?:string[]; defaultWorkdir?:DefaultWorkdir; defaultIsolatedDir?:string; deniedPaths?:string[];
  workdirHook?:WorkdirHook; workdirCleanup?:WorkdirCleanup;
  /** Deprecated single project root. */
  workspace?:string;
}
/** Recorded on the binding; describes what was provisioned. */
export interface WorkdirInfo {
  mode:WorkdirMode|'default'; name?:string; repo?:string; branch?:string;
  state:'provisioned'|'removed'|'remove-failed'; note?:string;
}
export interface WorkdirPolicy {
  roots:string[]; defaultWorkdir:DefaultWorkdir; isolatedDir:string; denied:string[];
  hook?:WorkdirHook; cleanup:WorkdirCleanup; dataDir:string; warnings:string[];
  /** Deprecated `workspace` only: a git root defaults to a worktree, as before. */
  legacy:boolean;
}

const SENSITIVE_SEGMENT=/^(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|credentials|\.env(?:\..*)?|.*\.pem|.*\.key)$/i;
/** True when any path segment names a credential store or secret file. */
export function sensitivePath(path:string):boolean {
  return path.split(/[\\/]/).some(part=>SENSITIVE_SEGMENT.test(part))||/(?:^|[\\/])Library[\\/]Keychains(?:[\\/]|$)/.test(path);
}
const contains=(parent:string,child:string)=>{
  const path=relative(parent,child);return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`));
};
const reject=(message:string)=>new AppError('workdir-rejected',message);

/** Normalizes configuration once. Invalid roots are dropped with a warning instead of failing plugin load. */
export function workdirPolicy(config:WorkdirConfig,dataDir:string):WorkdirPolicy {
  const warnings:string[]=[];const home=resolve(homedir());
  const rawRoots=config.allowedRoots?.length?config.allowedRoots:config.workspace?[config.workspace]:[];
  if(!config.allowedRoots?.length&&config.workspace)warnings.push('workspace 已弃用，请改用 allowedRoots。');
  const roots:string[]=[];
  for(const root of rawRoots) {
    const full=resolve(root);
    if(!isAbsolute(root)){warnings.push(`allowedRoots 必须是绝对路径，已忽略：${root}`);continue;}
    if(full===home||full===parse(full).root){warnings.push(`allowedRoots 不能是 HOME 或文件系统根目录，已忽略：${root}`);continue;}
    if(sensitivePath(full)){warnings.push(`allowedRoots 指向敏感目录，已忽略：${root}`);continue;}
    roots.push(full);
  }
  const legacy=!config.allowedRoots?.length&&!!config.workspace&&!config.defaultWorkdir;
  let defaultWorkdir:DefaultWorkdir=config.defaultWorkdir??(roots.length?'isolated':'none');
  if(defaultWorkdir!=='none'&&!roots.length){if(config.defaultWorkdir)warnings.push('没有可用的 allowedRoots，defaultWorkdir 退回 none。');defaultWorkdir='none';}
  if(defaultWorkdir==='hook'&&!config.workdirHook?.create){warnings.push('defaultWorkdir 为 hook 但未配置 workdirHook.create，退回 isolated。');defaultWorkdir='isolated';}
  const isolatedDir=config.defaultIsolatedDir??'.super-bot-workspaces';
  return {roots,defaultWorkdir,isolatedDir,denied:(config.deniedPaths??[]).map(path=>resolve(path)),
    hook:config.workdirHook?.create?config.workdirHook:undefined,cleanup:config.workdirCleanup??'manual',dataDir:resolve(dataDir),warnings,
    legacy:legacy&&roots.length>0};
}

const NAME_MAX=32;
/** kebab-case English, at most four words; never empty. */
export function workdirName(name:unknown):string {
  const text=typeof name==='string'?name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''):'';
  const words=text.split('-').filter(Boolean).slice(0,4).join('-').slice(0,NAME_MAX).replace(/-+$/,'');
  return words||'task';
}
export function uniqueName(name:unknown,taskId:string,generation:number):string {
  return `${workdirName(name)}-${taskId.replace(/[^a-z0-9]/gi,'').slice(0,8).toLowerCase()}${generation>1?`-g${generation}`:''}`;
}
const ARG_KEY=/^[a-z][a-z0-9_]{0,31}$/i,ARG_VALUE=/^[A-Za-z0-9._/ -]{0,200}$/,REF=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Shape validation of an untrusted request. Path policy is enforced later by resolveWorkdir. */
export function parseWorkdirRequest(value:unknown):WorkdirRequest|undefined {
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='object'||Array.isArray(value))throw reject('workdir 必须是对象。');
  const data=value as Record<string,unknown>;
  const allowed=new Set(['mode','path','name','under','repo','base','branch','args']);
  for(const key of Object.keys(data))if(!allowed.has(key))throw reject(`workdir 不支持字段 ${key}。`);
  if(!WORKDIR_MODES.includes(data.mode as WorkdirMode))throw reject('workdir.mode 只能是 existing、isolated、worktree 或 hook。');
  const text=(key:string,max=1000)=>{
    const item=data[key];if(item===undefined||item==='')return undefined;
    if(typeof item!=='string'||item.length>max||/[\0\n\r]/.test(item))throw reject(`workdir.${key} 无效。`);return item.trim();
  };
  const request:WorkdirRequest={mode:data.mode as WorkdirMode};
  for(const key of ['path','under','repo'] as const){const item=text(key);if(item)request[key]=item;}
  const name=text('name',200);if(name)request.name=workdirName(name);
  for(const key of ['base','branch'] as const){const item=text(key,200);if(item){if(!REF.test(item)||item.includes('..'))throw reject(`workdir.${key} 不是有效的 Git 引用。`);request[key]=item;}}
  if(data.args!==undefined) {
    if(typeof data.args!=='object'||data.args===null||Array.isArray(data.args))throw reject('workdir.args 必须是对象。');
    const args:Record<string,string>={};
    for(const [key,item] of Object.entries(data.args)) {
      if(!ARG_KEY.test(key)||typeof item!=='string'||!ARG_VALUE.test(item))throw reject(`workdir.args.${key} 含不允许的字符。`);
      args[key]=item;
    }
    request.args=args;
  }
  if(request.mode==='existing'&&!request.path)throw reject('existing 模式需要 path。');
  if(request.mode==='worktree'&&!request.repo)throw reject('worktree 模式需要 repo。');
  if(request.mode!=='hook'&&request.args)throw reject('只有 hook 模式可以传 args。');
  return request;
}

/** Real path of a possibly missing directory: realpath of the nearest existing ancestor plus the remainder. */
async function realTarget(path:string):Promise<string> {
  let current=resolve(path);const rest:string[]=[];
  for(;;) {
    try{return join(await realpath(current),...rest.reverse());}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const parent=dirname(current);if(parent===current)throw reject('目录无法解析。');
    rest.push(basename(current));current=parent;
  }
}
/** Enforces allowedRoots, the denylist and the data directory exclusion on a real path. */
export async function resolveWorkdir(path:string,policy:WorkdirPolicy):Promise<string> {
  if(!policy.roots.length)throw reject('未配置 allowedRoots，不能使用自选目录；请在 Super Bot 配置中设置 allowedRoots。');
  if(/[\0\n\r]/.test(path))throw reject('目录无效。');
  const lexical=isAbsolute(path)?resolve(path):resolve(policy.roots[0]!,path);
  if(sensitivePath(lexical))throw reject('敏感目录不能作为任务工作目录。');
  const target=await realTarget(lexical);
  if(sensitivePath(target))throw reject('敏感目录不能作为任务工作目录。');
  const roots=await Promise.all(policy.roots.map(root=>realTarget(root)));
  if(!roots.some(root=>contains(root,target)))throw reject(`目录不在允许的根目录内：${policy.roots.join('、')}`);
  const home=await realTarget(homedir());
  if(target===home||target===parse(target).root)throw reject('不能使用 HOME 或文件系统根目录。');
  for(const denied of policy.denied)if(contains(await realTarget(denied),target))throw reject('目录位于 deniedPaths 中。');
  const data=await realTarget(policy.dataDir);
  if(target===data||contains(join(data,'managers'),target))throw reject('不能使用 Super Bot 数据目录。');
  return target;
}
async function assertDirectory(path:string):Promise<void> {
  let stat;try{stat=await lstat(path);}catch{throw reject(`目录不存在：${path}`);}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw reject('任务目录必须是真实目录，不能是符号链接或文件。');
  if(await realpath(path)!==path)throw reject('任务目录路径包含符号链接。');
}
async function gitTop(path:string):Promise<string|undefined> {
  try{return await realpath((await exec('git',['-C',path,'rev-parse','--show-toplevel'])).stdout.trim());}catch{return undefined;}
}
/** Keep task directories created inside a repository out of that checkout's `git status`. */
async function excludeFromRepository(container:string):Promise<void> {
  const top=await gitTop(dirname(container));if(!top||!contains(top,container)||top===container)return;
  try{await exec('git',['-C',top,'check-ignore','-q',container]);return;}catch{/* Not ignored yet. */}
  const exclude=(await exec('git',['-C',top,'rev-parse','--git-path','info/exclude'])).stdout.trim();
  const file=isAbsolute(exclude)?exclude:join(top,exclude),line=`/${relative(top,container).split(sep).join('/')}/`;
  const current=await readFile(file,'utf8').catch(()=>'');
  if(current.split('\n').includes(line))return;
  await mkdir(dirname(file),{recursive:true});
  await appendFile(file,`${current&&!current.endsWith('\n')?'\n':''}${line}\n`);
}
async function container(under:string|undefined,policy:WorkdirPolicy):Promise<string> {
  const base=under??policy.isolatedDir;
  const path=await resolveWorkdir(base,policy);
  await mkdir(path,{recursive:true});await assertDirectory(path);await excludeFromRepository(path);
  return path;
}

export interface Provisioned {cwd:string;info:WorkdirInfo}
export interface HookRun {code:number|null;stdout:string;stderr:string;timedOut:boolean}
export type HookRunner=(command:string,cwd:string,env:Record<string,string>,timeoutMs:number)=>Promise<HookRun>;
const tail=(text:string)=>text.length>2048?`…${text.slice(-2048)}`:text;
export const runShell:HookRunner=(command,cwd,env,timeoutMs)=>new Promise(done=>{
  const child=spawn('sh',['-c',command],{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-65536);});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
  const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill('SIGKILL');}},timeoutMs);
  child.on('error',error=>{clearTimeout(timer);done({code:-1,stdout,stderr:stderr+String(error),timedOut});});
  child.on('close',code=>{clearTimeout(timer);done({code,stdout,stderr,timedOut});});
});
/** `{name}`, `{taskId}`, `{args.x}` are sugar for quoted environment variables; values never enter shell text. */
export function renderHook(template:string):string {
  return template.replace(/\{name\}/g,'"$SB_NAME"').replace(/\{taskId\}/g,'"$SB_TASK_ID"').replace(/\{workdir\}/g,'"$SB_WORKDIR"')
    .replace(/\{args\.([a-z][a-z0-9_]{0,31})\}/gi,(_m,key:string)=>`"$SB_ARG_${key.toUpperCase()}"`);
}
function hookEnv(name:string,taskId:string,args:Record<string,string>,extra:Record<string,string>={}):Record<string,string> {
  const env:Record<string,string>={SB_NAME:name,SB_TASK_ID:taskId,...extra};
  for(const [key,value] of Object.entries(args))env[`SB_ARG_${key.toUpperCase()}`]=value;
  return env;
}

export interface ProvisionInput {request?:WorkdirRequest;taskId:string;generation:number;policy:WorkdirPolicy;runHook?:HookRunner}
/** Creates (or, for an identical retry, reuses) the task directory. Never falls back to a different directory. */
export async function provisionWorkdir({request,taskId,generation,policy,runHook=runShell}:ProvisionInput):Promise<Provisioned> {
  let mode:DefaultWorkdir|'existing'=request?.mode??policy.defaultWorkdir;
  if(!request&&policy.legacy){const root=await realTarget(policy.roots[0]!);if(await gitTop(root)===root)mode='worktree';}
  const name=uniqueName(request?.name,taskId,generation);
  if(mode==='none') {
    const cwd=join(policy.dataDir,'workspaces',generation===1?taskId:`${taskId}-g${generation}`);
    await mkdir(cwd,{recursive:true});return {cwd:await realpath(cwd),info:{mode:'default',state:'provisioned'}};
  }
  if(mode==='existing') {
    const cwd=await resolveWorkdir(request!.path!,policy);await assertDirectory(cwd);
    return {cwd,info:{mode,state:'provisioned'}};
  }
  if(mode==='isolated') {
    const parent=await container(request?.under,policy),cwd=join(parent,name);
    await mkdir(cwd,{recursive:true});await assertDirectory(cwd);
    return {cwd,info:{mode,name,state:'provisioned'}};
  }
  if(mode==='worktree') {
    const repoPath=request?.repo??policy.roots[0]!;
    const repo=await resolveWorkdir(repoPath,policy);await assertDirectory(repo);
    if(await gitTop(repo)!==repo)throw reject('worktree 的 repo 必须是 Git 仓库的顶层目录。');
    const parent=await container(request?.under,policy),cwd=join(parent,name),branch=request?.branch??`sb/${name}`;
    const listing=(await exec('git',['-C',repo,'worktree','list','--porcelain'])).stdout.split('\n');
    if(!listing.includes(`worktree ${cwd}`)) {
      try{await exec('git',['check-ref-format','--branch',branch]);}catch{throw reject('分支名无效。');}
      try{await exec('git',['-C',repo,'worktree','add','-b',branch,cwd,request?.base??'HEAD']);}
      catch(error){throw new AppError('workdir-prepare',`无法创建 Git worktree：${tail(String((error as {stderr?:string}).stderr??error)).trim()}`);}
    }
    await assertDirectory(cwd);
    return {cwd,info:{mode,name,repo,branch,state:'provisioned'}};
  }
  const hook=policy.hook;
  if(!hook)throw reject('没有配置 workdirHook，不能使用 hook 模式。');
  const args=request?.args??{};const names=hook.argNames??[];
  for(const key of Object.keys(args))if(!names.includes(key))throw reject(`hook 不接受参数 ${key}；可用：${names.join('、')||'无'}`);
  const cwd=await resolveWorkdir(hook.cwd??policy.roots[0]!,policy);await assertDirectory(cwd);
  const timeout=Math.min(Math.max(hook.timeoutSeconds??300,1),3600)*1000;
  const run=await runHook(renderHook(hook.create),cwd,hookEnv(name,taskId,args),timeout);
  const output=tail(`${run.stdout}\n${run.stderr}`.trim());
  const line=run.stdout.split('\n').map(item=>item.trim()).filter(item=>item.startsWith('SB_WORKDIR=')).at(-1);
  const fallback=join(cwd,name);
  if(run.timedOut||run.code!==0) {
    await rmdir(fallback).catch(()=>{});
    throw new AppError('workdir-hook-failed',`工作目录 hook 失败（${run.timedOut?'超时':`退出码 ${run.code}`}），不会自动重试。输出：${output||'无'}`);
  }
  const produced=line?line.slice('SB_WORKDIR='.length):fallback;
  const target=await resolveWorkdir(isAbsolute(produced)?produced:join(cwd,produced),policy);
  await assertDirectory(target).catch(()=>{throw new AppError('workdir-hook-failed',`hook 没有产出目录（需要 stdout 最后输出 SB_WORKDIR=<绝对路径>）。输出：${output||'无'}`);});
  return {cwd:target,info:{mode:'hook',name,state:'provisioned'}};
}

/** Removes only what this plugin (or the user's hook) provisioned. Existing directories are never removed. */
export async function cleanupWorkdir(cwd:string,info:WorkdirInfo,taskId:string,policy:WorkdirPolicy,runHook:HookRunner=runShell):Promise<WorkdirInfo> {
  if(info.state==='removed')return info;
  if(info.mode==='existing'||info.mode==='default')throw new AppError('workdir-cleanup-unsupported','已有目录不会被清理。');
  if(info.mode==='isolated') {
    await resolveWorkdir(cwd,policy);await rm(cwd,{recursive:true,force:true});
    return {...info,state:'removed'};
  }
  if(info.mode==='worktree') {
    try{await exec('git',['-C',info.repo!,'worktree','remove',cwd]);}
    catch(error){return {...info,state:'remove-failed',note:tail(String((error as {stderr?:string}).stderr??error)).trim()};}
    try{await exec('git',['-C',info.repo!,'branch','-d',info.branch!]);}catch{/* Unmerged branches are kept on purpose. */}
    return {...info,state:'removed'};
  }
  const hook=policy.hook;
  if(!hook?.remove)throw new AppError('workdir-cleanup-unsupported','workdirHook 未配置 remove，不会删除 hook 创建的目录。');
  const hookCwd=await resolveWorkdir(hook.cwd??policy.roots[0]!,policy);
  const run=await runHook(renderHook(hook.remove),hookCwd,hookEnv(info.name??'',taskId,{},{SB_WORKDIR:cwd}),Math.min(Math.max(hook.timeoutSeconds??300,1),3600)*1000);
  if(run.timedOut||run.code!==0)return {...info,state:'remove-failed',note:tail(`${run.stdout}\n${run.stderr}`.trim())};
  return {...info,state:'removed'};
}
/** Prompt text describing what the Bot may choose. */
export function workdirGuidance(policy:WorkdirPolicy):string {
  const roots=policy.roots.length?policy.roots.join(', '):'(none configured: only the default directory is available)';
  return [
    'Working directory: every task runs in one directory you may choose with the optional `workdir` object on create (or on the first dispatch before a session exists).',
    `Allowed roots: ${roots}. Default when you omit workdir: ${policy.defaultWorkdir==='none'?'a private directory under the Super Bot data dir':policy.defaultWorkdir}.`,
    'Modes: existing {path} = work directly in a directory the user named (exclusive: tasks on the same or nested directory queue FIFO);',
    'worktree {repo, name?, base?, branch?} = a git worktree of that repository on a new branch (default sb/<name>-<id>), safe for parallel work;',
    'isolated {name?, under?} = a fresh empty directory for research, documents or scratch work;',
    policy.hook?`hook {name?, args?} = run the user's provisioning hook. Hook purpose: ${policy.hook.description??'(no description)'}. Allowed args: ${(policy.hook.argNames??[]).join(', ')||'none'}.`:'hook = not configured.',
    'Pick from the request and context: if the user named a repo or folder and wants it changed in place use existing; if they want changes to a repo without touching their checkout, or another task already uses it, use worktree; otherwise isolated.',
    'Give name as a short English kebab-case phrase. If the repository is unclear, check with read-only shell commands or ask; do not guess a root and leave the Worker to search.',
    'workdir-rejected means the plugin refused the path; choose another mode or ask the user, never work around it. A deferred resource-conflict names the holder task: tell the user it is queued behind that task and offer worktree if parallel work is wanted. Mention the working directory when delivering.',
  ].join('\n');
}
/** One line for the Worker message and the Bot: where and how this task works. */
export function workdirSummary(cwd:string,info:WorkdirInfo|null|undefined):string {
  const mode=info?.mode??'existing';
  if(mode==='worktree')return `${cwd} (git worktree of ${info!.repo} on branch ${info!.branch}; commit there, never in the original checkout)`;
  if(mode==='isolated')return `${cwd} (fresh isolated directory for this task)`;
  if(mode==='hook')return `${cwd} (provisioned by the user's workspace hook; follow that directory's own instructions such as AGENTS.md)`;
  if(mode==='default')return `${cwd} (private task directory)`;
  return `${cwd} (existing directory chosen for this task; Super Bot gives this run exclusive use of it)`;
}
