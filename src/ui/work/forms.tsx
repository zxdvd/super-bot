/** Bot, task and reply forms. Each submission keeps one request ID until the user edits the form. */
import { useRef, useState, type FormEvent } from 'react';
import type { Bot, Task } from '../../model.ts';
import { Hint } from '../kit.tsx';
import type { Submit } from './types.ts';

function useRequest() {
  const request = useRef(crypto.randomUUID());
  const [validation, setValidation] = useState('');
  const changed = () => { request.current = crypto.randomUUID(); setValidation(''); };
  return { request, validation, setValidation, changed };
}
function FormActions({ busy, label, cancel }: { busy: boolean; label: string; cancel: () => void }) {
  return <div className="actions">
    <button className="primary" disabled={busy}>{busy ? '保存中…' : label}</button>
    <button type="button" disabled={busy} onClick={cancel}>取消</button>
  </div>;
}
const Invalid = ({ text }: { text: string }) => text ? <p className="notice error" role="alert">{text}</p> : null;

export function BotForm({ bot, submit, cancel, busy }: { bot?: Bot; submit: Submit; cancel: () => void; busy: boolean }) {
  const [name, setName] = useState(bot?.name ?? ''); const [instructions, setInstructions] = useState(bot?.instructions ?? '');
  const [references, setReferences] = useState(bot?.materials.map(material => material.path).join('\n') ?? '');
  const expectedRevision = useRef(bot?.configRevision);
  const { request, validation, setValidation, changed } = useRequest();
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !instructions.trim()) { setValidation('请填写名称和职责，不能只填空格。'); return; }
    const referencePaths = references.split('\n').map(path => path.trim()).filter(Boolean);
    await submit({ requestId: request.current, name, instructions, expectedRevision: expectedRevision.current, referencePaths });
  }
  return <form className="form" onSubmit={save}>
    <h2>{bot ? '编辑 Bot 设置' : '创建你的 Bot'}</h2><p className="muted">给它一项清楚、长期的职责。</p>
    <label htmlFor="sb-bot-name">名称</label>
    <input disabled={busy} id="sb-bot-name" autoFocus required maxLength={80} placeholder="例如：开发 Bot" value={name}
      onChange={e => { changed(); setName(e.target.value); }}/>
    <label htmlFor="sb-bot-instructions">职责与边界</label>
    <textarea disabled={busy} id="sb-bot-instructions" required maxLength={10000} placeholder="负责哪些工作，什么事情需要先问你？"
      value={instructions} onChange={e => { changed(); setInstructions(e.target.value); }}/>
    <label htmlFor="sb-bot-references">本地参考文本（可选）</label>
    <textarea disabled={busy} id="sb-bot-references" maxLength={8000} placeholder="每行一个绝对文件路径，例如 /path/to/guide.md"
      value={references} onChange={e => { changed(); setReferences(e.target.value); }}/>
    <Hint>保存时读取并保存快照，模型可读取这些材料。最多 4 份 UTF-8 文本，每份 16 KiB；不会自动重新读取原文件。技能文本不会扩大工具权限。</Hint>
    {bot && <p className="notice">
      已有任务保留创建时的职责与参考材料。配置变化后旧管理对话保留，但不再能管理任务；请重新启用管理对话并选择模型。
    </p>}
    <Invalid text={validation}/>
    <FormActions busy={busy} label={bot ? '保存设置' : '创建 Bot'} cancel={cancel}/>
  </form>;
}

export function TaskForm({ task, submit, cancel, busy }: { task?: Task; submit: Submit; cancel: () => void; busy: boolean }) {
  const expectedRowVersion = useRef(task?.rowVersion);
  const [goal, setGoal] = useState(task?.goal ?? ''); const [scope, setScope] = useState(task?.scope ?? '');
  const [acceptance, setAcceptance] = useState(task?.acceptance ?? '');
  const [autoReview, setAutoReview] = useState(task?.reviewPolicy === 'bot'); const [startPaused, setStartPaused] = useState(false);
  const { request, validation, setValidation, changed } = useRequest();
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!goal.trim()) { setValidation('请填写任务目标，不能只填空格。'); return; }
    await submit({ requestId: request.current, goal, scope, acceptance, reviewPolicy: autoReview ? 'bot' : 'human', startPaused,
      expectedRowVersion: expectedRowVersion.current });
  }
  return <form className="form" onSubmit={save}><h2>{task ? '修改任务' : '新任务'}</h2>
    <label htmlFor="sb-task-goal">要完成什么</label>
    <textarea disabled={busy} id="sb-task-goal" autoFocus required maxLength={10000} value={goal}
      onChange={e => { changed(); setGoal(e.target.value); }} placeholder="描述一个可以独立验收的目标"/>
    <label htmlFor="sb-task-scope">范围与限制</label>
    <textarea disabled={busy} id="sb-task-scope" maxLength={10000} value={scope}
      onChange={e => { changed(); setScope(e.target.value); }} placeholder="允许修改什么？哪些内容需要保留？"/>
    <label htmlFor="sb-task-acceptance">怎样算完成</label>
    <textarea disabled={busy} id="sb-task-acceptance" maxLength={10000} value={acceptance}
      onChange={e => { changed(); setAcceptance(e.target.value); }} placeholder="期望看到的成果和验证结果"/>
    <Hint>范围或验收条件可以稍后补充；补全前任务不会派发。</Hint>
    {!task && <label className="check">
      <input disabled={busy} type="checkbox" checked={autoReview} onChange={e => { changed(); setAutoReview(e.target.checked); }}/>
      允许 Bot 最终验收这个低风险任务
    </label>}
    {!task && <label className="check">
      <input disabled={busy} type="checkbox" checked={startPaused} onChange={e => { changed(); setStartPaused(e.target.checked); }}/>
      创建后先暂停（稍后安排或关联已有会话）
    </label>}
    <Invalid text={validation}/>
    <FormActions busy={busy} label={task ? '保存修改' : '创建任务'} cancel={cancel}/>
  </form>;
}

export function ReplyForm({ label, busy, submit }: {
  label: string; busy: boolean; submit: (text: string, requestId: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(''); const request = useRef(crypto.randomUUID());
  return <form className="form" onSubmit={e => { e.preventDefault(); if (text.trim()) void submit(text, request.current); }}>
    <label>{label}<textarea disabled={busy} required maxLength={10000} value={text}
      onChange={e => { setText(e.target.value); request.current = crypto.randomUUID(); }}/></label>
    <button disabled={busy || !text.trim()}>保存{label}</button>
    <Hint>启用 Manager 后会自动安排；未启用时需点击“开始执行”。暂停或人工接管期间保留输入，需先恢复自动管理。</Hint>
  </form>;
}

export function RecoveryPanel({ busy, confirm }: { busy: boolean; confirm: () => void }) {
  const [checked, setChecked] = useState(false);
  return <div className="attention-box">
    <p>请打开原生会话，检查文件与可能的外部效果。确认后会释放本次占用，任务保持暂停，不会重放旧输入。</p>
    <label className="check">
      <input disabled={busy} type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/>
      我已检查，确认可以结束本次尝试
    </label>
    <button disabled={busy || !checked} onClick={confirm}>完成核对</button>
  </div>;
}
