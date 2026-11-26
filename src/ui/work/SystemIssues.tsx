/** Problems that stop the Bot from managing work, each with the one action that addresses it. */
import type { ReactNode } from 'react';
import type { ChatDeliveryStatus, Result, UncertainDelivery } from '../../model.ts';
import { ConfirmAction } from '../kit.tsx';
import { time } from './format.ts';
import type { WorkspaceState } from './useWorkspace.ts';

type Issue = { key: string; text: ReactNode; action?: ReactNode };

export function managerOpener(w: WorkspaceState) {
  const bot = w.bot;
  return () =>
    !bot
      ? undefined
      : bot.managerSessionId
        ? w.api.openSession(bot.managerSessionId)
        : w.mutate<{ sessionId: string }>(
            'manager.prepare',
            { requestId: crypto.randomUUID(), botId: bot.id },
            (value) => w.api.openSession(value.sessionId),
          );
}

function DeliveryCheck({
  w,
  notice,
  onReturn,
  fromInbox = false,
}: {
  w: WorkspaceState;
  notice: UncertainDelivery;
  onReturn?: () => void;
  fromInbox?: boolean;
}) {
  const { id, taskId, taskGoal, resultId, reason, sessionId, at, turn } = notice;
  const openChat = (chatId: string) =>
    w.sessionId === chatId && onReturn ? onReturn() : w.api.openSession(chatId);
  return (
    <div className="attention-box">
      {fromInbox ? (
        <>
          <strong className="wrap">{taskGoal}</strong>{' '}
          <button
            className="small"
            onClick={() => w.select(taskId, { kind: 'result', taskId, resultId })}
          >
            查看这份成果
          </button>
        </>
      ) : (
        <strong>{deliveryLabels.uncertain}</strong>
      )}
      <p className="muted wrap">成果 {resultId}</p>
      <p>{reason}</p>
      {sessionId ? (
        <p>
          请在原聊天核对{turn === undefined ? ` ${time(at)} 起的回复` : `第 ${turn} 轮的回复`}
          ，确认这份成果的链接和附件能否打开。
        </p>
      ) : (
        <p>账本没有可定位的原聊天。请用成果 ID 在原对话中核对链接和附件。</p>
      )}
      <div className="actions">
        {sessionId && (
          <button className="small" disabled={w.locked} onClick={() => openChat(sessionId)}>
            打开原聊天
          </button>
        )}
        <ConfirmAction
          label="标记此通知已处理"
          disabled={w.locked}
          explanation="仅在核对这份成果的送达情况并处理完毕后确认。此操作只关闭这条待核对通知，成果验收仍在任务详情。"
          submit={() =>
            w.mutate('manager.notification.resolve', {
              requestId: `notification-handled:${id}`,
              botId: w.botId,
              eventId: id,
              resolution: 'handled',
              acknowledged: true,
            })
          }
        />
      </div>
    </div>
  );
}

export const deliveryLabels = {
  'awaiting-review': '原聊天交付 · 等待 Bot 检查成果',
  pending: '原聊天交付 · 等待可核对的回复',
  uncertain: '原聊天交付 · 需核对送达情况',
  delivered: '原聊天交付 · 已确认成果链接',
  handled: '原聊天交付 · 交付通知已由用户处理',
};

export function ResultDeliveryCheck({
  w,
  result,
  status,
  onReturn,
  historical = false,
}: {
  w: WorkspaceState;
  result: Result;
  status?: ChatDeliveryStatus | null;
  onReturn?: () => void;
  historical?: boolean;
}) {
  if (w.mirror) return null;
  const notice = w.managerInfo?.uncertainDeliveries?.find(
    (item) => item.taskId === result.taskId && item.resultId === result.id,
  );
  if (notice && (!status || status.state === 'uncertain')) {
    return <DeliveryCheck key={notice.id} w={w} notice={notice} onReturn={onReturn} />;
  }
  return status && (!historical || status.state === 'handled') ? (
    <p className="muted">
      {deliveryLabels[status.state]}
      {status.reason && `。${status.reason}`}
    </p>
  ) : null;
}

export function SystemIssues({ w, onReturn }: { w: WorkspaceState; onReturn?: () => void }) {
  const bot = w.bot,
    info = w.managerInfo,
    openManager = managerOpener(w);
  if (!bot || w.mirror) return null;
  const limit = info?.wakeLimit ?? 20,
    warnings = w.status?.configWarnings ?? [],
    issues: Issue[] = [];
  const deliveries = info?.uncertainDeliveries ?? [],
    other = (info?.uncertain ?? 0) - deliveries.length;
  const open = (label: string) => (
    <button className="small" disabled={w.locked} onClick={() => void openManager()}>
      {label}
    </button>
  );
  if (!bot.managerSessionId)
    issues.push({
      key: 'manager',
      text: '管理对话未启用，任务不会被自动安排。',
      action: open('启用管理对话'),
    });
  if (info?.problem && !deliveries.some((notice) => notice.id === info.problem?.eventId))
    issues.push({
      key: 'problem',
      text: (
        <>
          {info.problem.message} <span className="muted">· {time(info.problem.at)}</span>
        </>
      ),
      action: bot.managerSessionId && open('打开管理对话'),
    });
  if (info && info.hourlyWakes >= limit && info.pending > 0)
    issues.push({
      key: 'wakes',
      text: `最近一小时已自动管理 ${limit} 次，${info.pending} 条通知等待额度恢复。`,
      action: open('手动处理'),
    });
  if (!deliveries.length && other > 0)
    issues.push({
      key: 'uncertain',
      text: `${other} 条通知送达待核对。`,
      action: open('打开管理对话'),
    });
  if (warnings.length)
    issues.push({
      key: 'config',
      text: `${warnings.length} 条配置提示。`,
      action: (
        <button className="small" onClick={() => w.setView('settings')}>
          查看设置
        </button>
      ),
    });
  if (!issues.length && !deliveries.length) return null;
  return (
    <section className="issues" aria-label="系统问题">
      {issues.map((issue) => (
        <div key={issue.key} className="issue" role="status">
          <span className="state-dot attention" aria-hidden />
          <span className="issue-text">{issue.text}</span>
          {issue.action}
        </div>
      ))}
      {!!deliveries.length && (
        <div className="issue">
          <details className="issue-text">
            <summary>{info?.uncertain} 条通知送达待核对 · 查看成果通知</summary>
            {deliveries.map((notice) => (
              <DeliveryCheck key={notice.id} w={w} notice={notice} onReturn={onReturn} fromInbox />
            ))}
            {other > 0 && (
              <p>
                {other} 条其他通知待核对。 {open('打开管理对话')}
              </p>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
