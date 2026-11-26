/** Settings page: Bot definition, manager conversation, sidebar helpers and ledger maintenance. */
import { useState } from 'react';
import type { Bot } from '../../model.ts';
import type { BackupInfo } from '../../backups.ts';
import { ConfirmAction, Hint, Section } from '../kit.tsx';
import { FeishuPanel } from './FeishuPanel.tsx';
import { forgetView, rememberBot, rememberedBot, rememberedView } from './storage.ts';
import { managerOpener } from './SystemIssues.tsx';
import type { WorkspaceState } from './useWorkspace.ts';
import { WorkerCapacityPanel } from './WorkerCapacityPanel.tsx';

const TIDY_HINT =
  '整理仅处理已加载且可确认由当前 Bot 自动创建的会话，不唤醒未加载历史。已有项目分组名请在原生侧栏菜单改名；' +
  '历史保留手动归档，不自动隐藏待验收或可返工的工作。';
const DELETE_RETENTION =
  '任务历史、原生会话和工作文件会保留。已绑定的飞书群将停止同步，飞书群会保留。';

function SidebarActions({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  const sessionId = bot.managerSessionId;
  if (!sessionId) return <p className="muted">启用管理对话后可置顶与整理侧栏。</p>;
  const pin = () =>
    w.mutate('sidebar.pin', { botId: bot.id, sessionId }, () =>
      w.setSidebarNotice({
        botId: bot.id,
        text: '已置顶主聊天。你可随时在原生侧栏取消；打开或整理不会重新置顶。',
      }),
    );
  const tidy = () =>
    w.mutate<{ renamed: number; kept: number; failed: number }>(
      'sidebar.tidy',
      { botId: bot.id, sessionId },
      (value) =>
        w.setSidebarNotice({
          botId: bot.id,
          text:
            `已整理 ${value.renamed} 个会话名，保留 ${value.kept} 个，失败 ${value.failed} 个` +
            `${value.failed ? '（可重试，不会重新执行任务）' : ''}。不改已有项目分组名、用户名称、置顶或归档。`,
        }),
    );
  return (
    <>
      <div className="actions">
        <button disabled={w.locked} onClick={pin}>
          置顶主聊天
        </button>
        <button disabled={w.locked} onClick={tidy}>
          整理自动会话名
        </button>
      </div>
      {w.sidebarNotice?.botId === bot.id && (
        <p className="muted" role="status">
          {w.sidebarNotice.text}
        </p>
      )}
      <Hint>{TIDY_HINT}</Hint>
    </>
  );
}

function ManagerSection({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  const info = w.managerInfo,
    binding = info?.binding,
    limit = info?.wakeLimit ?? 20,
    openManager = managerOpener(w);
  const replace = () =>
    binding &&
    w.mutate<{ sessionId: string }>(
      'manager.replace',
      { requestId: `replace:${binding.id}`, botId: bot.id, expectedGeneration: binding.generation },
      (value) => w.api.openSession(value.sessionId),
    );
  return (
    <Section title="管理对话">
      <p className="muted">
        在管理对话选择模型后，Bot 会读取账本并安排完整、未暂停的任务。默认仍由你最终验收。
      </p>
      <div className="actions">
        <button disabled={w.locked} onClick={() => void openManager()}>
          {bot.managerSessionId ? '打开管理对话' : '启用管理对话'}
        </button>
        {binding?.state === 'ready' && (
          <button disabled={w.locked} onClick={() => void replace()}>
            更换管理会话
          </button>
        )}
      </div>
      {info && (
        <p className="muted">
          待处理通知 {info.pending} · 最近一小时自动唤醒 {info.hourlyWakes}/{limit}
        </p>
      )}
      {binding?.state === 'ready' && (
        <Hint>更换会创建新对话，并从账本恢复工作。旧对话和任务均保留。</Hint>
      )}
    </Section>
  );
}

function Maintenance({ w }: { w: WorkspaceState }) {
  const warnings = w.status?.configWarnings ?? [];
  return (
    <Section title="账本与运行信息">
      {w.status && (
        <p className="muted">
          DSH {w.status.runtime} · 本地 SQLite / {w.status.journalMode.toUpperCase()} ·
          关闭面板不删除任务。
        </p>
      )}
      <button
        disabled={w.locked}
        onClick={() =>
          w.mutate<BackupInfo>('backup.create', { requestId: crypto.randomUUID() }, w.setBackupInfo)
        }
      >
        备份账本
      </button>
      {w.backupInfo && (
        <div className="notice" ref={w.backupNotice} role="status">
          <div>
            <strong>账本备份已保存</strong>
            <p className="wrap">{w.backupInfo.path}</p>
            <p className="muted">{w.backupInfo.scope}</p>
          </div>
          <button onClick={() => w.setBackupInfo(undefined)}>关闭</button>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice" role="status">
          <div>
            <strong>配置提示</strong>
            {warnings.map((text) => (
              <p key={text} className="wrap">
                {text}
              </p>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function BotDeletion({
  w,
  bot,
  onDeleted,
}: {
  w: WorkspaceState;
  bot: Bot;
  onDeleted: (bot: Bot) => void;
}) {
  const [error, setError] = useState<{ message: string; code?: unknown }>();
  const counts = w.page?.counts,
    unfinished = (counts?.open ?? 0) + (counts?.review ?? 0);
  const unfinishedWork = unfinished > 0 || error?.code === 'bot-unfinished';
  const force = unfinishedWork || error?.code === 'manager-busy';
  const remaining = unfinished
    ? `当前有 ${unfinished} 项未结束任务。`
    : '当前有未结束或待核对的任务。';
  const othersWithName = w.bots.some((item) => item.id !== bot.id && item.name === bot.name);
  const target = `「${bot.name}」${othersWithName ? `（${bot.id}）` : ''}`;
  const changes = unfinishedWork
    ? `${remaining} 系统会取消待处理任务，并向运行中的 Worker 请求停止。`
    : force
      ? '正在进行的 Bot 对话会收到停止请求。'
      : '';
  const submit = () =>
    w.mutate<{ botId: string }>(
      'bot.delete',
      {
        requestId: crypto.randomUUID(),
        id: bot.id,
        expectedRevision: bot.configRevision,
        confirmed: true,
        ...(force && { force }),
        ...(w.sessionId && { sessionId: w.sessionId }),
      },
      (value) => {
        if (rememberedBot() === value.botId) rememberBot('');
        if (rememberedView()?.botId === value.botId) forgetView();
        onDeleted(bot);
      },
      (cause) =>
        setError(
          cause instanceof Error
            ? { message: cause.message, code: 'code' in cause ? cause.code : undefined }
            : { message: '暂时无法确认删除结果，请核对 Bot 列表后重试。' },
        ),
    );
  return (
    <div className="sb-section">
      <ConfirmAction
        key={force ? 'force' : 'normal'}
        destructive
        disabled={w.locked || !counts}
        label={force ? '强制删除 Bot' : '删除 Bot'}
        submit={submit}
        explanation={`${force ? '强制删除' : '删除'}${target}？${changes} ${DELETE_RETENTION}`}
      />
      {error && (
        <p className="notice error" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
}

export function BotPanel({
  w,
  bot,
  focusFeishu,
  onBotDeleted,
}: {
  w: WorkspaceState;
  bot: Bot;
  focusFeishu?: boolean;
  onBotDeleted?: (bot: Bot) => void;
}) {
  return (
    <div className="settings">
      {!w.sessionId && w.bots.length > 0 && (
        <Section title="Bot">
          <div className="toolbar">
            <select
              aria-label="选择 Bot"
              disabled={w.busy}
              value={w.botId}
              onChange={(e) => w.pickBot(e.target.value)}
            >
              {w.bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button disabled={w.locked} onClick={() => w.setForm(w.form === 'bot' ? null : 'bot')}>
              ＋ 新 Bot
            </button>
          </div>
        </Section>
      )}
      <Section
        title="职责与参考材料"
        aside={
          <button
            className="small"
            disabled={w.locked}
            onClick={() => w.setForm(w.form === 'bot-edit' ? null : 'bot-edit')}
          >
            编辑
          </button>
        }
      >
        <h2>{bot.name}</h2>
        <p className="full-text muted">{bot.instructions}</p>
        <p className="caption">
          配置版本 {bot.configRevision} · 参考文本 {bot.materials.length} 份
        </p>
        {bot.materials.map((material) => (
          <p key={material.path} className="wrap caption">
            {material.path} · {material.bytes} 字节
          </p>
        ))}
      </Section>
      {!w.mirror && <WorkerCapacityPanel key={`worker-capacity:${bot.id}`} w={w} botId={bot.id} />}
      <ManagerSection w={w} bot={bot} />
      <FeishuPanel
        key={`feishu:${bot.id}`}
        api={w.api}
        botId={bot.id}
        botName={bot.name}
        locked={w.locked}
        focus={focusFeishu}
      />
      <Section title="侧栏">
        <SidebarActions w={w} bot={bot} />
      </Section>
      <Maintenance w={w} />
      {onBotDeleted && (
        <BotDeletion
          key={`delete:${bot.id}:${bot.configRevision}`}
          w={w}
          bot={bot}
          onDeleted={onBotDeleted}
        />
      )}
    </div>
  );
}
