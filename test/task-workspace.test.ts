import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {taskWorkspace} from '../src/task-workspace.ts';
import {collectEvidence,readEvidence} from '../src/evidence.ts';

test('project worktrees preserve committed source, isolate writes and reuse task generations',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'super-bot-worktree-')));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'}).toString().trim();
  try {
    git('init');writeFileSync(join(root,'source.txt'),'committed');git('add','source.txt');
    git('-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','-m','fixture');
    writeFileSync(join(root,'source.txt'),'uncommitted');
    const a=await taskWorkspace(root,'task-a',1),b=await taskWorkspace(root,'task-b',1);
    assert.equal(readFileSync(join(a,'source.txt'),'utf8'),'committed');
    writeFileSync(join(a,'source.txt'),'worker a');assert.equal(readFileSync(join(b,'source.txt'),'utf8'),'committed');
    assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'uncommitted');
    assert.equal(await taskWorkspace(root,'task-a',1),a);
    assert.notEqual(await taskWorkspace(root,'task-a',2),a);
    assert.equal(git('branch','--show-current').length>0,true);
    assert.equal(git('status','--porcelain','--untracked-files=all'),'M source.txt');
  }finally{rmSync(root,{recursive:true,force:true});}
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
