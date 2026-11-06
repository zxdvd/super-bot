import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';

test('persists across reopening and uses WAL on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-'));
  try {
    const file = join(dir, 'ledger.sqlite');
    const first = new Store(file);
    first.set('session', 'session-1');
    assert.equal(first.sqliteInfo().journalMode, 'wal');
    first.close();
    const reopened = new Store(file);
    assert.equal(reopened.get('session'), 'session-1');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refuses future schema without changing its version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-'));
  try {
    const file = join(dir, 'ledger.sqlite');
    const db = new DatabaseSync(file); db.exec('PRAGMA user_version=42'); db.close();
    assert.throws(() => new Store(file), /更新版本/);
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 42); check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commands are idempotent and conflicting reuse is rejected', () => {
  const store = new Store(':memory:');
  try {
    const bot = store.createBot('bot-1',{name:'开发 Bot',instructions:'维护网站'});
    assert.deepEqual(store.createBot('bot-1',{name:'开发 Bot',instructions:'维护网站'}),bot);
    assert.throws(() => store.createBot('bot-1',{name:'另一个',instructions:'维护网站'}),/不同的内容/);
    const input = {botId:bot.id,goal:'修复搜索',scope:'网站搜索',acceptance:'现有测试通过',reviewPolicy:'human' as const};
    const task = store.createTask('task-1',input);
    assert.deepEqual(store.createTask('task-1',input),task);
    assert.equal(store.listTasks({botId:bot.id}).total,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get()?.n,1);
  } finally { store.close(); }
});

test('failed audit write rolls back task, input, and idempotency record', () => {
  const store = new Store(':memory:');
  try {
    const bot = store.createBot('bot-1',{name:'Bot',instructions:'测试'});
    store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.kind='task.created' BEGIN SELECT RAISE(ABORT,'test fault'); END");
    const input = {botId:bot.id,goal:'测试',scope:'临时目录',acceptance:'可读取',reviewPolicy:'human' as const};
    assert.throws(() => store.createTask('task-1',input),/test fault/);
    assert.equal(store.listTasks({botId:bot.id}).total,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get()?.n,0);
    store.db.exec('DROP TRIGGER reject_event');
    assert.ok(store.createTask('task-1',input).id);
  } finally { store.close(); }
});

test('stale edits fail and control changes do not increment task revision', () => {
  const store = new Store(':memory:');
  try {
    const bot = store.createBot('b',{name:'Bot',instructions:'测试'});
    const task = store.createTask('t',{botId:bot.id,goal:'测试',scope:'',acceptance:'',reviewPolicy:'human'});
    assert.equal(task.status,'needs-input');
    assert.equal(store.taskDetail(task.id).attentions.filter(a=>a.state==='open').length,1);
    const revised = store.reviseTask('r',task.id,1,{goal:'测试',scope:'临时文件',acceptance:'文件包含内容'});
    assert.equal(revised.taskRevision,2);
    assert.equal(revised.status,'unscheduled');
    assert.equal(store.taskDetail(task.id).attentions.filter(a=>a.state==='open').length,0);
    assert.throws(()=>store.controlTask('stale',task.id,1,'paused'),/已经更新/);
    const paused = store.controlTask('pause',task.id,2,'paused');
    assert.equal(paused.taskRevision,2); assert.equal(paused.rowVersion,3); assert.equal(paused.status,'paused');
  } finally { store.close(); }
});

test('100 tasks have consistent filtered counts and stable pagination', () => {
  const store = new Store(':memory:');
  try {
    const bot = store.createBot('b',{name:'Bot',instructions:'测试'});
    const other = store.createBot('other',{name:'Other',instructions:'测试'});
    for (let i=0;i<100;i++) store.createTask(`t${i}`,{botId:bot.id,goal:`任务 ${i}`,scope:'目录',acceptance:'检查',reviewPolicy:'human'});
    store.createTask('other-task',{botId:other.id,goal:'不混入',scope:'',acceptance:'',reviewPolicy:'human'});
    const ids = new Set<string>();
    for(let offset=0;offset<100;offset+=25){const page=store.listTasks({botId:bot.id,offset});assert.equal(page.total,100);assert.equal(page.counts.all,100);page.items.forEach(t=>ids.add(t.id));}
    assert.equal(ids.size,100);
    const found=store.listTasks({botId:bot.id,q:'任务 9'});assert.equal(found.total,11);assert.equal(found.counts.all,11);
    assert.equal(store.listTasks({botId:bot.id,q:'%'}).total,0);
  } finally { store.close(); }
});

test('exclusive database ownership prevents a second host and releases on close', () => {
  const dir=mkdtempSync(join(tmpdir(),'super-bot-'));
  try {
    const file=join(dir,'ledger.sqlite'); const first=new Store(file);
    assert.throws(()=>new Store(file),/另一宿主/);
    first.close(); const next=new Store(file); next.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
