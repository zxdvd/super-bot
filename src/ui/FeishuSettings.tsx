import { useEffect, useId, useRef, useState } from 'react';
import type { FeishuCheckResult, FeishuSelfTestView, FeishuSettingsView } from '../feishu-types.ts';
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

type Draft = Pick<FeishuSettingsView, 'appId' | 'configurationId'>;
type TestRequest = { configurationId: string; sessionId: string; startToken: string };
type TestAction = 'test.start' | 'test.retry' | 'test.stop' | 'test.skip' | 'test.confirm';
type Action = 'check' | 'save' | TestAction;

const bindingLabel = { unbound: '未绑定', skipped: '已跳过测试，身份未绑定', bound: '已绑定' };
const invalidTest = {
  conflict: '收到了不同账号或私聊的消息。本次无法确认，请重新开启测试。',
  expired: '本次测试已过期。请重新开启测试，再发送一条新消息。',
  interrupted: '本次测试已停止。请重新开启测试，再发送一条新消息。',
};

function errorCode(cause: unknown) {
  return cause instanceof Error && 'code' in cause ? cause.code : undefined;
}

function requestError(cause: unknown, action: Action): string {
  switch (errorCode(cause)) {
    case 'feishu-settings-input': return '请核对 App ID、App Secret 和当前测试状态。';
    case 'feishu-settings-storage': return '无法访问当前 DSH profile 的设置文件，请核对文件权限后重试。';
    case 'feishu-configuration-changed':
    case 'feishu-offline':
    case 'feishu-self-bound':
    case 'feishu-test-busy':
    case 'feishu-test-stale':
    case 'feishu-test-unconfirmed':
    case 'feishu-unavailable':
      if (cause instanceof Error) return cause.message;
  }
  if (action === 'check') return '暂时无法检测，请稍后重试。';
  if (action === 'save') return '暂时无法确认保存结果，请重新打开设置核对。';
  return '暂时无法确认测试操作结果，请核对状态后重试。';
}

function TestControls({ view, test, disabled, editing, retryStart, perform }: {
  view: FeishuSettingsView; test?: FeishuSelfTestView; disabled: boolean; editing: boolean; retryStart: boolean;
  perform: (action: TestAction) => void;
}) {
  const candidate = test && 'candidate' in test ? test.candidate : undefined;
  const ended = test && test.state in invalidTest;
  const ready = view.connection === 'ready';
  return <Section title="1:1 收发测试">
    <p role="status">本人身份 · <strong>{bindingLabel[view.selfBinding]}</strong>
      {view.selfBinding === 'bound' && <> · <code>{view.ownerOpenId}</code></>}</p>
    {view.selfBinding === 'bound' ? <Hint>使用此连接的 Bot 共用该身份。请在各 Bot 的「飞书群」设置里验证群同步。</Hint> : <>
      <Hint>测试使用已保存的应用 {view.appId}。完成并确认本人身份后，各 Bot 才能设置群同步。</Hint>
      {test?.state === 'waiting' && <p role="status">请在飞书私聊这个应用的机器人，发一条新文本。任意一句即可。</p>}
      {ended && <p className="notice" role="status">{invalidTest[test.state as keyof typeof invalidTest]}</p>}
      {candidate && <div className="attention-box" role="status">
        <p>接收私聊 · <strong>通过</strong> · {new Date(candidate.receivedAt).toLocaleTimeString('zh-CN')}</p>
        <p className="wrap">发件人 Open ID · <code>{candidate.openId}</code></p>
        <p className="wrap">收到的内容 · {candidate.preview}</p>
        <p>发送私聊 · <strong>{test?.state === 'sent' ? '通过（飞书接口已确认）'
          : test?.state === 'send-failed' ? '未确认' : '发送中'}</strong></p>
      </div>}
      <div className="actions">
        {(!test || ended) && <button type="button"
          disabled={disabled || editing || !ready || !(view.testStartToken || retryStart)}
          onClick={() => perform('test.start')}>{ended ? '重新开启测试' : '开启 1:1 收发测试'}</button>}
        {test?.state === 'send-failed' && <button type="button" disabled={disabled || editing || !ready}
          onClick={() => perform('test.retry')}>重试发送</button>}
        {test?.state === 'sent' && <button type="button" className="primary" disabled={disabled || editing || !ready}
          onClick={() => perform('test.confirm')}>确认这是本人</button>}
        {view.selfBinding !== 'skipped' || (test && !ended) ? <button type="button" disabled={disabled || editing}
          onClick={() => perform('test.skip')}>跳过测试</button> : null}
        {test && !ended && <button type="button" disabled={disabled} onClick={() => perform('test.stop')}>停止测试</button>}
      </div>
      {!test && !view.testStartToken && !retryStart && <Hint>请在开启测试的设置页完成或停止当前测试。</Hint>}
      <Hint>私聊接收需要飞书应用开启「接收消息」事件及 <code>im:message.p2p_msg:readonly</code> 权限。</Hint>
    </>}
  </Section>;
}

function testSession({ configurationId, sessionId }: TestRequest) {
  return { configurationId, sessionId };
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
  const [test, setTest] = useState<FeishuSelfTestView>();
  const [testReadError, setTestReadError] = useState(false);
  const testRequest = useRef<TestRequest>();
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
            setDraft(existing => existing ?? { appId: next.appId, configurationId: next.configurationId });
            setReadError(false);
            const request = testRequest.current;
            if (request && request.configurationId === next.configurationId && next.selfBinding !== 'bound') {
              try {
                const value = await api.call<FeishuSelfTestView>('feishu.settings.test.status', testSession(request), signal);
                if (current()) { setTest(value); setTestReadError(false); }
              } catch (cause) {
                if (current()) {
                  setTestReadError(errorCode(cause) !== 'feishu-test-stale');
                  if (errorCode(cause) === 'feishu-test-stale') {
                    setTest(undefined);
                    if (next.testStartToken !== request.startToken) testRequest.current = undefined;
                  }
                }
              }
            } else if (request) {
              testRequest.current = undefined;
              setTest(undefined); setTestReadError(false);
            }
          }
        } catch {
          if (current()) setReadError(true);
        }
      }
      if (!signal.aborted) timer = setTimeout(refresh, testRequest.current ? 1000 : 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api]);

  function clearFeedback() { setResult(undefined); setError(''); setSaved(false); }
  function fillFrom(next: FeishuSettingsView) {
    if (secret.current) secret.current.value = '';
    setSecretEntered(false);
    setDraft({ appId: next.appId, configurationId: next.configurationId });
  }
  function resetTest() {
    testRequest.current = undefined;
    setTest(undefined); setTestReadError(false);
  }
  function closeSettings() {
    const request = testRequest.current;
    if (request) void api.call('feishu.settings.test.stop', request).catch(() => {});
    close();
  }
  const staleDraft = view && draft?.configurationId !== view.configurationId;
  const canReuseSecret = view?.hasSecret && draft?.appId.trim() === view.appId;
  const canSubmit = draft?.appId.trim() && !staleDraft && (secretEntered || canReuseSecret);
  const editing = Boolean(staleDraft || draft?.appId.trim() !== view?.appId || secretEntered);
  async function perform(action: Action) {
    const signal = lifetime.current;
    if (!signal || signal.aborted || busy.current || readError || !view || !draft) return;
    if (action === 'check' || action === 'save') {
      if (!canSubmit) return;
    } else if (editing && action !== 'test.stop') return;
    busy.current = true;
    revision.current++;
    if (action === 'check' || action === 'save') clearFeedback();
    else setError('');
    setPending(action);
    const fields = { appId: draft.appId.trim(), appSecret: secret.current?.value ?? '' };
    try {
      if (action === 'check') {
        const next = await api.call<FeishuCheckResult>('feishu.settings.check', fields, signal);
        if (!signal.aborted) setResult(next);
      } else if (action === 'save') {
        const next = await api.call<FeishuSettingsView>('feishu.settings.save', {
          ...fields, configurationId: draft.configurationId,
        }, signal);
        if (!signal.aborted) {
          setView(next);
          fillFrom(next);
          if (view.configurationId !== next.configurationId) resetTest();
          setSaved(true);
        }
      } else {
        const configurationId = view.configurationId;
        if (action === 'test.start' && (!testRequest.current || test)) {
          if (!view.testStartToken) return;
          testRequest.current = { configurationId, sessionId: crypto.randomUUID(), startToken: view.testStartToken };
        }
        const request = testRequest.current;
        const endpoint = `feishu.settings.${action}`;
        if (action === 'test.skip' || action === 'test.confirm') {
          const confirmationToken = test?.state === 'sent' ? test.candidate.confirmationToken : undefined;
          const requestedTest = request && (action === 'test.skip' ? request : testSession(request));
          const next = await api.call<FeishuSettingsView>(endpoint, {
            configurationId, ...requestedTest, ...(action === 'test.confirm' && { confirmationToken }),
          }, signal);
          if (!signal.aborted) { setView(next); fillFrom(next); resetTest(); }
        } else if (request) {
          if (action === 'test.stop') {
            await api.call(endpoint, request, signal);
            if (!signal.aborted) resetTest();
          } else {
            const fields = action === 'test.start' ? request : testSession(request);
            const value = await api.call<FeishuSelfTestView>(endpoint, fields, signal);
            if (!signal.aborted) { setTest(value); setTestReadError(false); }
          }
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
      <button type="button" autoFocus disabled={!!pending} onClick={closeSettings}>← 我的 Bot</button>
    </header>
    <h2>飞书</h2>
    <p className="muted">
      保存会启用当前 DSH profile 的飞书长连接。连接就绪后，可开启 1:1 收发测试并绑定本人身份。
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
      {staleDraft && <button type="button" disabled={disabled} onClick={() => {
        clearFeedback(); fillFrom(view);
      }}>设置已在别处更新，载入当前设置</button>}
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
    {view?.enabled && <TestControls view={view} test={test} editing={editing} retryStart={!test && !!testRequest.current}
      disabled={disabled || testReadError} perform={action => void perform(action)}/>}
    {testReadError && <p role="alert" className="notice error">暂时无法读取私聊测试状态，稍后会自动重试。</p>}
  </main></div>;
}
