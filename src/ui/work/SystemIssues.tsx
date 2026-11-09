/** Problems that stop the Bot from managing work, each with the one action that addresses it. */
import type { ReactNode } from 'react';
import { time } from './format.ts';
import type { WorkspaceState } from './useWorkspace.ts';

type Issue = { key: string; text: ReactNode; action?: ReactNode };

export function managerOpener(w: WorkspaceState) {
  const bot = w.bot;
  return () => !bot ? undefined : bot.managerSessionId ? w.api.openSession(bot.managerSessionId)
    : w.mutate<{ sessionId: string }>('manager.prepare', { requestId: crypto.randomUUID(), botId: bot.id },
      value => w.api.openSession(value.sessionId));
}

export function SystemIssues({ w }: { w: WorkspaceState }) {
  const bot = w.bot, info = w.managerInfo, openManager = managerOpener(w);
  if (!bot) return null;
  const limit = info?.wakeLimit ?? 20, warnings = w.status?.configWarnings ?? [], issues: Issue[] = [];
  const open = (label: string) => <button className="small" disabled={w.locked} onClick={() => void openManager()}>{label}</button>;
  if (!bot.managerSessionId) issues.push({ key: 'manager', text: '管理对话未启用，任务不会被自动安排。', action: open('启用管理对话') });
  if (info?.problem) issues.push({ key: 'problem',
    text: <>{info.problem.message} <span className="muted">· {time(info.problem.at)}</span></>,
    action: bot.managerSessionId && open('打开管理对话') });
  if (info && info.hourlyWakes >= limit && info.pending > 0) issues.push({ key: 'wakes',
    text: `最近一小时已自动管理 ${limit} 次，${info.pending} 条通知等待额度恢复。`, action: open('手动处理') });
  if (info && info.uncertain > 0) issues.push({ key: 'uncertain', text: `${info.uncertain} 条通知送达待核对。`, action: open('打开管理对话') });
  if (warnings.length) issues.push({ key: 'config', text: `${warnings.length} 条配置提示。`,
    action: <button className="small" onClick={() => w.setView('settings')}>查看设置</button> });
  if (!issues.length) return null;
  return <section className="issues" aria-label="系统问题">
    {issues.map(issue => <div key={issue.key} className="issue" role="status">
      <span className="state-dot attention" aria-hidden/><span className="issue-text">{issue.text}</span>{issue.action}
    </div>)}
  </section>;
}
