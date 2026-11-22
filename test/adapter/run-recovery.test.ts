/** Crash-window reconciliation uses only durable facts and the original process's quiet certificate. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {verifyRunTurn,type RunEvent} from '../../src/run-proof.ts';
import schemaVersion from '../../schema-version.json' with {type:'json'};

function attempt(store:Store) {
  const bot=store.createBot('bot',{name:'Crash proof',instructions:'Synthetic only'});
  const task=store.createTask('task',{botId:bot.id,goal:'Write',scope:'Own files',acceptance:'Read',reviewPolicy:'human'});
  const b=store.beginBinding('binding',task.id,task.rowVersion,'/tmp/sb-crash-proof');store.confirmBinding(b.id,b.requestedSessionId);
  const version=store.getTask(task.id).rowVersion,run=store.reserveRun('dispatch',task.id,version);
  const source={kind:'super-bot',runId:run.id,inputId:run.inputId,taskId:task.id,generation:run.generation,taskRevision:run.taskRevision};
  const message={id:'automatic-input',source,content:[{type:'text',text:'Synthetic'}]};
  store.saveRunMessage(run.id,message.id,JSON.stringify(message));store.claimDispatch(run.id);
  store.inputEnqueued(run.id);store.inputEntered(run.id,message.id,1);store.associateRunTurn(run.id,1,0,1);
  const report=store.workerReport(run.id,'report-call',{kind:'ready',summary:'Candidate',checks:'Checked',evidence:[{path:'/tmp/sb-crash-proof/result.md',sha256:'synthetic',bytes:9}]});
  const events:RunEvent[]=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',surfaceOp:'append',data:message},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
  return {task,run,events,report,version};
}
function adapter(store:Store,events:RunEvent[],sessionId:string) {
  let reads=0;const hooks=new Map<string,Function>();
  const ctx={effect:(fn:()=>unknown)=>fn(),tools:{register:()=>()=>{}},on:(name:string,fn:Function)=>{hooks.set(name,fn);return ()=>{};},
    sessionPersistence:{open:async(id:string,mode:string)=>{reads++;assert.equal(id,sessionId);assert.equal(mode,'read');return {header:{id},read:async()=>({events:structuredClone(events)}),close:async()=>{}};}},
    // A fresh empty Job list must NEVER be evidence of old-process convergence.
    jobs:{list:()=>{throw Error('fresh Job registry was consulted');}},agents:{list:()=>{throw Error('fresh agent registry was consulted');}},
    sessionController:{resolveAgent:()=>{throw Error('must not wake an Agent');}}} as unknown as Context;
  const execution=new DshExecution(ctx,store,'/tmp/sb-crash-proof');execution.install();
  return {execution,reads:()=>reads,created:(agent:any)=>hooks.get('agent/created')?.({agent})};
}

test('durable completed turn and original quiet proof settle once across repeated adapter installation',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.db.prepare("UPDATE tasks SET reviewPolicy='bot' WHERE id=?").run(f.task.id);store.observeRunEnd(f.run.id,2,'completed',true);
    for(let i=0;i<2;i++) {
      const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
      assert.equal(store.getRun(f.run.id).state,'settled');assert.equal(store.heldRuns().length,0);
      assert.equal(store.runResult(f.run.id)?.humanAcceptedAt,null);
      assert.equal(store.getTask(f.task.id).controlMode,'paused');
      assert.throws(()=>store.managerReview(`forbidden-review:${i}`,f.task.botId,f.task.id,store.getTask(f.task.id).rowVersion,f.report.resultId!,'accept','Not authorized by recovery'),/管理判断未应用/);
      assert.equal(store.db.prepare('SELECT count(*) n FROM reviews').get()?.n,0);
      assert.equal(store.db.prepare("SELECT count(*) n FROM outbox WHERE id=?").get(`manager-event:settled:${f.run.id}`)?.n,0);
    }
    assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='run.settled'").get()?.n,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM runs').get()?.n,1);
  }finally{store.close();}
});

for(const window of ['ready-before-end','end-not-durable','external-unknown','legacy','wrong-input','wrong-turn','log-gap','duplicate-input','aborted'] as const)test(`restart keeps resources for ${window}`,async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.observeRunEnd(f.run.id,2,'completed',window!=='external-unknown');
    if(window==='ready-before-end')store.db.prepare('UPDATE run_turns SET endSeq=NULL,endKind=NULL,quiet=0').run();
    if(window==='end-not-durable')f.events.pop();
    if(window==='legacy')store.db.exec('DELETE FROM run_turns');
    if(window==='wrong-input')f.events[1].data.source.inputId='foreign';
    if(window==='wrong-turn')f.events[2].data.turn=2;
    if(window==='log-gap')f.events[2].seq=4;
    if(window==='duplicate-input')f.events.push({...f.events[1],seq:3});
    if(window==='aborted')f.events[2].data.reason.kind='aborted';
    const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
    assert.equal(store.getRun(f.run.id).state,'interrupted');assert.equal(store.getTask(f.task.id).status,'recovery');
    assert.equal(store.heldRuns().length,1);assert.equal(store.runResult(f.run.id)?.humanAcceptedAt,null);
    if(['legacy','external-unknown','ready-before-end'].includes(window))assert.equal(a.reads(),0);
  }finally{store.close();}
});

test('a settled ledger before process-local cleanup is never replayed or settled twice',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.observeRunEnd(f.run.id,2,'completed',true);store.settleRun(f.run.id);
    const a=adapter(store,[],f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
    assert.equal(a.reads(),0);assert.equal(store.getRun(f.run.id).state,'settled');assert.equal(store.heldRuns().length,0);
  }finally{store.close();}
});

test('native follow-up after durable automatic end preserves settled Run while invalidating old review',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.observeRunEnd(f.run.id,2,'completed',true);
    f.events.push({seq:3,type:'turn/start',data:{turn:2}},{seq:4,type:'user/message',surfaceOp:'append',data:{id:'native',source:{kind:'user',rpcId:'synthetic'}}});
    const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
    assert.equal(store.getRun(f.run.id).state,'settled');assert.equal(store.getTask(f.task.id).controlMode,'manual');
    assert.equal(store.getTask(f.task.id).lifecycle,'open');assert.equal(store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{store.close();}
});

test('ambiguous dispatch acknowledgement returns same interrupted attempt and never sends an input',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.db.prepare("UPDATE inputs SET state='enqueued'").run();
    store.db.prepare("UPDATE outbox SET state='sending' WHERE kind='input.deliver'").run();
    store.db.prepare('UPDATE run_turns SET turn=NULL,startSeq=NULL,inputSeq=NULL').run();
    const a=adapter(store,[],f.run.sessionId);await a.execution.whenReconciled();
    assert.equal((await a.execution.dispatch('dispatch',f.task.id,f.version)).id,f.run.id);
    assert.equal(store.getRun(f.run.id).state,'interrupted');assert.equal(store.heldRuns().length,1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM inputs WHERE id=?").get(f.run.inputId)?.n,1);await a.execution.dispose();
  }finally{store.close();}
});

test('settlement transaction failure rolls back locks, then a process restart reconciles durable facts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sb-recovery-')),path=join(dir,'ledger.sqlite');let store=new Store(path);
  try {
    const f=attempt(store);store.observeRunEnd(f.run.id,2,'completed',true);
    store.db.exec("CREATE TRIGGER fail_settle BEFORE INSERT ON events WHEN NEW.kind='run.settled' BEGIN SELECT RAISE(ABORT,'crash fault'); END");
    assert.throws(()=>store.settleRun(f.run.id),/crash fault/);assert.equal(store.getRun(f.run.id).state,'running');assert.equal(store.heldRuns().length,1);
    store.db.exec('DROP TRIGGER fail_settle');store.close();store=new Store(path);
    const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
    assert.equal(store.getRun(f.run.id).state,'settled');assert.equal(store.heldRuns().length,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('schema 8 migration preserves old runs and locks without inventing turn evidence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sb-legacy-')),path=join(dir,'ledger.sqlite');let store=new Store(path);
  try {
    const f=attempt(store);store.close();
    const old=new DatabaseSync(path);old.exec('DROP TABLE run_turns; PRAGMA user_version=8;');old.close();
    store=new Store(path);assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,schemaVersion);assert.equal(store.runTurn(f.run.id),null);
    const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
    assert.equal(a.reads(),0);assert.equal(store.getRun(f.run.id).state,'interrupted');assert.equal(store.heldRuns().length,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('proof coordinates are immutable and cannot cross an extra turn boundary',()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.observeRunEnd(f.run.id,2,'completed',true);
    assert.throws(()=>store.associateRunTurn(f.run.id,2,0,1),/同一请求/);
    assert.throws(()=>store.observeRunEnd(f.run.id,3,'completed',true),/同一请求/);
    f.events.splice(2,0,{seq:2,type:'turn/start',data:{turn:2}});f.events[3].seq=3;
    const proof={...store.runTurn(f.run.id)!,endSeq:3};
    assert.throws(()=>verifyRunTurn(f.run,store.getRunInput(f.run.id),proof,f.events),/同一轮次/);
  }finally{store.close();}
});

test('lazy restored Agent quarantines only the exact old automatic pending input and preserves human messages',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.db.prepare("UPDATE inputs SET state='unknown' WHERE id=?").run(f.run.inputId);
    const a=adapter(store,[],f.run.sessionId);await a.execution.whenReconciled();
    const own=f.events[1].data,user={id:'human',source:{kind:'user',rpcId:'synthetic'}},foreign={id:'foreign',source:{kind:'super-bot',runId:'other'}};
    const pending=[own,user,foreign],removed:string[]=[];
    const agent={id:f.run.sessionId,inbox:{nextTurn:pending,nextStep:[],remove:(id:string)=>{removed.push(id);pending.splice(pending.findIndex(m=>m.id===id),1);}}};
    a.created(agent);a.created(agent);
    assert.deepEqual(removed,[own.id]);assert.deepEqual(pending,[user,foreign]);
    assert.equal(store.getRunInput(f.run.id).state,'unknown');assert.equal(store.heldRuns().length,1);await a.execution.dispose();
  }finally{store.close();}
});

test('durable cancelled budget Run reconciles idempotently without waking a Manager',async()=>{
  const store=new Store(':memory:');try {
    const f=attempt(store);store.recordRunBudget(f.run.id,'steps');
    store.requestStop('stop',f.task.id,store.getTask(f.task.id).rowVersion);
    f.events[2].data.reason.kind='aborted';store.observeRunEnd(f.run.id,2,'aborted',true);
    for(let i=0;i<2;i++) {
      const a=adapter(store,f.events,f.run.sessionId);await a.execution.whenReconciled();await a.execution.dispose();
      assert.equal(store.getRun(f.run.id).state,'cancelled');assert.equal(store.heldRuns().length,0);
      assert.equal(store.getTask(f.task.id).controlMode,'paused');assert.equal(store.runResult(f.run.id)?.humanAcceptedAt,null);
      assert.equal(store.db.prepare('SELECT count(*) n FROM outbox WHERE id=?').get(`manager-event:budget-stopped:${f.run.id}`)?.n,0);
    }
    assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='run.cancelled'").get()?.n,1);
  }finally{store.close();}
});
