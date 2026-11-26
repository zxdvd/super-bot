import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitLabHttp } from '../src/gitlab-client.ts';
import { discoverRelease, exactMergeReference, releaseReadback, type ReleaseTarget } from '../src/gitlab-release.ts';
import type { Run } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { botWorkSummaries } from '../src/work-activity.ts';

const origin='https://gitlab.fixture.invalid';
const mr=origin+'/fixture/release/-/merge_requests/11';
const condition=exactMergeReference(mr)!;
const signal=new AbortController().signal;
const sha='c'.repeat(40);
const pipeline={id:35,sha,ref:'main',project_id:21,source:'push',web_url:origin+'/fixture/release/-/pipelines/35'};
const target:ReleaseTarget={origin,project:condition.project,projectId:21,pipelineId:35,jobId:44,name:'publish-artifact',sha,ref:'main'};
const job={id:44,name:target.name,status:'manual',stage:'deploy',pipeline,web_url:origin+'/fixture/release/-/jobs/44'};
const lint={valid:true,includes:[],merged_yaml:'publish-artifact:\n  environment:\n    name: fixture\n    action: start\n'};

test('formal discovery only binds a job on the merged commit in the exact known GitLab project',async()=>{
  const reads:string[]=[];
  const stage=await discoverRelease(condition,{},async(path)=>{
    reads.push(path);
    return {code:200,data:reads.length===1?{iid:11,project_id:21,target_project_id:21,web_url:mr,state:'merged',merge_commit_sha:sha,target_branch:'main'}:
      reads.length===2?[pipeline]:reads.length===3?[job]:lint};
  },signal);
  assert.deepEqual(stage.releaseJob,target);
  assert.deepEqual(reads,[
    '/api/v4/projects/fixture%2Frelease/merge_requests/11',
    `/api/v4/projects/21/pipelines?sha=${sha}&ref=main&source=push&per_page=100`,
    '/api/v4/projects/21/pipelines/35/jobs?include_retried=true&per_page=100',
    `/api/v4/projects/21/ci/lint?content_ref=${sha}`,
  ]);
  let count=0;
  const wrong=await discoverRelease(condition,{},async()=>({code:200,data:++count===1?
    {iid:11,project_id:21,target_project_id:21,web_url:mr,state:'merged',merge_commit_sha:sha,target_branch:'main'}:
    count===2?[pipeline]:count===3?[{...job,pipeline:{...pipeline,id:36}}]:lint}),signal);
  assert.equal(wrong.state,'unavailable');
  assert.equal(wrong.releaseJob,undefined);
});

test('discovery asks once for distinct selectable names but never swaps to a retried job',async()=>{
  const discover=(jobs:unknown[])=>discoverRelease(condition,{},async(path)=>({code:200,data:path.includes('merge_requests')?
    {iid:11,project_id:21,target_project_id:21,web_url:mr,state:'merged',merge_commit_sha:sha,target_branch:'main'}:
    path.includes('/jobs?')?jobs:[pipeline]}),signal);
  const named={...job,id:46,name:'blue',stage:'check',web_url:origin+'/fixture/release/-/jobs/46'};
  const alreadyDone={...job,id:50,name:'deploy-latest',status:'success',web_url:origin+'/fixture/release/-/jobs/50'};
  const observed=await discover([job,named,alreadyDone]);
  assert.deepEqual(observed.releaseChoices?.map(({jobId,name})=>({jobId,name})),[{jobId:44,name:job.name},{jobId:46,name:'blue'}]);
  assert.equal((await discover([job,{...job,id:46}])).releaseJob,undefined);
});

test('a Job name or deploy stage alone cannot prove a deployment and exact selection works after 100 jobs',async()=>{
  const merger={iid:11,project_id:21,target_project_id:21,web_url:mr,state:'merged',merge_commit_sha:sha,target_branch:'main'};
  const cleanup={...job,name:'release-cleanup'};
  const unsafe=await discoverRelease(condition,{},async(path)=>({code:200,data:
    path.includes('merge_requests')?merger:path.includes('/jobs?')?[cleanup]:path.includes('/ci/lint')?
      {...lint,merged_yaml:'release-cleanup:\n  environment:\n    name: fixture\n    action: stop\n'}:[pipeline]}),signal);
  assert.equal(unsafe.releaseJob,undefined);
  assert.deepEqual(unsafe.releaseChoices?.map(choice=>choice.name),['release-cleanup']);
  const blue={...job,id:46,name:'blue',stage:'check',status:'running',web_url:origin+'/fixture/release/-/jobs/46'};
  const actualDeployment=await discoverRelease(condition,{},async(path)=>({code:200,data:
    path.includes('merge_requests')?merger:path.includes('/jobs?')?[cleanup,blue]:path.includes('/ci/lint')?
      {...lint,merged_yaml:'blue:\n  environment:\n    name: 合成环境\n    action: start\n'}:[pipeline]}),signal);
  assert.equal(actualDeployment.releaseJob?.jobId,46);
  assert.equal(actualDeployment.stateLabel,'running');
  let pages=0;
  const named=await discoverRelease(condition,{jobName:job.name},async(path)=>({code:200,data:
    path.includes('merge_requests')?merger:path.includes('/jobs?')?(++pages===1?
      Array.from({length:100},(_,i)=>({id:i+101,name:'test '+i})):[job]):[pipeline]}),signal);
  assert.equal(pages,2);
  assert.deepEqual(named.releaseJob,target);
});

test('GitLab HTTP sends credentials to only the exact source and refuses redirects',async()=>{
  let calls=0;
  const request=gitLabHttp(origin,'local-read-token',async(url,init)=>{
    calls++;
    assert.equal(String(url),origin+'/api/v4/projects/21/jobs/44');
    assert.equal(init?.redirect,'error');
    assert.equal(init?.method,'GET');
    assert.equal((init.headers as Record<string,string>)['PRIVATE-TOKEN'],'local-read-token');
    return new Response('{}',{status:200});
  });
  assert.equal((await request('/api/v4/projects/21/jobs/44',signal)).code,200);
  assert.equal((await request('https://other.invalid/api/v4/projects/21/jobs/44',signal)).code,0);
  assert.equal(calls,1);
});

function enter(store:Store, taskId:string, key:string):Run {
  const run=store.reserveRun(key,taskId,store.getTask(taskId).rowVersion);
  store.saveRunMessage(run.id,'message-'+key,'{}');
  assert.equal(store.claimDispatch(run.id),true);
  store.inputEnqueued(run.id);
  store.inputEntered(run.id,'message-'+key,12);
  return run;
}

function arrange(store:Store,key:string) {
  const bot=store.createBot(key+'-bot',{name:key,instructions:'Synthetic tasks'});
  const manager=store.beginManager(key+'-manager',bot.id,'/tmp/super-bot-fixture');
  store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask(key+'-task',{botId:bot.id,goal:'Publish',scope:'Only fixture release',
    acceptance:'Report exact status',reviewPolicy:'human'});
  const binding=store.beginBinding(key+'-binding',task.id,task.rowVersion,'/tmp/super-bot-fixture');
  store.claimBindingCreation(binding.id);
  store.confirmBinding(binding.id,binding.requestedSessionId);
  const old=enter(store,task.id,key+'-old');
  store.workerReport(old.id,'stage',{kind:'stage',stage:'MR',summary:'MR prepared',evidenceRef:mr,checks:'Exact MR captured'});
  store.settleRun(old.id);
  const source={sessionId:manager.requestedSessionId,messageId:key+'-owner-message',seq:10,text:'Go ahead with this release.'};
  return {bot,task,old,source};
}

function release(store:Store,key:string,prep=arrange(store,key)) {
  const {bot,task,old,source}=prep;
  store.advanceStage(key+'-advance',bot.id,task.id,store.getTask(task.id).rowVersion,old.id,'Publish',condition,origin,false,
    {release:{intent:'publish',source}});
  const due=store.dueStages(4).find(item=>item.runId===old.id)!;
  store.recordStageObservation(due,{state:'satisfied',stateLabel:'manual',detail:'Verified by provider',releaseJob:target},due.checkAt);
  const run=enter(store,task.id,key+'-formal');
  return {run,task,...store.beginGitLabRelease(run.id)};
}

test('an exact GitLab release receipt stays active after its notice until the observer reaches a blocker', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { run, task, stageRunId, url } = release(store, 'watch');
  assert.equal(store.claimGitLabRelease(run.id), true);
  const claimed = store.gitLabReleaseReceipt(stageRunId)!;
  const tracking = releaseReadback(claimed, { code: 200, data: { ...job, status: 'running' } });
  store.recordGitLabRelease(claimed, tracking, true);
  store.workerReport(run.id, 'track', { kind: 'stage', stage: 'Release started', summary: 'Watching exact job',
    evidenceRef: url, checks: 'Matched the claimed job' });
  store.settleRun(run.id);
  for (const event of store.managerNotifications(task.botId)) store.settleManagerEvent(event.id);
  const assertActivity = (activity: 'working' | 'attention') => {
    const detail = store.taskDetail(task.id);
    assert.equal(detail.task.activity, activity);
    assert.equal(store.taskInbox(task.botId).items.find(item => item.id === task.id)?.activity, activity);
    assert.equal(botWorkSummaries(store.db)[0]?.[activity], 1);
  };
  assertActivity('working');
  const expired = releaseReadback(tracking, { code: 503 }, false, tracking.deadlineAt);
  store.recordGitLabRelease(tracking, expired);
  assertActivity('attention');
});

test('schema 14 migrates and keeps globally single formal claim through lost receipt and reopen',t=>{
  const dir=mkdtempSync(join(tmpdir(),'super-bot-gitlab-'));
  const path=join(dir,'ledger.sqlite');
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  let store=new Store(path);
  const prepared=arrange(store,'old');
  store.close();
  const v14=new DatabaseSync(path);
  v14.exec('DROP TABLE gitlab_release_claims; DROP TABLE gitlab_release_receipts; DROP TABLE gitlab_release_plans; PRAGMA user_version=14');
  v14.close();
  store=new Store(path);
  const accepted=release(store,'old',prepared);
  assert.equal(store.claimGitLabRelease(accepted.run.id),true);
  assert.equal(store.claimGitLabRelease(accepted.run.id),false);
  const before=store.gitLabReleaseReceipt(accepted.stageRunId)!;
  assert.equal(before.state,'claim-pending');
  store.close();
  const migrated=new DatabaseSync(path,{readOnly:true});
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version,15);
  migrated.close();
  store=new Store(path);
  t.after(()=>store.close());
  assert.deepEqual(store.gitLabReleaseReceipt(accepted.stageRunId),before);
  assert.equal(store.claimGitLabRelease(accepted.run.id),false);
  const another=release(store,'other-task');
  assert.equal(store.claimGitLabRelease(another.run.id),false,'different task cannot claim the same exact job');
  assert.equal(another.state,'unknown');
  const manual=releaseReadback(before,{code:200,data:job},false,before.nextCheckAt!);
  assert.equal(manual.state,'unknown');
  assert.equal(manual.status,'manual');
  store.recordGitLabRelease(before,manual);
  const notice=store.pendingManagerEvents(accepted.task.botId).find(item=>item.id.includes('gitlab-release:'));
  assert.ok(notice&&JSON.parse(notice.payload).reason.includes(manual.url),'original-chat notice carries the verified exact job link');
  const confirmed=releaseReadback(manual,{code:200,data:{...job,status:'success'}},false,manual.nextCheckAt!);
  assert.equal(confirmed.state,'success');
  assert.equal(confirmed.target.jobId,44);
  assert.equal(releaseReadback(manual,{code:503},false,manual.deadlineAt).state,'expired');
  const preclaim=releaseReadback({...before,state:'unsubmitted'},{code:503});
  assert.equal(preclaim.state,'unsubmitted');
  assert.ok(preclaim.nextCheckAt);
});

test('formal authorization cannot move between bots, stage versions or MR references',t=>{
  const store=new Store(':memory:');
  t.after(()=>store.close());
  const {bot,task,old,source}=arrange(store,'one');
  const foreign=arrange(store,'two').source;
  const advance=(source:typeof foreign, ref=condition, version=store.getTask(task.id).rowVersion)=>
    store.advanceStage('bad-'+source.messageId,bot.id,task.id,version,old.id,'Publish',ref,origin,false,
      {release:{source,intent:'publish'}});
  assert.throws(()=>advance(foreign),{code:'gitlab-release-scope'});
  assert.throws(()=>advance(source,{...condition,number:12}),{code:'gitlab-release-scope'});
  assert.throws(()=>advance(source,condition,store.getTask(task.id).rowVersion-1),{code:'stage-stale'});
  assert.equal(store.gitLabReleaseForStage(old.id),null);
});

test('structured release choices require a current observed object and preserve the real owner message',t=>{
  const store=new Store(':memory:');
  t.after(()=>store.close());
  const {bot,task,old,source}=arrange(store,'intent');
  const second=arrange(store,'foreign');
  const attempt=(seq:number,selection?:{observedAt:number;target:ReleaseTarget},sessionId=source.sessionId)=>
    store.advanceStage('intent-'+seq,bot.id,task.id,store.getTask(task.id).rowVersion,old.id,'Publish',condition,origin,false,
      {release:{source:{...source,seq,sessionId,text:'Dann bitte diese Variante.'},intent:'select',jobName:job.name,selection}});
  assert.throws(()=>store.createTask('bad-grant',{botId:bot.id,goal:'Publish',scope:'Fixture',acceptance:'Result',reviewPolicy:'human'},
    {...source,text:'The exact link is '+mr+'1'},undefined,{reference:mr}),{code:'gitlab-release-scope'});
  const created=store.createTask('exact-grant',{botId:bot.id,goal:'Publish',scope:'Fixture',acceptance:'Result',reviewPolicy:'human'},
    {...source,text:'この件をお願いします '+mr},undefined,{reference:mr,jobName:job.name});
  assert.equal(store.gitLabTaskAuthorization(created.id,mr)?.jobName,job.name);
  store.advanceStage('discover',bot.id,task.id,store.getTask(task.id).rowVersion,old.id,'Publish',condition,origin,false,
    {release:{source,intent:'clarify'}});
  const due=store.dueStages(4)[0]!;
  store.recordStageObservation(due,{state:'unsatisfied',detail:'Please select',releaseChoices:[target]},due.checkAt);
  assert.throws(()=>attempt(20),{code:'gitlab-release-scope'});
  assert.throws(()=>attempt(21,{observedAt:due.checkAt-1,target}),{code:'gitlab-release-scope'});
  assert.throws(()=>attempt(22,{observedAt:due.checkAt,target:{...target,jobId:45}}),{code:'gitlab-release-scope'});
  assert.throws(()=>attempt(23,{observedAt:due.checkAt,target},second.source.sessionId),{code:'gitlab-release-scope'});
  assert.equal(attempt(24,{observedAt:due.checkAt,target}).stage.state,'waiting');
  const saved=store.gitLabReleaseForStage(old.id);
  assert.equal(saved?.source.text,'Dann bitte diese Variante.');
  assert.equal(saved?.retryTarget?.jobId,target.jobId);

  store.advanceStage('foreign-discover',second.bot.id,second.task.id,store.getTask(second.task.id).rowVersion,second.old.id,
    'Publish',condition,origin,false,{release:{source:second.source,intent:'clarify'}});
  const secondDue=store.dueStages(4).find(item=>item.runId===second.old.id)!;
  store.recordStageObservation(secondDue,{state:'unsatisfied',detail:'Please select',releaseChoices:[target]},secondDue.checkAt);
  const direct=store.advanceStage('foreign-directed',second.bot.id,second.task.id,store.getTask(second.task.id).rowVersion,
    second.old.id,'Publish',condition,origin,false,{release:{source:{...second.source,seq:30,text:'Run the artifact entry I named.'},
      intent:'publish',jobName:job.name}});
  assert.equal(direct.stage.state,'waiting','a new explicit request for an exact job needs no displayed option');
  assert.equal(store.gitLabReleaseForStage(second.old.id)?.jobName,job.name);
});
