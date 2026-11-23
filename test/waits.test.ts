/** FIFO admission for execution slots, through ledger commands. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';

function setup(max=2) {
  const store=new Store(':memory:');store.maxRunningTasks=max;
  const bot=store.createBot('bot',{name:'FIFO',instructions:'Synthetic only'});
  const manager=store.beginManager('manager',bot.id,'/tmp/sb-fifo-manager');store.confirmManager(manager.id,manager.requestedSessionId);
  const task=(name:string,cwd:string)=>{
    const created=store.createTask(`task-${name}`,{botId:bot.id,goal:`Goal ${name}`,scope:'Own files',acceptance:'Read back',reviewPolicy:'human'});
    const binding=store.beginBinding(`bind-${name}`,created.id,created.rowVersion,cwd);store.confirmBinding(binding.id,binding.requestedSessionId);
    return created.id;
  };
  const run=(id:string)=>store.reserveRun(`run-${id}-${Math.random()}`,id,store.getTask(id).rowVersion);
  const wait=(id:string)=>{store.recordWait(id);store.enqueueManager(bot.id,`capacity:${id}:${store.getTask(id).rowVersion}`,'wait',id);};
  const finish=(runId:string)=>{store.db.prepare('DELETE FROM resources WHERE runId=?').run(runId);store.db.prepare('UPDATE runs SET finishedAt=? WHERE id=?').run(Date.now(),runId);};
  return {store,bot,task,run,wait,finish};
}

test('independent tasks can share a directory and a nested directory',t=>{
  const {store,task,run}=setup(3);
  t.after(()=>store.close());
  const a=task('a','/repo/app'),b=task('b','/repo/app'),c=task('c','/repo/app/sub');
  const first=run(a);
  assert.throws(()=>run(a),{code:'run-active'},'the same task still cannot get a second Run');
  assert.equal(store.dispatchWait(b),null);
  const second=run(b),third=run(c);
  assert.deepEqual(new Set(store.heldRuns().map(r=>r.id)),new Set([first.id,second.id,third.id]));
});
test('slot fairness counts earlier runnable waiters; stale or paused waiters do not block the line',()=>{
  const {store,task,run,wait,finish}=setup(1);
  const a=task('a','/w/a'),b=task('b','/w/b'),c=task('c','/w/c');
  const first=run(a);
  assert.equal(store.dispatchWait(b)?.code,'capacity');wait(b);
  assert.equal(store.dispatchWait(c)?.code,'capacity');wait(c);
  finish(first.id);
  assert.deepEqual(store.dispatchWait(c),{code:'capacity',holderTaskId:b,holderGoal:'Goal b'});
  assert.equal(store.dispatchWait(b),null);
  store.db.prepare("UPDATE outbox SET state='done' WHERE id LIKE ?").run(`manager-event:capacity:${b}:%`);
  assert.equal(store.dispatchWait(c),null,'a waiter whose resource notification ended no longer holds a place');
  store.db.prepare("UPDATE outbox SET state='pending' WHERE id LIKE ?").run(`manager-event:capacity:${b}:%`);
  const task_b=store.getTask(b);store.controlTask('pause-b',b,task_b.rowVersion,'paused');
  assert.equal(store.dispatchWait(c),null,'a paused waiter does not block others');
  wait(c);wait(c);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM waits WHERE taskId=?').get(c)?.n,1,'re-deferral keeps one place');
});
test('cancel and detach leave the line',()=>{
  const {store,task,wait}=setup();
  const a=task('a','/x'),b=task('b','/y');wait(a);wait(b);
  store.cancelTask('cancel-a',a,store.getTask(a).rowVersion);
  store.detachSession('detach-b',b,store.getTask(b).rowVersion);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM waits').get()?.n,0);
});
