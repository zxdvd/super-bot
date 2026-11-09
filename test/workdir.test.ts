import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cleanupWorkdir,parseWorkdirRequest,provisionWorkdir,renderHook,resolveWorkdir,uniqueName,workdirGuidance,workdirName,workdirPolicy,type WorkdirConfig} from '../src/workdir.ts';
import {collectEvidence,readEvidence} from '../src/evidence.ts';

const TASK='0123abcd-0000-4000-8000-000000000001';
function sandbox(t:{after:(fn:()=>void)=>void}) {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'super-bot-workdir-')));
  const root=join(base,'root'),data=join(base,'data');mkdirSync(root);mkdirSync(data);
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const policy=(config:WorkdirConfig={})=>workdirPolicy({allowedRoots:[root],...config},data);
  return {base,root,data,policy};
}
function repo(path:string) {
  mkdirSync(path,{recursive:true});
  const git=(...args:string[])=>execFileSync('git',['-C',path,...args],{stdio:'pipe'}).toString().trim();
  git('init','-q');writeFileSync(join(path,'source.txt'),'committed');git('add','source.txt');
  git('-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','-qm','fixture');
  return git;
}
const rejected={code:'workdir-rejected'};

test('names are short kebab-case and carry a stable task suffix',()=>{
  assert.equal(workdirName('Fix  Login_Bug in API v2!!'),'fix-login-bug-in');
  assert.equal(workdirName(''),'task');assert.equal(workdirName(undefined),'task');
  assert.equal(uniqueName('Docs',TASK,1),'docs-0123abcd');assert.equal(uniqueName('Docs',TASK,3),'docs-0123abcd-g3');
});
test('request shape is validated before any path policy',()=>{
  assert.equal(parseWorkdirRequest(undefined),undefined);
  assert.deepEqual(parseWorkdirRequest({mode:'isolated',name:'My Report'}),{mode:'isolated',name:'my-report'});
  for(const bad of [{mode:'shell'},{mode:'existing'},{mode:'worktree'},{mode:'isolated',extra:1},{mode:'isolated',args:{a:'b'}},
    {mode:'hook',args:{repos:'$(rm -rf /)'}},{mode:'hook',args:{repos:'a;b'}},{mode:'hook',args:{repos:'`id`'}},{mode:'worktree',repo:'/x',branch:'-evil'},
    {mode:'worktree',repo:'/x',base:'a..b'},{mode:'existing',path:'a\nb'},'isolated',[]])
    assert.throws(()=>parseWorkdirRequest(bad),rejected,JSON.stringify(bad));
});
test('configuration drops HOME, filesystem root and relative roots with warnings; legacy workspace maps to allowedRoots',t=>{
  const {root,data}=sandbox(t);
  const policy=workdirPolicy({allowedRoots:[homedir(),'/','relative',root]},data);
  assert.deepEqual(policy.roots,[root]);assert.equal(policy.warnings.length,3);assert.equal(policy.defaultWorkdir,'isolated');
  const legacy=workdirPolicy({workspace:root},data);assert.deepEqual(legacy.roots,[root]);assert.equal(legacy.legacy,true);assert.match(legacy.warnings[0]!,/弃用/);
  assert.equal(workdirPolicy({},data).defaultWorkdir,'none');
  assert.equal(workdirPolicy({allowedRoots:[root],defaultWorkdir:'hook'},data).defaultWorkdir,'isolated');
  assert.match(workdirGuidance(workdirPolicy({allowedRoots:[root],workdirHook:{create:'true',description:'Make a multi-repo workspace',argNames:['repos']}},data)),/Make a multi-repo workspace[\s\S]*repos/);
});
test('paths must resolve inside allowedRoots after symlinks, outside secrets, HOME and the data dir',async t=>{
  const {base,root,data,policy}=sandbox(t);
  mkdirSync(join(root,'project'));mkdirSync(join(base,'outside'));mkdirSync(join(root,'.ssh'));mkdirSync(join(root,'private'));
  symlinkSync(join(base,'outside'),join(root,'escape'));symlinkSync(join(root,'project'),join(root,'alias'));
  assert.equal(await resolveWorkdir('project',policy()),join(root,'project'));
  assert.equal(await resolveWorkdir(join(root,'alias'),policy()),join(root,'project'));
  for(const path of [join(base,'outside'),join(root,'escape'),join(root,'escape','new'),join(root,'..','outside'),join(root,'.ssh'),join(root,'project','.env'),join(root,'id.pem'),'/'])
    await assert.rejects(resolveWorkdir(path,policy()),rejected,path);
  await assert.rejects(resolveWorkdir(join(root,'private','x'),policy({deniedPaths:[join(root,'private')]})),rejected);
  await assert.rejects(resolveWorkdir(data,workdirPolicy({allowedRoots:[base]},data)),rejected);
  await assert.rejects(resolveWorkdir(join(data,'managers','bot'),workdirPolicy({allowedRoots:[base]},data)),rejected);
  await assert.rejects(resolveWorkdir(root,workdirPolicy({},data)),{code:'workdir-rejected',message:/allowedRoots/});
});
test('existing mode uses the named directory itself and never creates it',async t=>{
  const {root,policy}=sandbox(t);mkdirSync(join(root,'app'));
  const result=await provisionWorkdir({request:{mode:'existing',path:join(root,'app')},taskId:TASK,generation:1,policy:policy()});
  assert.deepEqual(result,{cwd:join(root,'app'),info:{mode:'existing',state:'provisioned'}});
  await assert.rejects(provisionWorkdir({request:{mode:'existing',path:join(root,'missing')},taskId:TASK,generation:1,policy:policy()}),rejected);
  assert.equal(existsSync(join(root,'missing')),false);
  writeFileSync(join(root,'file.txt'),'x');
  await assert.rejects(provisionWorkdir({request:{mode:'existing',path:join(root,'file.txt')},taskId:TASK,generation:1,policy:policy()}),rejected);
});
test('isolated mode creates a fresh named directory, reuses it on retry and the default stays under the data dir without roots',async t=>{
  const {root,data,policy}=sandbox(t);
  const first=await provisionWorkdir({request:{mode:'isolated',name:'research notes'},taskId:TASK,generation:1,policy:policy()});
  assert.equal(first.cwd,join(root,'.super-bot-workspaces','research-notes-0123abcd'));assert.equal(first.info.name,'research-notes-0123abcd');
  assert.deepEqual(await provisionWorkdir({request:{mode:'isolated',name:'research notes'},taskId:TASK,generation:1,policy:policy()}),first);
  const custom=await provisionWorkdir({request:{mode:'isolated',under:'scratch'},taskId:TASK,generation:2,policy:policy()});
  assert.equal(custom.cwd,join(root,'scratch','task-0123abcd-g2'));
  const fallback=await provisionWorkdir({taskId:TASK,generation:1,policy:workdirPolicy({},data)});
  assert.equal(fallback.cwd,join(realpathSync(data),'workspaces',TASK));assert.equal(fallback.info.mode,'default');
  await assert.rejects(provisionWorkdir({request:{mode:'isolated',under:'../../escape'},taskId:TASK,generation:1,policy:policy()}),rejected);
});
test('worktree mode branches from committed source, leaves the checkout untouched and requires a repository top level',async t=>{
  const {root,policy}=sandbox(t);const app=join(root,'app'),git=repo(app);
  writeFileSync(join(app,'source.txt'),'uncommitted');mkdirSync(join(app,'sub'));
  const p=policy({defaultIsolatedDir:join(app,'.sb')});
  const a=await provisionWorkdir({request:{mode:'worktree',repo:app,name:'fix login'},taskId:TASK,generation:1,policy:p});
  assert.equal(a.cwd,join(app,'.sb','fix-login-0123abcd'));assert.equal(a.info.branch,'sb/fix-login-0123abcd');assert.equal(a.info.repo,app);
  assert.equal(readFileSync(join(a.cwd,'source.txt'),'utf8'),'committed');
  assert.equal(execFileSync('git',['-C',a.cwd,'branch','--show-current']).toString().trim(),'sb/fix-login-0123abcd');
  assert.deepEqual(await provisionWorkdir({request:{mode:'worktree',repo:app,name:'fix login'},taskId:TASK,generation:1,policy:p}),a);
  assert.equal(git('status','--porcelain','--untracked-files=all'),'M source.txt');
  const b=await provisionWorkdir({request:{mode:'worktree',repo:app,name:'other',branch:'feature/x'},taskId:TASK,generation:2,policy:p});
  assert.equal(execFileSync('git',['-C',b.cwd,'branch','--show-current']).toString().trim(),'feature/x');
  await assert.rejects(provisionWorkdir({request:{mode:'worktree',repo:join(app,'sub')},taskId:TASK,generation:3,policy:p}),rejected);
  mkdirSync(join(root,'plain'));
  await assert.rejects(provisionWorkdir({request:{mode:'worktree',repo:join(root,'plain')},taskId:TASK,generation:3,policy:p}),rejected);
});
test('legacy workspace on a git root keeps the worktree default, now on a named branch',async t=>{
  const {root,data}=sandbox(t);repo(root);
  const result=await provisionWorkdir({taskId:TASK,generation:1,policy:workdirPolicy({workspace:root},data)});
  assert.equal(result.info.mode,'worktree');assert.equal(result.cwd,join(root,'.super-bot-workspaces','task-0123abcd'));
  assert.equal(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all']).toString().trim(),'');
});
test('hook mode passes values only through the environment and reads SB_WORKDIR',async t=>{
  const {root,policy}=sandbox(t);
  const script=join(root,'make.sh');
  writeFileSync(script,'#!/bin/sh\nmkdir -p "workspaces/$1"\necho "made $1 with $2" >&2\necho "SB_WORKDIR=$PWD/workspaces/$1"\n');chmodSync(script,0o755);
  const p=policy({workdirHook:{create:`${script} {name} {args.repos}`,argNames:['repos'],description:'multi-repo'}});
  assert.equal(renderHook('x {name} {args.repos} {taskId}'),'x "$SB_NAME" "$SB_ARG_REPOS" "$SB_TASK_ID"');
  const made=await provisionWorkdir({request:{mode:'hook',name:'api change',args:{repos:'a b'}},taskId:TASK,generation:1,policy:p});
  assert.deepEqual(made,{cwd:join(root,'workspaces','api-change-0123abcd'),info:{mode:'hook',name:'api-change-0123abcd',state:'provisioned'}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook',args:{other:'x'}},taskId:TASK,generation:1,policy:p}),rejected);
  await assert.rejects(provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:policy()}),rejected);
});
test('hook failures, timeouts, missing or escaping output are reported and never retried or redirected',async t=>{
  const {base,root,policy}=sandbox(t);let calls=0;
  const fail=policy({workdirHook:{create:'mkdir "$SB_NAME"; echo boom >&2; exit 3'}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:fail}),{code:'workdir-hook-failed',message:/退出码 3[\s\S]*boom/});
  assert.equal(existsSync(join(root,'task-0123abcd')),false,'empty directory from a failed hook is removed');
  const slow=policy({workdirHook:{create:'sleep 5',timeoutSeconds:1}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:slow}),{code:'workdir-hook-failed',message:/超时/});
  const fallback=policy({workdirHook:{create:'mkdir "$SB_NAME"'}});
  assert.equal((await provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:fallback})).cwd,join(root,'task-0123abcd'));
  const none=policy({workdirHook:{create:'true'}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook',name:'none'},taskId:TASK,generation:1,policy:none}),{code:'workdir-hook-failed'});
  mkdirSync(join(base,'elsewhere'));
  const escape=policy({workdirHook:{create:`echo SB_WORKDIR=${join(base,'elsewhere')}`}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:escape}),rejected);
  const counted=policy({workdirHook:{create:'false'}});
  await assert.rejects(provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:counted,runHook:async()=>{calls++;return {code:1,stdout:'',stderr:'',timedOut:false};}}));
  assert.equal(calls,1);
});
test('cleanup removes only provisioned directories and keeps dirty worktrees',async t=>{
  const {root,policy}=sandbox(t);const app=join(root,'app');repo(app);const p=policy();
  const isolated=await provisionWorkdir({request:{mode:'isolated'},taskId:TASK,generation:1,policy:p});
  assert.equal((await cleanupWorkdir(isolated.cwd,isolated.info,TASK,p)).state,'removed');assert.equal(existsSync(isolated.cwd),false);
  const clean=await provisionWorkdir({request:{mode:'worktree',repo:app,name:'clean'},taskId:TASK,generation:1,policy:p});
  assert.equal((await cleanupWorkdir(clean.cwd,clean.info,TASK,p)).state,'removed');assert.equal(existsSync(clean.cwd),false);
  const dirty=await provisionWorkdir({request:{mode:'worktree',repo:app,name:'dirty'},taskId:TASK,generation:2,policy:p});
  writeFileSync(join(dirty.cwd,'source.txt'),'changed');
  const kept=await cleanupWorkdir(dirty.cwd,dirty.info,TASK,p);assert.equal(kept.state,'remove-failed');assert.equal(existsSync(dirty.cwd),true);
  await assert.rejects(cleanupWorkdir(app,{mode:'existing',state:'provisioned'},TASK,p),{code:'workdir-cleanup-unsupported'});
  const hookPolicy=policy({workdirHook:{create:'mkdir "$SB_NAME"',remove:'rm -r "$SB_WORKDIR"'}});
  const hooked=await provisionWorkdir({request:{mode:'hook'},taskId:TASK,generation:1,policy:hookPolicy});
  assert.equal((await cleanupWorkdir(hooked.cwd,hooked.info,TASK,hookPolicy)).state,'removed');assert.equal(existsSync(hooked.cwd),false);
  await assert.rejects(cleanupWorkdir(hooked.cwd,hooked.info,TASK,policy({workdirHook:{create:'true'}})),{code:'workdir-cleanup-unsupported'});
});
test('evidence denies sensitive names and symlink aliases before reading and downloading',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'super-bot-sensitive-')));
  try {
    for(const path of ['.ssh/id_rsa','.aws/config','.config/service/credentials','credentials','cert.pem','.env','.env.local']) {
      const full=join(root,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,'synthetic secret');
      await assert.rejects(collectEvidence(root,[path]),{code:'evidence-sensitive'});
      await assert.rejects(readEvidence(root,{path:full,sha256:'old',bytes:16}),{code:'evidence-sensitive'});
    }
    symlinkSync(join(root,'.ssh/id_rsa'),join(root,'alias.txt'));
    await assert.rejects(collectEvidence(root,['alias.txt']),{code:'evidence-sensitive'});
    await assert.rejects(collectEvidence(root,['missing.txt']),error=>error instanceof Error&&!error.message.includes(root));
    writeFileSync(join(root,'result.md'),'safe');assert.equal((await collectEvidence(root,['result.md'])).length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
