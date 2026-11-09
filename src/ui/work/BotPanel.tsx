/** Bot-level controls: sidebar helpers, Bot settings and the manager conversation status. */
import type { Bot } from '../../model.ts';
import { Hint } from '../kit.tsx';
import { time } from './format.ts';
import type { WorkspaceState } from './useWorkspace.ts';

const TIDY_HINT = '整理仅处理已加载且可确认由当前 Bot 自动创建的会话，不唤醒未加载历史。已有项目分组名请在原生侧栏菜单改名；'
  + '历史保留手动归档，不自动隐藏待验收或可返工的工作。';

function SidebarActions({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  const sessionId = bot.managerSessionId;
  if (!sessionId) return null;
  const pin = () => w.mutate('sidebar.pin', { botId: bot.id, sessionId }, () => w.setSidebarNotice({
    botId: bot.id, text: '已置顶主聊天。你可随时在原生侧栏取消；打开或整理不会重新置顶。',
  }));
  const tidy = () => w.mutate<{ renamed: number; kept: number; failed: number }>('sidebar.tidy', { botId: bot.id, sessionId }, value =>
    w.setSidebarNotice({
      botId: bot.id,
      text: `已整理 ${value.renamed} 个会话名，保留 ${value.kept} 个，失败 ${value.failed} 个`
        + `${value.failed ? '（可重试，不会重新执行任务）' : ''}。不改已有项目分组名、用户名称、置顶或归档。`,
    }));
  return <div className="actions">
    <button disabled={w.locked} onClick={pin}>置顶主聊天</button>
    <button disabled={w.locked} onClick={tidy}>整理自动会话名</button>
  </div>;
}

function ManagerStatus({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  const info = w.managerInfo;
  if (info?.binding?.state !== 'ready') return null;
  const binding = info.binding, limit = info.wakeLimit ?? 20;
  const replace = () => w.mutate<{ sessionId: string }>('manager.replace', {
    requestId: `replace:${binding.id}`, botId: bot.id, expectedGeneration: binding.generation,
  }, value => w.api.openSession(value.sessionId));
  return <details><summary className="muted">管理会话设置</summary>
    <p className="muted">更换会创建新对话，并从账本恢复工作。旧对话和任务均保留。</p>
    <button disabled={w.locked} onClick={replace}>更换管理会话</button>
    <p className="muted">待处理通知 {info.pending} · 最近一小时自动唤醒 {info.hourlyWakes}/{limit}</p>
    {info.uncertain > 0 && <p>有 {info.uncertain} 条通知送达待核对，请在管理对话读取最新账本。</p>}
    {info.hourlyWakes >= limit && <p>最近一小时自动管理额度已用完；队列保留，仍可在管理对话手动处理。</p>}
  </details>;
}

export function BotPanel({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  const info = w.managerInfo, limit = info?.wakeLimit ?? 20;
  const openManager = () => bot.managerSessionId ? w.api.openSession(bot.managerSessionId)
    : w.mutate<{ sessionId: string }>('manager.prepare', { requestId: crypto.randomUUID(), botId: bot.id },
      value => w.api.openSession(value.sessionId));
  return <>
    <SidebarActions w={w} bot={bot}/>
    {w.sidebarNotice?.botId === bot.id && <p className="muted" role="status">{w.sidebarNotice.text}</p>}
    <Hint>{TIDY_HINT}</Hint>
    <details className="bot-intro advanced"><summary>Bot 设置与管理</summary>
      <h2>{bot.name}</h2><p>{bot.instructions}</p>
      <p className="muted">配置版本 {bot.configRevision} · 参考文本 {bot.materials.length} 份</p>
      {bot.materials.length > 0 && <details><summary className="muted">已保存的参考文本</summary>
        {bot.materials.map(material => <p key={material.path} className="wrap">{material.path} · {material.bytes} 字节</p>)}
      </details>}
      <button disabled={w.locked} onClick={() => w.setForm(w.form === 'bot-edit' ? null : 'bot-edit')}>编辑 Bot 设置</button>{' '}
      <button disabled={w.locked} onClick={openManager}>{bot.managerSessionId ? '打开 Bot 管理对话' : '启用 Bot 管理对话'}</button>
      <Hint>在管理对话选择模型后，Bot 会读取账本并安排完整、未暂停的任务。默认仍由你最终验收。</Hint>
      <ManagerStatus w={w} bot={bot}/>
      {info && info.hourlyWakes >= limit && info.pending > 0 && <p className="notice" role="status">
        最近一小时已自动管理 {limit} 次，{info.pending} 条通知正在等待额度恢复。仍可打开管理对话手动处理。
      </p>}
      {info?.problem && <p className="notice" role="alert">{info.problem.message} · {time(info.problem.at)}</p>}
    </details>
    {info?.problem && <p className="notice" role="alert">{info.problem.message}</p>}
  </>;
}
