/** Pure inbox/board projection used by the work view; no React or host needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/model.ts';
import {
  RESULT_FRESH_MS, ago, boardGroups, inboxGroups, inboxSection, stage, stageText, stageTone, unseenResult,
} from '../src/ui/work/format.ts';

const NOW = 1_800_000_000_000;
let n = 0;
function task(patch: Partial<Task>): Task {
  n++;
  return {
    id: `t${n}`, botId: 'b', goal: `goal ${n}`, scope: 's', acceptance: 'a', reviewPolicy: 'human', lifecycle: 'open', controlMode: 'auto',
    taskRevision: 1, rowVersion: 1, sessionId: null, createdAt: NOW - 1000, updatedAt: NOW - 1000, status: 'unscheduled',
    botConfigRevision: 1, ...patch,
  };
}

test('stages collapse twelve statuses into six and keep the concrete reason as text', () => {
  assert.equal(stage(task({ status: 'needs-input' })), 'needs-you');
  assert.equal(stage(task({ status: 'approval' })), 'needs-you');
  assert.equal(stage(task({ status: 'recovery' })), 'needs-you');
  assert.equal(stage(task({ status: 'manual' })), 'needs-you');
  for (const status of ['running', 'queued', 'stopping'] as const) assert.equal(stage(task({ status })), 'running');
  assert.equal(stage(task({ status: 'paused' })), 'waiting');
  assert.equal(stage(task({ status: 'unscheduled' })), 'waiting');
  assert.equal(stage(task({ lifecycle: 'review', status: 'paused' })), 'review', 'paused review is still review');
  assert.equal(stage(task({ lifecycle: 'completed', status: 'completed' })), 'done');
  assert.equal(stage(task({ lifecycle: 'cancelled', status: 'cancelled' })), 'cancelled');
  assert.equal(stageText(task({ status: 'approval' })), '原生审批待处理');
  assert.equal(stageText(task({ status: 'paused' })), '已暂停');
  assert.equal(stageText(task({ lifecycle: 'review', status: 'paused' })), '待验收');
  assert.equal(stageTone(task({ status: 'recovery' })), 'danger');
  assert.equal(stageTone(task({ status: 'needs-input' })), 'attention');
});

test('inbox puts what needs the user first, ordered by urgency, then active work, then a short recent tail', () => {
  const review = task({ lifecycle: 'review', status: 'review', updatedAt: NOW - 10 });
  const input = task({ status: 'needs-input', updatedAt: NOW - 500 });
  const recovery = task({ status: 'recovery', updatedAt: NOW - 900 });
  const running = task({ status: 'running' });
  const waiting = task({ status: 'unscheduled', updatedAt: NOW - 5 });
  const fresh = task({ lifecycle: 'completed', status: 'completed', updatedAt: NOW - 60_000 });
  const old = task({ lifecycle: 'completed', status: 'completed', updatedAt: NOW - RESULT_FRESH_MS - 1 });
  const cancelled = task({ lifecycle: 'cancelled', status: 'cancelled' });
  const groups = inboxGroups([waiting, old, review, running, fresh, input, cancelled, recovery], {}, NOW);
  assert.deepEqual(groups.attention.map(t => t.id), [recovery.id, input.id, review.id, fresh.id]);
  assert.deepEqual(groups.active.map(t => t.id), [running.id, waiting.id]);
  assert.deepEqual(new Set(groups.recent.map(t => t.id)), new Set([old.id, cancelled.id]));
});

test('a finished result stays new until opened at its current version', () => {
  const done = task({ lifecycle: 'completed', status: 'completed', updatedAt: NOW - 1000 });
  assert.equal(unseenResult(done, undefined, NOW), true);
  assert.equal(inboxSection(done, done.updatedAt, NOW), 'recent');
  assert.equal(unseenResult(done, done.updatedAt - 1, NOW), true, 'a later update is new again');
  assert.equal(unseenResult(task({ lifecycle: 'review', status: 'review' }), undefined, NOW), false);
});

test('recent tail is bounded and newest first', () => {
  const finished = Array.from({ length: 12 }, (_, i) => task({ lifecycle: 'cancelled', status: 'cancelled', updatedAt: NOW - i * 1000 }));
  const recent = inboxGroups(finished, {}, NOW, 5).recent;
  assert.deepEqual(recent.map(t => t.id), finished.slice(0, 5).map(t => t.id));
});

test('board columns follow stages and leave cancelled tasks out', () => {
  const tasks = [task({ status: 'running' }), task({ status: 'paused' }), task({ status: 'approval' }),
    task({ lifecycle: 'review', status: 'review' }), task({ lifecycle: 'completed', status: 'completed' }),
    task({ lifecycle: 'cancelled', status: 'cancelled' })];
  const board = boardGroups(tasks);
  assert.deepEqual(Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])),
    { waiting: 1, running: 1, 'needs-you': 1, review: 1, done: 1 });
});

test('relative times are short', () => {
  assert.equal(ago(NOW - 10_000, NOW), '刚刚');
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5 分钟前');
  assert.equal(ago(NOW - 3 * 3600_000, NOW), '3 小时前');
  assert.equal(ago(NOW - 2 * 86400_000, NOW), '2 天前');
});
