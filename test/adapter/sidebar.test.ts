import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {NativeSidebar,workerTitle} from '../../src/sidebar.ts';
import {collectEvidence} from '../../src/evidence.ts';
import {join,basename,resolve} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import SessionTitleService from '@deepseek-ai/dsh-session-title';
import {nameAutomaticSession} from '../../src/sidebar.ts';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {Managers} from '../../src/manager.ts';

function fixture() {
  const directory=realpathSync(mkdtempSync(resolve('.runtime/df08-sidebar-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'我的 Bot',instructions:'合成测试'});
  const workspaces=new Map<string,any>(),agents=new Map<string,any>(),titles=new Map<any,any>();
  const pinned=new Set<string>(),archived=new Set<string>();
  let creates=0,renames=0,retitles=0,pins=0,flushes=0;
  let renameFailure=false,flushFailure=false;
  const ctx={
    permissionPresets:{set:()=>{}},
    workspaceRegistry:{
      create:async(cwd:string,title=basename(cwd))=>{if(!workspaces.has(cwd))workspaces.set(cwd,{id:cwd,path:cwd,title,sessionIds:[],setTitle:async function(this:any,next:string){retitles++;this.title=next;},attachSession:async()=>{}});return workspaces.get(cwd);},
      get pinnedSessionIds(){return [...pinned];},get archivedSessionIds(){return [...archived];},
      pinSession:async(id:string)=>{pins++;pinned.add(id);},
      archiveSession:()=>{throw Error('DF08 must never archive');},unarchiveSession:()=>{throw Error('DF08 must never unarchive');},
    },
    sessionController:{
      create:async({workspaceId,sessionId}:any)=>{creates++;const session={id:sessionId,header:{id:sessionId,cwd:workspaceId,isSeeded:false}};agents.set(sessionId,{id:sessionId,session,status:'idle',inbox:{nextTurn:[],nextStep:[]}});workspaces.get(workspaceId).sessionIds.push(sessionId);return {sessionId};},
      resolveAgent:async(id:string)=>agents.has(id)?{agent:agents.get(id)}:{error:'missing'},
      rename:async({sessionId,title}:any)=>{renames++;titles.set(agents.get(sessionId).session,{title,source:{kind:'user'}});},
    },
    sessionTitle:{get:(session:any)=>titles.get(session),rename:(session:any,title:string)=>{if(renameFailure){renameFailure=false;throw Error('rename failed');}renames++;const next={title,source:{kind:'user'},eventSeq:renames};titles.set(session,next);return next;}},
    sessions:{get:(id:string)=>agents.get(id)?.session,flush:async()=>{flushes++;if(flushFailure){flushFailure=false;throw Error('flush failed');}return true;}},
  } as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess:true,workspace:directory});
  const managers=new Managers(ctx,store,execution,directory);
  const task=(key='task',botId=bot.id)=>store.createTask(key,{botId,goal:'DF-08 dogfooding：最小修复侧栏并保留用户已经设置的所有偏好，不要使用这整个长目标来命名项目',scope:'合成目录',acceptance:'检查命名',reviewPolicy:'human'});
  return {ctx,store,bot,directory,execution,managers,sidebar:new NativeSidebar(ctx,store),task,agents,titles,workspaces,pinned,archived,
    failRename:()=>{renameFailure=true;},failFlush:()=>{flushFailure=true;},counts:()=>({creates,renames,retitles,pins,flushes}),
    close:async()=>{await managers.dispose();await execution.dispose();store.close();assert.equal(resolve(directory),directory);assert.ok(directory.startsWith(resolve('.runtime')+'/df08-sidebar-'));rmSync(directory,{recursive:true,force:true});}};
}

test('DF08 uses actual native title source, normalization and log append semantics',async()=>{
  const ctx=new Context(),session=Session.create(SessionId('synthetic-title-only'));
  ctx.provide('sessions',{get:(id:string)=>id===session.id?session:undefined,flush:async()=>true});
  const service=new SessionTitleService(ctx,{fallbackMaxWords:8,fallbackMaxBytes:100,maxTitleBytes:200});
  // Unstarted service: real native normalization/log fold, synthetic live index/flush only.
  assert.equal(await nameAutomaticSession(ctx,session,'Worker ·  短任务\n名称'),true);
  assert.equal(service.get(session)?.title,'Worker · 短任务 名称');assert.equal(service.get(session)?.source.kind,'user');
  const seq=session.seq;assert.equal(await nameAutomaticSession(ctx,session,'不要覆盖'),false);assert.equal(session.seq,seq);
  service.rename(session,'Untitled');const userSeq=session.seq;await nameAutomaticSession(ctx,session,'也不要覆盖');assert.equal(service.get(session)?.title,'Untitled');assert.equal(session.seq,userSeq);
});

test('DF08 new Worker proactively receives a short stable task title',async()=>{
  const f=fixture();try{
    const task=f.task(),b=await f.execution.prepareSession('prepare',task.id,task.rowVersion);
    const title=f.titles.get(f.agents.get(b.sessionId!).session)?.title;
    assert.ok(title,'Worker must not remain Untitled');assert.match(title,/DF-08 dogfooding/);assert.ok([...title].length<55);assert.notEqual(title,task.goal);
  }finally{await f.close();}
});
test('DF08 new project Workspace uses stable directory name rather than first long goal',async()=>{
  const f=fixture();try{
    const task=f.task(),first=await f.execution.prepareSession('prepare',task.id,task.rowVersion);
    assert.equal(f.workspaces.get(first.cwd).title,basename(first.cwd));
    const second=f.task('second'),next=await f.execution.prepareSession('prepare-second',second.id,second.rowVersion);
    assert.notEqual(first.cwd,next.cwd);assert.equal(f.workspaces.get(next.cwd).title,basename(next.cwd));assert.equal(f.counts().retitles,0);
  }finally{await f.close();}
});

for(const failure of ['rename','flush'] as const)test(`DF08 creation ${failure} failure retries same Worker without duplicate append or creation`,async()=>{
  const f=fixture();try{
    const task=f.task();if(failure==='rename')f.failRename();else f.failFlush();
    await assert.rejects(f.execution.prepareSession('prepare',task.id,task.rowVersion),{code:'session-recovery'});
    const intent=f.store.activeBinding(task.id)!;assert.equal(intent.state,'recovery');assert.equal(f.counts().creates,1);
    const b=await f.execution.prepareSession('prepare',task.id,task.rowVersion);
    assert.equal(b.id,intent.id);assert.equal(b.sessionId,intent.requestedSessionId);assert.equal(b.state,'ready');assert.equal(f.counts().creates,1);assert.equal(f.counts().renames,1);
    await f.execution.prepareSession('prepare',task.id,task.rowVersion);assert.equal(f.counts().renames,1);
  }finally{await f.close();}
});

test('DF08 Manager interrupted creation preserves user title and existing Workspace title on retry',async()=>{
  const f=fixture();try{
    f.failFlush();await assert.rejects(f.managers.prepare('manager',f.bot.id),/flush failed/);
    const intent=f.store.activeManager(f.bot.id)!,session=f.agents.get(intent.requestedSessionId).session;
    f.titles.set(session,{title:'我的自定义主聊天',source:{kind:'user'}});f.workspaces.get(intent.cwd).title='用户项目名';
    const m=await f.managers.prepare('manager',f.bot.id);
    assert.equal(m.sessionId,intent.requestedSessionId);assert.equal(f.titles.get(session).title,'我的自定义主聊天');assert.equal(f.workspaces.get(intent.cwd).title,'用户项目名');
    assert.equal(f.counts().creates,1);assert.equal(f.counts().renames,1);assert.equal(f.counts().retitles,0);assert.equal(f.counts().pins,0);
  }finally{await f.close();}
});

for(const role of ['worker','manager'] as const)test(`DF08 ${role} native create lost receipt and concurrent retry never create twice`,async()=>{
  const f=fixture();try{
    const task=f.task(),create=f.ctx.sessionController.create.bind(f.ctx.sessionController);
    (f.ctx.sessionController as any).create=async(request:any)=>{await create(request);throw Error('native create receipt lost');};
    const prepare=()=>role==='worker'?f.execution.prepareSession('prepare',task.id,task.rowVersion):f.managers.prepare('manager',f.bot.id);
    await assert.rejects(prepare(),role==='worker'?{code:'session-recovery'}:/native create receipt lost/);
    const recovered=await Promise.all([prepare(),prepare(),prepare()]);
    assert.ok(recovered.every(binding=>binding.state==='ready'&&binding.id===recovered[0]!.id));assert.equal(f.counts().creates,1);assert.equal(f.counts().renames,1);
  }finally{await f.close();}
});

for(const role of ['worker','manager'] as const)test(`DF08 ${role} false durability result retries checkpoint without a second title append`,async()=>{
  const f=fixture();try{
    const task=f.task(),flush=(f.ctx.sessions as any).flush;
    (f.ctx.sessions as any).flush=async(session:any)=>{(f.ctx.sessions as any).flush=flush;await flush(session);return false;};
    const prepare=()=>role==='worker'?f.execution.prepareSession('prepare',task.id,task.rowVersion):f.managers.prepare('manager',f.bot.id);
    await assert.rejects(prepare(),{code:'sidebar-durability'});const ready=await prepare();assert.equal(ready.state,'ready');assert.equal(f.counts().creates,1);assert.equal(f.counts().renames,1);
  }finally{await f.close();}
});

for(const origin of ['seeded','subagent'] as const)test(`DF08 Manager rejects ${origin} recovery before mutating Workspace membership`,async()=>{
  const f=fixture();try{
    const create=f.ctx.sessionController.create.bind(f.ctx.sessionController);let attached=0;
    (f.ctx.sessionController as any).create=async(request:any)=>{
      await create(request);const workspace=f.workspaces.get(request.workspaceId),session=f.agents.get(request.sessionId).session;
      workspace.sessionIds=[];workspace.attachSession=async()=>{attached++;};
      session.header={...session.header,...(origin==='seeded'?{isSeeded:true}:{origin:'subagent'})};
      throw Error('partial create left unverified session');
    };
    await assert.rejects(f.managers.prepare('manager',f.bot.id),/partial create/);
    await assert.rejects(f.managers.prepare('manager',f.bot.id),{code:'manager-recovery'});
    assert.equal(attached,0);assert.equal(f.counts().renames,0);assert.equal(f.counts().creates,1);
  }finally{await f.close();}
});

test('DF08 Manager restores missing Workspace attachment after partial native create failure',async()=>{
  const f=fixture();try{
    const create=f.ctx.sessionController.create.bind(f.ctx.sessionController);let attached=0;
    (f.ctx.sessionController as any).create=async(request:any)=>{await create(request);const workspace=f.workspaces.get(request.workspaceId);workspace.sessionIds=[];workspace.attachSession=async(id:string)=>{attached++;workspace.sessionIds.push(id);};throw Error('native attach failed after create');};
    await assert.rejects(f.managers.prepare('manager',f.bot.id),/native attach failed/);
    const intent=f.store.activeManager(f.bot.id)!,m=await f.managers.prepare('manager',f.bot.id);
    assert.equal(m.state,'ready');assert.equal(m.sessionId,intent.requestedSessionId);assert.equal(f.counts().creates,1);assert.equal(attached,1);assert.ok(f.workspaces.get(m.cwd).sessionIds.includes(m.sessionId));assert.equal(f.counts().retitles,0);
  }finally{await f.close();}
});

test('DF08 tidy is Bot-scoped, excludes attachments, ordinary and stale manager sessions, and never changes Workspace titles',async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion);
    const other=f.store.createBot('other',{name:'Other',instructions:'合成'}),foreign=f.task('foreign',other.id),fb=await f.execution.prepareSession('prepare-foreign',foreign.id,foreign.rowVersion);
    const foreignSession=f.agents.get(fb.sessionId!).session;f.titles.set(foreignSession,{title:'foreign automatic',source:{kind:'fallback'}});
    const attachedTask=f.task('attached');f.agents.set('ordinary',{session:{id:'ordinary',header:{cwd:f.directory,isSeeded:false}}});
    f.store.attachExistingSession('attach',{taskId:attachedTask.id,expectedRowVersion:attachedTask.rowVersion,sessionId:'ordinary',cwd:f.directory,fullHistoryApproved:true,directoryApproved:true});
    const ordinary=f.agents.get('ordinary').session;f.titles.set(ordinary,{title:'ordinary automatic',source:{kind:'fallback'}});
    f.titles.delete(f.agents.get(b.sessionId!).session);
    f.workspaces.get(b.cwd).title=`Super Bot · ${task.goal.slice(0,40)}`;const oldTitle=f.workspaces.get(b.cwd).title;
    const first=await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(first.renamed,1);assert.equal(first.failed,0);
    assert.equal(f.titles.get(foreignSession).title,'foreign automatic');assert.equal(f.titles.get(ordinary).title,'ordinary automatic');assert.equal(f.workspaces.get(b.cwd).title,oldTitle);assert.equal(f.counts().retitles,0);
    const counts=f.counts();assert.equal((await f.sidebar.tidy(f.bot.id,m.sessionId!)).renamed,0);assert.equal(f.counts().renames,counts.renames);
    await assert.rejects(f.sidebar.tidy(other.id,m.sessionId!),{code:'sidebar-scope'});await assert.rejects(f.sidebar.pin(other.id,m.sessionId!),{code:'sidebar-scope'});
    f.store.releaseManager('release',f.bot.id,m.generation);await assert.rejects(f.sidebar.tidy(f.bot.id,m.sessionId!),{code:'sidebar-scope'});
  }finally{await f.close();}
});

for(const source of ['fallback','provider','user'] as const)test(`DF08 existing ${source} title has provenance-aware repeatable treatment`,async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion),session=f.agents.get(b.sessionId!).session;
    f.titles.set(session,{title:source==='user'?'Untitled':'插件旧自动标题',source:{kind:source}});
    const first=await f.sidebar.tidy(f.bot.id,m.sessionId!),renames=f.counts().renames;
    assert.equal(first.renamed,source==='user'?0:1);assert.equal(f.titles.get(session).title,source==='user'?'Untitled':workerTitle(task));
    await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.counts().renames,renames);
    f.titles.set(session,{title:'用户后续改名',source:{kind:'user'}});await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.titles.get(session).title,'用户后续改名');
  }finally{await f.close();}
});

test('DF08 explicit pin is separate from prepare/tidy and never resets user unpin',async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id);assert.equal(f.counts().pins,0);
    await f.sidebar.pin(f.bot.id,m.sessionId!);await f.sidebar.pin(f.bot.id,m.sessionId!);assert.equal(f.counts().pins,1);
    f.pinned.delete(m.sessionId!);await f.sidebar.tidy(f.bot.id,m.sessionId!);await f.managers.prepare('manager',f.bot.id);
    assert.equal(f.pinned.size,0);assert.equal(f.counts().pins,1);
    f.archived.add(m.sessionId!);const calls=f.counts();await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.counts().renames,calls.renames);assert.ok(f.archived.has(m.sessionId!));
  }finally{await f.close();}
});

test('DF08 tidy failure retries only presentation and never appends twice after uncertain flush',async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion),session=f.agents.get(b.sessionId!).session;
    f.titles.delete(session);f.failRename();assert.equal((await f.sidebar.tidy(f.bot.id,m.sessionId!)).failed,1);
    assert.equal((await f.sidebar.tidy(f.bot.id,m.sessionId!)).renamed,1);
    f.titles.delete(session);
    const flush=(f.ctx.sessions as any).flush.bind(f.ctx.sessions);(f.ctx.sessions as any).flush=async(s:any)=>{if(s===session){f.failFlush();(f.ctx.sessions as any).flush=flush;}return flush(s);};
    assert.equal((await f.sidebar.tidy(f.bot.id,m.sessionId!)).failed,1);const count=f.counts().renames;
    f.titles.set(session,{title:'持久化失败后用户改名',source:{kind:'user'}});
    assert.equal((await f.sidebar.tidy(f.bot.id,m.sessionId!)).failed,0);assert.equal(f.counts().renames,count);assert.equal(f.titles.get(session).title,'持久化失败后用户改名');
    assert.equal(f.counts().creates,2);assert.equal(f.store.latestRun(task.id),null);
  }finally{await f.close();}
});

test('DF08 cold, seeded, subagent, mismatched directory and archived histories stay native/manual',async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion),agent=f.agents.get(b.sessionId!),header=agent.session.header;
    f.titles.delete(agent.session);const count=f.counts().renames;
    for(const change of [{isSeeded:true},{origin:'subagent'},{cwd:join(f.directory,'missing')},{cwd:f.store.activeManager(f.bot.id)!.cwd}]){
      agent.session.header={...header,...change};await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.counts().renames,count);
    }
    agent.session.header=header;f.archived.add(b.sessionId!);await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.counts().renames,count);f.archived.clear();
    f.agents.delete(b.sessionId!);(f.ctx.sessionController as any).resolveAgent=()=>{throw Error('tidy must never resume Agents');};
    const tidy=await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(tidy.failed,0);assert.equal(f.counts().renames,count);
  }finally{await f.close();}
});

for(const change of ['archive','rename','replace','remove','stale-goal'] as const)test(`DF08 rechecks ${change} during asynchronous directory validation`,async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion),session=f.agents.get(b.sessionId!).session;
    f.titles.delete(session);const count=f.counts().renames,get=(f.ctx.sessions as any).get;let scheduled=false,error:unknown;
    (f.ctx.sessions as any).get=(id:string)=>{
      if(id===b.sessionId&&!scheduled){scheduled=true;queueMicrotask(()=>{try{
        if(change==='archive')f.archived.add(id);
        if(change==='rename')f.titles.set(session,{title:'等待目录期间用户改名',source:{kind:'user'}});
        if(change==='replace')f.store.releaseManager('release',f.bot.id,m.generation);
        if(change==='remove')f.agents.delete(id);
        if(change==='stale-goal'){f.store.detachSession('detach',task.id,f.store.getTask(task.id).rowVersion);f.store.reviseTask('revise',task.id,f.store.getTask(task.id).rowVersion,{goal:'新目标',scope:'合成范围',acceptance:'新检查'});}
      }catch(cause){error=cause;}});}return get(id);
    };
    if(change==='replace')await assert.rejects(f.sidebar.tidy(f.bot.id,m.sessionId!),{code:'sidebar-scope'});else await f.sidebar.tidy(f.bot.id,m.sessionId!);
    assert.equal(error,undefined);assert.equal(f.counts().renames,count);assert.equal(f.counts().pins,0);
    if(change==='rename')assert.equal(f.titles.get(session).title,'等待目录期间用户改名');
  }finally{await f.close();}
});

for(const role of ['worker','manager'] as const)test(`DF08 ${role} create mismatched ID stays refused across retries`,async()=>{
  const f=fixture();try{
    const task=f.task(),create=f.ctx.sessionController.create.bind(f.ctx.sessionController);
    (f.ctx.sessionController as any).create=async(request:any)=>{await create(request);return {sessionId:'unexpected-other-session'};};
    const prepare=()=>role==='worker'?f.execution.prepareSession('prepare',task.id,task.rowVersion):f.managers.prepare('manager',f.bot.id);
    await assert.rejects(prepare());assert.equal(f.counts().renames,0);
    await assert.rejects(prepare(),/不同会话/);assert.equal(f.counts().creates,1);assert.equal(f.counts().renames,0);
    assert.notEqual(role==='worker'?f.store.activeBinding(task.id)?.state:f.store.activeManager(f.bot.id)?.state,'ready');
  }finally{await f.close();}
});

test('DF08 same-task rework keeps native Session and short/custom title, without archive or acceptance',async()=>{
  const f=fixture();try{
    const m=await f.managers.prepare('manager',f.bot.id),task=f.task(),b=await f.execution.prepareSession('worker',task.id,task.rowVersion),session=f.agents.get(b.sessionId!).session;
    const short=f.titles.get(session).title,run=f.store.reserveRun('run',task.id,f.store.getTask(task.id).rowVersion);
    f.store.saveRunMessage(run.id,'message','{}');f.store.claimDispatch(run.id);f.store.inputEntered(run.id,'message',1);
    const file=join(f.directory,'result.md');writeFileSync(file,'合成成果');const report=f.store.workerReport(run.id,'ready',{kind:'ready',summary:'待验收',checks:'合成',evidence:await collectEvidence(f.directory,[file])});f.store.settleRun(run.id);
    await f.sidebar.tidy(f.bot.id,m.sessionId!);assert.equal(f.store.getTask(task.id).lifecycle,'review');assert.equal(f.titles.get(session).title,short);
    f.store.rejectResult('rework',task.id,f.store.getTask(task.id).rowVersion,report.resultId!,'同任务返工');
    f.titles.set(session,{title:'用户返工名',source:{kind:'user'}});const next=await f.execution.prepareSession('same-task',task.id,f.store.getTask(task.id).rowVersion);await f.sidebar.tidy(f.bot.id,m.sessionId!);
    assert.equal(next.sessionId,b.sessionId);assert.equal(f.titles.get(session).title,'用户返工名');assert.equal(f.counts().creates,2);assert.equal(f.archived.size,0);assert.equal(f.store.resultById(report.resultId!)?.humanAcceptedAt,null);assert.equal(f.store.getTask(task.id).lifecycle,'open');
  }finally{await f.close();}
});
