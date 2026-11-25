/** Default work view: what needs the user, what is moving, and a short recent tail. System problems sit on top. */
import type { ReactNode } from 'react';
import type { Task } from '../../model.ts';
import { inboxGroups, stage } from './format.ts';
import { SystemIssues } from './SystemIssues.tsx';
import { TaskRow } from './TaskRow.tsx';
import type { WorkspaceState } from './useWorkspace.ts';

function Group({ w, title, tasks, aside, folded = [], total }: {
  w: WorkspaceState; title: string; tasks: Task[]; aside?: ReactNode; folded?: Task[]; total?: number;
}) {
  const shown = tasks.length + folded.length;
  const count = total ?? shown;
  if (!count) return null;
  return <section className="card inbox-group" aria-label={title}>
    <header className="group-head"><h3>{title}</h3><span className="count">{count}</span><span className="spacer"/>{aside}</header>
    {shown < count && <p className="group-empty muted">显示 {shown} 项，完整记录见“全部”。</p>}
    {tasks.map(task => <TaskRow key={task.id} w={w} task={task}/>)}
    <TestTasks w={w} tasks={folded} nested/>
  </section>;
}

export function TestTasks({ w, tasks, nested = false }: { w: WorkspaceState; tasks: Task[]; nested?: boolean }) {
  if (!tasks.length) return null;
  const blocked = tasks.filter(task => task.activity === 'attention' || stage(task) === 'needs-you').length;
  return <details className={nested ? 'group-empty' : 'card inbox-group'}>
    <summary>测试任务 · {tasks.length}{!nested && blocked > 0 && ` · ${blocked} 项需处理`}</summary>
    {tasks.map(task => <TaskRow key={task.id} w={w} task={task}/>)}
  </details>;
}

export function Inbox({ w, onReturn }: { w: WorkspaceState; onReturn?: () => void }) {
  const items = w.page?.items;
  if (!items) return <div className="card"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>;
  const groups = inboxGroups(items, w.seen, w.now);
  const clear = groups.fresh.length > 0 && <button className="small" onClick={() => w.markAllSeen(groups.fresh)}>标为已读</button>;
  return <div className="inbox">
    <SystemIssues w={w} onReturn={onReturn}/>
    {items.length === 0 ? <div className="card empty">
      <h2>还没有任务</h2>
      <p>在聊天里把事情交给 Bot，例如“调研某个方案并写对比表”或“修复某个页面的样式问题”。它会在这里出现。</p>
      <button disabled={!w.online} onClick={() => w.setForm('task')}>或直接新建任务</button>
    </div> : <>
      <Group w={w} title="进行中" tasks={groups.active}/>
      <Group w={w} title="需处理" tasks={groups.attention} folded={groups.blockedTests}/>
      <Group w={w} title="待验收" tasks={groups.review} total={w.page?.reviewTotal}/>
      <Group w={w} title="待安排或已暂停" tasks={groups.waiting}/>
      <Group w={w} title="新成果" tasks={groups.fresh} aside={clear}/>
      <Group w={w} title="最近结束" tasks={groups.recent}/>
      <TestTasks w={w} tasks={groups.tests}/>
      {w.page?.truncated && <p className="muted hint">任务较多，这里只显示最近的未完成任务；完整记录请切换到“全部”。</p>}
    </>}
  </div>;
}
