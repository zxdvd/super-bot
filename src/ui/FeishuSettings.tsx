import { DeveloperSettings } from './DeveloperSettings.tsx';
import { useEffect, useId, useRef, useState } from 'react';
import type { FeishuCheckResult, FeishuSelfTestView, FeishuSettingsView } from '../feishu-types.ts';
import type { Bot } from '../model.ts';
import { feishuConnectionLabel } from './feishu-format.ts';
import { Hint, Section } from './kit.tsx';
import { styles } from './styles.ts';
import type { WorkspaceApi } from './work/api.ts';

const credentialLabel = { passed: '凭证有效', failed: '凭证无效', unverified: '凭证未验证' };
const ownerLabel = { bound: '本人已绑定', unbound: '本人未绑定', skipped: '本人未绑定' };

type Draft = Pick<FeishuSettingsView, 'appId' | 'configurationId'>;
type TestRequest = { configurationId: string; sessionId: string; startToken: string };
type TestAction = 'test.start' | 'test.retry' | 'test.stop' | 'test.skip' | 'test.confirm';
type Action = 'check' | 'save' | 'verify' | TestAction;

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
  if (action === 'check' || action === 'verify') return '暂时无法检测凭证，请稍后重试。';
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
  return <Section title="绑定本人">
    {!test && <p>请通过一条飞书私聊消息确认本人身份。</p>}
    {test?.state === 'waiting' && <p role="status">请在飞书私聊这个应用的机器人，发一条新文本。</p>}
    {ended && <p className="notice" role="status">{invalidTest[test.state as keyof typeof invalidTest]}</p>}
    {candidate && <div className="attention-box" role="status">
      <p><strong>{test?.state === 'sent' ? '私聊收发通过'
        : test?.state === 'send-failed' ? '已收到私聊，回发未确认' : '已收到私聊，正在回发'}</strong></p>
      <p className="wrap">收到的内容 · {candidate.preview}</p>
      <details><summary>测试详情</summary>
        <p className="wrap">发件人 Open ID · <code>{candidate.openId}</code></p>
        <p>收到时间 · {new Date(candidate.receivedAt).toLocaleTimeString('zh-CN')}</p>
      </details>
    </div>}
    <div className="actions">
      {test?.state === 'waiting' && <a target="_blank" rel="noopener noreferrer"
        href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(view.appId)}`}>在飞书打开机器人</a>}
      {(!test || ended) && <button type="button" className="primary"
        disabled={disabled || editing || !ready || !(view.testStartToken || retryStart)}
        onClick={() => perform('test.start')}>{ended ? '重新开始测试' : '测试并绑定'}</button>}
      {test?.state === 'send-failed' && <button type="button" disabled={disabled || editing || !ready}
        onClick={() => perform('test.retry')}>重试发送</button>}
      {test?.state === 'sent' && <button type="button" className="primary" disabled={disabled || editing || !ready}
        onClick={() => perform('test.confirm')}>确认这是本人</button>}
      {(view.selfBinding !== 'skipped' || (test && !ended)) && <button type="button" disabled={disabled || editing}
        onClick={() => perform('test.skip')}>跳过测试</button>}
      {test && !ended && <button type="button" disabled={disabled} onClick={() => perform('test.stop')}>停止测试</button>}
    </div>
    {!test && !view.testStartToken && !retryStart && <Hint>请在开启测试的设置页完成或停止当前测试。</Hint>}
  </Section>;
}

function GroupEntry({ bots, openGroup, createBot }: { bots?: Bot[]; openGroup: (botId: string) => void; createBot: () => void }) {
  const [choosing, setChoosing] = useState(false), [selection, setSelection] = useState('');
  const pickerId = useId();
  if (!bots) return null;
  if (bots.length === 0) return <div className="actions">
    <button type="button" onClick={createBot}>新建 Bot</button>
    <p className="muted">创建 Bot 后即可绑定飞书群。</p>
  </div>;
  if (!choosing) return <div className="actions"><button type="button" className="primary" onClick={() => {
    if (bots.length === 1) openGroup(bots[0]!.id);
    else setChoosing(true);
  }}>去验证群同步</button></div>;
  return <form className="form" onSubmit={event => {
    event.preventDefault();
    if (bots.some(bot => bot.id === selection)) openGroup(selection);
  }}>
    <label htmlFor={pickerId}>选择要验证的 Bot</label>
    <select id={pickerId} autoFocus required value={selection} onChange={event => setSelection(event.target.value)}>
      <option value="">请选择 Bot</option>
      {bots.map(bot => <option value={bot.id} key={bot.id}>
        {bot.name}{bots.some(other => other.id !== bot.id && other.name === bot.name) ? ` · ${bot.id.slice(0, 8)}` : ''}
      </option>)}
    </select>
    <div className="actions">
      <button className="primary" disabled={!selection}>打开飞书群设置</button>
      <button type="button" onClick={() => setChoosing(false)}>取消</button>
    </div>
  </form>;
}

function testSession({ configurationId, sessionId }: TestRequest) {
  return { configurationId, sessionId };
}

export function FeishuSettings({ api, close, bots, openGroup, createBot }: {
  api: WorkspaceApi; close: () => void; bots?: Bot[]; openGroup: (botId: string) => void; createBot: () => void;
}) {
  const [view, setView] = useState<FeishuSettingsView>();
  const [draft, setDraft] = useState<Draft>();
  const [editCredentials, setEditCredentials] = useState(false);
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
  const showCredentials = view && (!view.hasSecret || editCredentials);
  async function perform(action: Action) {
    const signal = lifetime.current;
    if (!signal || signal.aborted || busy.current || readError || !view || !draft) return;
    if (action === 'check' || action === 'save') {
      if (!canSubmit) return;
    } else if (action !== 'verify' && showCredentials && action !== 'test.stop') return;
    busy.current = true;
    revision.current++;
    if (action === 'check' || action === 'save') clearFeedback();
    else { setError(''); setSaved(false); }
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
          setEditCredentials(false);
        }
      } else if (action === 'verify') {
        const next = await api.call<FeishuSettingsView>('feishu.settings.verify', { configurationId: view.configurationId }, signal);
        if (!signal.aborted) setView(next);
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
  return <div className="sb"><style>{styles}</style><main className="sb-wrap" style={{ maxWidth: 820 }}>
    <header className="sb-header">
      <h1>设置</h1>
      <button type="button" autoFocus disabled={!!pending} onClick={closeSettings}>← 我的 Bot</button>
    </header>
    <DeveloperSettings api={api}/>
    <h2>飞书</h2>
    {readError ? <p className="notice error" role="alert">暂时无法读取当前 DSH profile 的设置，稍后会自动重试。</p>
      : !view && <p role="status" className="muted">正在读取飞书设置…</p>}
    {view?.hasSecret &&
      <Section title="飞书连接" aside={!showCredentials && <button type="button" className="small" disabled={disabled}
        onClick={() => { clearFeedback(); fillFrom(view); setEditCredentials(true); }}>编辑凭证</button>}>
        <p role="status"><strong>{credentialLabel[view.credentials]} · {ownerLabel[view.selfBinding]}</strong></p>
        {view.selfBinding !== 'bound' && view.connection === 'ready' && <p className="muted">长连接 · <strong>连接就绪</strong></p>}
        {!test && view.selfBinding !== 'bound' && <p className="muted">私聊收发未测试</p>}
        {view.selfBinding === 'bound' && <p>此连接下的 Bot 共用本人身份</p>}
        <details><summary>连接详情</summary>
          <p className="wrap">App ID · <code>{view.appId}</code></p>
          {view.ownerOpenId && <p className="wrap">本人 Open ID · <code>{view.ownerOpenId}</code></p>}
          {view.selfBinding === 'bound' && <p>长连接 · <strong>{feishuConnectionLabel[view.connection]}</strong></p>}
          {view.selfBinding === 'bound' && <p>{view.privateTest === 'passed' ? '私聊收发通过' : '私聊收发未测试'}</p>}
          {view.privateTestAt != null && <p>私聊确认时间 · {new Date(view.privateTestAt).toLocaleString('zh-CN')}</p>}
        </details>
        {!showCredentials && view.credentials !== 'passed' && <div className="actions">
          <button type="button" disabled={disabled} onClick={() => void perform('verify')}>重新检测凭证</button>
        </div>}
        {!showCredentials && view.enabled && view.selfBinding === 'bound' &&
          <GroupEntry bots={bots} openGroup={openGroup} createBot={createBot}/>}
      </Section>}
    {view && (view.error || (view.hasSecret && view.connection !== 'ready')) && <div className="notice slim" role="status">
      <div><strong>长连接 · {feishuConnectionLabel[view.connection]}</strong>{view.error && <p>{view.error}</p>}</div>
    </div>}
    {draft && showCredentials && <Section title="应用凭证">
      <form className="form" onSubmit={event => { event.preventDefault(); void perform('check'); }}>
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
          {editCredentials && <button type="button" disabled={disabled} onClick={() => {
            fillFrom(view); clearFeedback(); setEditCredentials(false);
          }}>取消编辑</button>}
        </div>
        {result && <p role="status">{credentialLabel[result.credentials]}</p>}
      </form>
    </Section>}
    <div role="status">{saved && <p>设置已保存。</p>}</div>
    {error && <p role="alert" className="notice error">{error}</p>}
    {view?.enabled && view.selfBinding !== 'bound' && <TestControls view={view} test={test} editing={!!showCredentials}
      retryStart={!test && !!testRequest.current}
      disabled={disabled || testReadError} perform={action => void perform(action)}/>}
    {testReadError && <p role="alert" className="notice error">暂时无法读取私聊测试状态，稍后会自动重试。</p>}
  </main></div>;
}
