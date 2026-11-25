import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_BOT_RUNNING_TASKS, type BotCapacity } from '../../model.ts';
import { Hint, Section } from '../kit.tsx';
import type { WorkspaceState } from './useWorkspace.ts';

type Draft = { text: string; expected: number | null; requestId: string };

export function WorkerCapacityPanel({ w, botId }: { w: WorkspaceState; botId: string }) {
  const { api, locked, synced } = w;
  const [capacity, setCapacity] = useState<BotCapacity>();
  const [draft, setDraft] = useState<Draft>();
  const [readError, setReadError] = useState(false);
  const [validation, setValidation] = useState('');
  const [saved, setSaved] = useState(false);
  const readRevision = useRef(0);
  const id = useId(), hintId = id + '-hint';
  useEffect(() => {
    if (locked) return;
    const controller = new AbortController(), { signal } = controller, revision = readRevision.current;
    const current = () => !signal.aborted && revision === readRevision.current;
    void api.call<BotCapacity>('bot.capacity.get', { botId }, signal).then(value => {
      if (current()) { setCapacity(value); setReadError(false); }
    }).catch(() => { if (current()) setReadError(true); });
    return () => controller.abort();
  }, [api, botId, locked, synced]);

  const conflict = draft && capacity && draft.expected !== capacity.maxRunningTasks;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || locked || readError || conflict) return;
    const text = draft.text.trim(), maxRunningTasks = text ? Number(text) : null;
    if (maxRunningTasks !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(maxRunningTasks) || maxRunningTasks < 1)) {
      setValidation('请输入正整数，或留空恢复默认上限。');
      return;
    }
    readRevision.current++;
    await w.mutate<BotCapacity>('bot.capacity.set', {
      botId, requestId: draft.requestId, expectedMaxRunningTasks: draft.expected, maxRunningTasks,
    }, value => { setCapacity(value); setDraft(undefined); setSaved(true); });
  }

  return <Section title="Worker 并发">
    {readError && <p className="notice error slim" role="alert">暂时无法读取 Worker 并发设置，稍后会自动重试。</p>}
    {capacity ? <>
      <p>本 Bot 已占用 <strong>{capacity.botHeld}/{capacity.botLimit}</strong></p>
      <form className="form" onSubmit={save}>
        <label htmlFor={id}>同时执行的 Worker 任务上限</label>
        <input id={id} inputMode="numeric" aria-describedby={hintId} placeholder={`默认 ${DEFAULT_BOT_RUNNING_TASKS}`}
          disabled={locked || readError}
          value={draft?.text ?? String(capacity.maxRunningTasks ?? '')} onChange={event => {
            setDraft({ text: event.target.value, expected: draft ? draft.expected : capacity.maxRunningTasks,
              requestId: crypto.randomUUID() });
            setValidation(''); setSaved(false);
          }}/>
        <p id={hintId} className="muted hint">
          留空并保存可恢复默认的 {DEFAULT_BOT_RUNNING_TASKS} 个名额。
          降低上限后，已占用的名额会保留到任务收敛。
        </p>
        {validation && <p className="notice error slim" role="alert">{validation}</p>}
        {conflict && <p className="notice error slim" role="alert">上限已由其他操作更新，请载入最新设置后再编辑。</p>}
        <div className="actions">
          <button className="primary" disabled={locked || readError || !draft || conflict}>保存 Worker 上限</button>
          {conflict && <button type="button" disabled={locked || readError} onClick={() => {
            setDraft(undefined); setValidation(''); w.setError('');
          }}>载入最新设置</button>}
        </div>
        <div role="status">{saved && <p>已保存 Worker 上限。</p>}</div>
      </form>
    </> : !readError && <Hint>正在读取 Worker 并发设置…</Hint>}
  </Section>;
}
