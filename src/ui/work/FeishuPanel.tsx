import { useEffect, useId, useRef, useState } from 'react';
import type { FeishuStatus } from '../../feishu-host.ts';
import type { FeishuGroupDiagnosis } from '../../feishu-types.ts';
import { feishuConnectionLabel } from '../feishu-format.ts';
import { ConfirmAction, Hint, Section } from '../kit.tsx';
import type { WorkspaceApi } from './api.ts';

type Preview = { chatId: string; name: string; confirmationToken: string };
type Form = 'create' | 'bind' | null;
const PLAIN_TEXT_WAIT_MS = 45_000;

function GroupVerification({
  binding,
  evidence,
  ready,
  disabled,
  diagnose,
}: {
  binding: NonNullable<FeishuStatus['binding']>;
  evidence: FeishuStatus['evidence'];
  ready: boolean;
  disabled: boolean;
  diagnose: (record: (result: FeishuGroupDiagnosis) => void) => void;
}) {
  const deadline = binding.boundAt + PLAIN_TEXT_WAIT_MS;
  const [timedOut, setTimedOut] = useState(() => Date.now() >= deadline);
  const [showMention, setShowMention] = useState(false);
  const [diagnosis, setDiagnosis] = useState<FeishuGroupDiagnosis>();
  const receivedPlain = evidence?.plainTextAt != null;
  const receivedMention = evidence?.botMentionAt != null;
  const missingGrant = diagnosis?.ordinaryTextGrant === 'missing';
  const missingEvent = !receivedMention && diagnosis?.receiveSubscription === 'missing';
  useEffect(() => {
    if (timedOut || receivedPlain) return;
    const timer = setTimeout(() => setTimedOut(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, timedOut, receivedPlain]);
  return (
    <div className={`attention-box${receivedPlain || receivedMention ? ' result' : ''}`}>
      <strong>验证群同步</strong>
      {receivedPlain ? (
        <p role="status">群消息接收通过（无需 @）</p>
      ) : (
        <>
          {ready && !receivedMention && <p>请用本人账号在群里发送一条新文本，无需 @ 机器人。</p>}
          {!receivedMention && (
            <p role="status">{timedOut ? '尚未收到普通消息' : '等待普通消息…'}</p>
          )}
          {ready && (timedOut || receivedMention) && (
            <div className="actions">
              {!showMention && !receivedMention && (
                <button type="button" disabled={disabled} onClick={() => setShowMention(true)}>
                  改用 @ 机器人测试
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setDiagnosis(undefined);
                  diagnose(setDiagnosis);
                }}
              >
                排查普通消息
              </button>
            </div>
          )}
          {diagnosis && (
            <div role="status">
              {missingGrant && (
                <p>
                  应用缺少「接收群聊中所有消息」权限 · <code>im:message.group_msg</code>
                </p>
              )}
              {missingEvent && (
                <p>
                  应用缺少「接收消息」事件订阅 · <code>im.message.receive_v1</code>
                </p>
              )}
              {!missingGrant && !missingEvent && (
                <p>暂时无法确认原因。请核对长连接、事件订阅和已发布的应用版本。</p>
              )}
            </div>
          )}
        </>
      )}
      {ready && showMention && !receivedMention && (
        <p>请在群里 @ 这个应用的机器人，再附上一句新文本。</p>
      )}
      {receivedMention && (
        <p role="status">
          {receivedPlain ? '已收到 @ 机器人的消息' : '@ 消息可用，普通消息仍未验证'}
        </p>
      )}
    </div>
  );
}

export function FeishuPanel({
  api,
  botId,
  botName,
  locked,
  focus,
}: {
  api: WorkspaceApi;
  botId: string;
  botName: string;
  locked: boolean;
  focus?: boolean;
}) {
  const [status, setStatus] = useState<FeishuStatus>();
  const [readError, setReadError] = useState(false),
    [error, setError] = useState('');
  const [form, setForm] = useState<Form>(null),
    [preview, setPreview] = useState<Preview>();
  const [name, setName] = useState(botName.slice(0, 60).replace(/[\uD800-\uDBFF]$/u, ''));
  const [chatId, setChatId] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0),
    busy = useRef(false),
    requestId = useRef('');
  const lifetime = useRef<AbortSignal>(),
    fieldId = useId();
  const title = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!focus) return;
    title.current?.focus({ preventScroll: true });
    title.current?.scrollIntoView({ block: 'start' });
  }, [focus]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    lifetime.current = signal;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!busy.current && document.visibilityState !== 'hidden') {
        const revision = generation.current;
        const current = () => !signal.aborted && revision === generation.current;
        try {
          const value = await api.call<FeishuStatus>('feishu.status', { botId }, signal);
          if (current()) {
            setStatus(value);
            setReadError(false);
          }
        } catch {
          if (current()) setReadError(true);
        }
      }
      if (!signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, botId]);

  async function perform<T>(
    action: string,
    payload: Record<string, unknown>,
    apply: (value: T) => void,
  ) {
    const signal = lifetime.current;
    if (!signal || signal.aborted || busy.current || locked) return false;
    busy.current = true;
    generation.current++;
    setPending(true);
    setError('');
    try {
      const value = await api.call<T>(action, { botId, ...payload }, signal);
      if (signal.aborted) return false;
      apply(value);
      return true;
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : '飞书群设置操作失败，请重试。');
      return false;
    } finally {
      busy.current = false;
      if (!signal.aborted) setPending(false);
    }
  }

  function changeForm(value: Form) {
    setForm(value);
    setPreview(undefined);
    setError('');
  }
  function record(value: FeishuStatus) {
    setStatus(value);
    setReadError(false);
    changeForm(null);
    requestId.current = '';
  }

  const disabled = locked || pending || readError;
  const canConnect = !disabled && status?.connection === 'ready' && status.selfBinding === 'bound';
  const binding = status?.binding;
  return (
    <Section
      title={
        <span ref={title} tabIndex={-1}>
          飞书群
        </span>
      }
    >
      <p className="muted" role="status">
        {readError
          ? '暂时无法读取飞书群状态'
          : status
            ? feishuConnectionLabel[status.connection]
            : '正在读取连接状态…'}
      </p>
      {status?.connection === 'disabled' && (
        <Hint>请从 Super Bot 首页的「设置 → 飞书」启用飞书连接。</Hint>
      )}
      {status && status.connection !== 'disabled' && status.selfBinding !== 'bound' && (
        <Hint>请先在 Super Bot 首页的「设置 → 飞书」绑定本人身份，再设置群同步。</Hint>
      )}
      {status?.error && (
        <p className="notice slim" role="status">
          {status.error}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {binding ? (
        <>
          <p className="wrap">
            <strong>{binding.name}</strong>
            <br />
            <span className="muted">{binding.chatId}</span>
          </p>
          <div className="actions">
            <a href={binding.url} target="_blank" rel="noopener noreferrer">
              在飞书打开群
            </a>
          </div>
          <GroupVerification
            key={binding.id}
            binding={binding}
            evidence={status?.evidence ?? null}
            ready={status?.connection === 'ready' && !readError}
            disabled={disabled}
            diagnose={(apply) =>
              void perform<FeishuGroupDiagnosis>(
                'feishu.diagnose',
                { bindingId: binding.id },
                apply,
              )
            }
          />
          <ConfirmAction
            label="解绑"
            explanation="解绑后会立即停止同步。群和已经发出的消息仍保留在飞书中。"
            disabled={disabled}
            submit={() => perform<FeishuStatus>('feishu.unbind', { bindingId: binding.id }, record)}
          />
        </>
      ) : (
        status?.connection === 'ready' &&
        status.selfBinding === 'bound' &&
        !form && (
          <div className="actions">
            <button disabled={!canConnect} onClick={() => changeForm('create')}>
              新建私有群
            </button>
            <button disabled={!canConnect} onClick={() => changeForm('bind')}>
              绑定已有群
            </button>
          </div>
        )
      )}
      {!binding && form === 'create' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            requestId.current ||= crypto.randomUUID();
            void perform<FeishuStatus>(
              'feishu.create',
              { name: name.trim(), requestId: requestId.current },
              record,
            );
          }}
        >
          <label htmlFor={fieldId}>私有群名称</label>
          <input
            id={fieldId}
            value={name}
            maxLength={60}
            required
            disabled={pending}
            onChange={(e) => {
              setName(e.target.value);
              requestId.current = '';
            }}
          />
          <div className="actions">
            <button className="primary" disabled={!canConnect || !name.trim()}>
              创建并绑定
            </button>
            <button type="button" disabled={pending} onClick={() => changeForm(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {!binding && form === 'bind' && (
        <>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setPreview(undefined);
              void perform<Preview>('feishu.preview', { chatId: chatId.trim() }, setPreview);
            }}
          >
            <label htmlFor={fieldId}>已有群的群 ID</label>
            <input
              id={fieldId}
              value={chatId}
              placeholder="oc_…"
              maxLength={200}
              required
              disabled={pending}
              onChange={(e) => {
                setChatId(e.target.value);
                setPreview(undefined);
              }}
            />
            <div className="actions">
              <button disabled={!canConnect || !chatId.trim()}>预览群名称</button>
              <button type="button" disabled={pending} onClick={() => changeForm(null)}>
                取消
              </button>
            </div>
          </form>
          {preview && (
            <div className="attention-box">
              <p className="wrap">
                <strong>{preview.name}</strong>
                <br />
                <span className="muted">{preview.chatId}</span>
              </p>
              <p>该群的所有成员都能查看同步到群里的 Bot 对话。请核对群名和群 ID 后再绑定。</p>
              <button
                className="primary"
                disabled={!canConnect}
                onClick={() =>
                  void perform<FeishuStatus>(
                    'feishu.bind',
                    { confirmationToken: preview.confirmationToken },
                    record,
                  )
                }
              >
                确认绑定
              </button>
            </div>
          )}
        </>
      )}
      {status?.selfBinding === 'bound' && status.connection !== 'disabled' && !form && (
        <Hint>绑定后同步新文本。只有授权账号能从群内向 Bot 发送消息。</Hint>
      )}
    </Section>
  );
}
