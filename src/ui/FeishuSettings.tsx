import { useEffect, useId, useRef, useState } from 'react';
import type { FeishuCheckResult, FeishuSettingsView } from '../feishu-types.ts';
import { feishuConnectionLabel } from './feishu-format.ts';
import { Hint, Section, Tag } from './kit.tsx';
import { styles } from './styles.ts';
import type { WorkspaceApi } from './work/api.ts';

const credentialLabel = { passed: '通过', failed: '失败', unverified: '未验证' };
const permissionLabel = { passed: '通过', missing: '缺少', unverified: '未验证' };
const scopeLabel: Record<string, string> = {
  'im:message.group_at_msg:readonly': '接收群内 @ 机器人的消息',
  'im:message:send_as_bot': '以机器人身份发送消息',
  'im:chat:read': '读取群信息',
  'im:chat:create': '创建群（仅新建私有群时用到）',
  'im:chat.members:read': '读取群成员（绑定他人担任群主的群时用到）',
};

function CheckDetails({ result }: { result: FeishuCheckResult }) {
  return <Section title="检测结果">
    <p>凭证换取令牌 <Tag>{credentialLabel[result.credentials]}</Tag></p>
    {result.permissions.map(({ scope, status }) => <p key={scope}>
      {scopeLabel[scope]} <code>{scope}</code> <Tag>{permissionLabel[status]}</Tag>
    </p>)}
    <Hint>请在飞书应用后台核对未验证的权限与事件订阅。默认在群内 @ 机器人并附上正文。</Hint>
  </Section>;
}

type Draft = Pick<FeishuSettingsView, 'appId' | 'ownerOpenId'>;
type Action = 'check' | 'save';

function requestError(cause: unknown, action: Action): string {
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  switch (code) {
    case 'feishu-settings-input': return '请核对 App ID、App Secret 和 Open ID。';
    case 'feishu-settings-storage': return '无法访问当前 DSH profile 的设置文件，请核对文件权限后重试。';
    case 'feishu-unavailable': return '当前宿主正在停止飞书连接，请稍后重试。';
    default: return action === 'check' ? '暂时无法检测，请稍后重试。' : '暂时无法确认保存结果，请重新打开设置核对。';
  }
}

export function FeishuSettings({ api, close }: { api: WorkspaceApi; close: () => void }) {
  const [view, setView] = useState<FeishuSettingsView>();
  const [draft, setDraft] = useState<Draft>();
  const [secretEntered, setSecretEntered] = useState(false);
  const [readError, setReadError] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<FeishuCheckResult>();
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<Action>();
  const lifetime = useRef<AbortSignal>(), busy = useRef(false), revision = useRef(0);
  const secret = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    lifetime.current = signal;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!busy.current && document.visibilityState !== 'hidden') {
        const startedAtRevision = revision.current;
        const current = () => !signal.aborted && startedAtRevision === revision.current;
        try {
          const next = await api.call<FeishuSettingsView>('feishu.settings.get', {}, signal);
          if (current()) {
            setView(next);
            setDraft(existing => existing ?? { appId: next.appId, ownerOpenId: next.ownerOpenId });
            setReadError(false);
          }
        } catch {
          if (current()) setReadError(true);
        }
      }
      if (!signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api]);

  function clearFeedback() { setResult(undefined); setError(''); setSaved(false); }
  const canReuseSecret = view?.hasSecret;
  const canSubmit = draft?.appId.trim() && draft.ownerOpenId.trim() && (secretEntered || canReuseSecret);
  async function perform(action: Action) {
    const signal = lifetime.current;
    if (!signal || signal.aborted || busy.current || readError || !draft || !canSubmit) return;
    busy.current = true;
    revision.current++;
    clearFeedback();
    setPending(action);
    const fields = { appId: draft.appId.trim(), appSecret: secret.current?.value ?? '', ownerOpenId: draft.ownerOpenId.trim() };
    try {
      if (action === 'check') {
        const next = await api.call<FeishuCheckResult>('feishu.settings.check', fields, signal);
        if (!signal.aborted) setResult(next);
      } else {
        const next = await api.call<FeishuSettingsView>('feishu.settings.save', fields, signal);
        if (!signal.aborted) {
          if (secret.current) secret.current.value = '';
          setSecretEntered(false);
          setView(next);
          setDraft({ appId: next.appId, ownerOpenId: next.ownerOpenId });
          setSaved(true);
        }
      }
    } catch (cause) {
      if (!signal.aborted) setError(requestError(cause, action));
    } finally {
      busy.current = false;
      if (!signal.aborted) setPending(undefined);
    }
  }

  const disabled = !!pending || readError;
  const messageDate = view?.lastMessageAt == null ? undefined : new Date(view.lastMessageAt);
  return <div className="sb"><style>{styles}</style><main className="sb-wrap" style={{ maxWidth: 820 }}>
    <header className="sb-header">
      <h1>设置</h1>
      <button type="button" autoFocus disabled={pending === 'save'} onClick={close}>← 我的 Bot</button>
    </header>
    <h2>飞书</h2>
    <p className="muted">
      保存后会启用当前 DSH profile 的飞书长连接。要同步群聊，请到各 Bot 的「工作 → 设置与维护 → 飞书群」绑定。
    </p>
    {readError ? <p className="notice error" role="alert">暂时无法读取当前 DSH profile 的设置，稍后会自动重试。</p>
      : view ? <Section title="连接状态">
        <div role="status">
          <p>长连接 · <strong>{feishuConnectionLabel[view.connection]}</strong></p>
          <p>最近收到的绑定群文本 · {messageDate
            ? <time dateTime={messageDate.toISOString()}>{messageDate.toLocaleString('zh-CN')}</time>
            : <span>尚未收到消息</span>}</p>
          {view.error && <p className="muted">{view.error}</p>}
        </div>
      </Section> : <p role="status" className="muted">正在读取飞书设置…</p>}
    {draft && <form className="form" onSubmit={event => { event.preventDefault(); void perform('check'); }}>
      <label htmlFor={id + '-app'}>App ID</label>
      <input id={id + '-app'} value={draft.appId} disabled={disabled} maxLength={200} placeholder="cli_…"
        autoComplete="off" required onChange={event => {
          setDraft({ ...draft, appId: event.target.value }); clearFeedback();
        }}/>
      <label htmlFor={id + '-secret'}>App Secret</label>
      <input id={id + '-secret'} type="password" ref={secret} disabled={disabled} maxLength={2048} autoComplete="new-password"
        required={!canReuseSecret} placeholder={canReuseSecret ? '已保存，留空可继续使用' : undefined}
        onChange={event => { setSecretEntered(!!event.target.value.trim()); clearFeedback(); }}/>
      <label htmlFor={id + '-owner'}>Open ID</label>
      <input id={id + '-owner'} value={draft.ownerOpenId} disabled={disabled} maxLength={200} placeholder="ou_…"
        autoComplete="off" required aria-describedby={id + '-owner-hint'} onChange={event => {
          setDraft({ ...draft, ownerOpenId: event.target.value }); clearFeedback();
        }}/>
      <p className="muted hint" id={id + '-owner-hint'}>填写你本人在这个应用下的 Open ID。</p>
      <div className="actions">
        <button type="submit" disabled={disabled || !canSubmit}>{pending === 'check' ? '正在检测…' : '检测配置'}</button>
        <button type="button" className="primary" disabled={disabled || !canSubmit} onClick={() => void perform('save')}>
          {pending === 'save' ? '正在保存…' : '保存并连接'}
        </button>
      </div>
    </form>}
    <div role="status">{saved && <p>设置已保存。</p>}</div>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div aria-live="polite">{result && <CheckDetails result={result}/>}</div>
  </main></div>;
}
