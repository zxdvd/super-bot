/** Persistent manager sessions use the same ledger commands as the dashboard. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionStore } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AppError,
  requiredText,
  optionalText,
  type Binding,
  type ChatSource,
  type ManagerBinding,
  type ManagerEvent,
  type NewBot,
  type Bot,
  type Task,
  type Run,
  type Result,
  type RecoveryDirection,
  type RecoveryDirectionChange,
  type RecoveryInstruction,
  botDraft,
} from './model.ts';
import type { BotDeletionReceipt, Store } from './store.ts';
import {
  gitLabObservationOrigin,
  stageFollowUpForDirection,
  stageReadyKey,
  STAGE_GUIDANCE,
  type WorkStage,
} from './work-stage.ts';
import {
  GITLAB_RELEASE_GUIDANCE,
  exactJobStatus,
  releaseJobName,
  releaseJobPath,
  type ReleaseAuthorization,
  type ReleaseTarget,
} from './gitlab-release.ts';
import { gitLabReader } from './gitlab-client.ts';
import { selectedModel, modelFailureNote, type DshExecution } from './dsh.ts';
import { previewEvidence, verifyEvidence } from './evidence.ts';
import {
  configureRole,
  fullAccessEnabled,
  runtimeLimits,
  WORKER_SESSION_RETRY_MS,
  type RuntimeOptions,
} from './runtime.ts';
import { readMaterials } from './materials.ts';
import { CONVENTION_FILE, CONVENTION_LIMIT } from './bot-memory.ts';
import { nameAutomaticSession } from './sidebar.ts';
import { MANAGER_NATIVE_TOOLS, managerNoWait } from './manager-tools.ts';
import { ManagerNativeTurn } from './manager-native-turn.ts';
import {
  parseWorkdirRequest,
  workdirPolicy,
  workdirSummary,
  type WorkdirPolicy,
} from './workdir.ts';
import { parseWorkLink, resultFileUrl, workUrl } from './work-links.ts';
import { hasDeliveryLink } from './chat-delivery-links.ts';
import type { Attention } from './model.ts';
import { ReloadAdmission } from './reload-admission.ts';
import {
  finalAssistantText,
  isFeishuSource,
  isHostContext,
  isNativeOwner,
  messageText,
} from './dsh-chat-events.ts';
import { FeishuInputs, untilFeishuAbort, type FeishuInput } from './feishu-inputs.ts';
import {
  isOwnerWorkAction,
  type ClarificationAction,
  type OwnerWorkAction,
} from './chat-work-actions.ts';
import { clarificationOptions } from './manager/clarification.ts';
import { managerPrompt } from './manager/guidance.ts';
import { MANAGER_TOOL } from './manager/tool-definition.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'super-bot-manager': {
      kind: 'super-bot-manager';
      botId: string;
      managerId: string;
      eventId: string;
    };
  }
}

function chatUrls(text: string): URL[] {
  const links =
    text
      .replaceAll('&amp;', '&')
      .match(/(?:https?:\/\/|\/api\/super-bot-file\?|\/\?|\/?#)[^\s<>()\[\]"']+/gi) ?? [];
  return links.flatMap((link) => {
    try {
      return [new URL(link.replace(/[.,;。；，]+$/u, ''), 'http://super-bot.invalid')];
    } catch {
      return [];
    }
  });
}

export function deliveryLinks(taskId: string, resultId: string, paths: string[]) {
  return {
    files: paths.map((path, index) => ({
      name: path.split('/').at(-1) ?? `file-${index + 1}`,
      url: resultFileUrl(resultId, index),
    })),
    workUrl: workUrl({ kind: 'result', taskId, resultId }),
  };
}

/** The native Markdown renderer treats root-relative destinations as local file paths. */
function chatHref(path: string, origin: string): string {
  try {
    const url = new URL(path, origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* Headless adapters can omit a Web origin. */
  }
  return path;
}

function deliveryResultLink(path: string, origin: string): string {
  return `[查看完整交付](${chatHref(path, origin)})`;
}

const QUESTION_REPLY =
  '在给用户的可见回复中用任务名称提出这个具体问题，请用户直接在本对话回答。若附上可选的详情入口，原样引用下面的 Markdown 链接。';
function questionLink(question: Attention, origin: string) {
  const url = workUrl({ kind: 'question', taskId: question.taskId, attentionId: question.id });
  return { ...question, workUrl: url, markdown: `[回答](${chatHref(url, origin)})` };
}

const DEFAULT_SCOPE =
  '按用户请求完成目标所需的最小改动，只在任务工作目录内进行；不访问无关账号或数据。';
const DEFAULT_ACCEPTANCE =
  'Worker 报告完成内容、实际执行的检查及未验证项，并提交可回读的成果文件；用户最终确认。';

type OwnerSource = ChatSource & { feishu?: FeishuInput };
type DisplayedQuestion = {
  turn: number;
  source: ChatSource;
  question?: string;
  finalSeq?: number;
  shown?: true;
  selectionTurn?: number;
  noticeMessageId?: string;
};
type Clarification = DisplayedQuestion & {
  action: ClarificationAction;
  options: ReturnType<typeof clarificationOptions>;
};

type SessionChoice = { sessionId: string; title: string; cwd: string; updatedAt: number };
type SessionConversation = DisplayedQuestion & {
  taskId: string;
  rowVersion: number;
  choices: SessionChoice[];
  preview?: { title: string; sessionId: string; cwd: string; shown?: true };
};
type WorkConfirmation = DisplayedQuestion & {
  action: 'accept' | 'recover-and-continue';
  taskId: string;
  rowVersion: number;
  targetId: string;
  attentionId?: string;
  ownerFact?: string;
};
type GitLabQuestion = DisplayedQuestion & {
  taskId: string;
  rowVersion: number;
  stageRunId: string;
  observedAt: number;
  choices: ReleaseTarget[];
};

function chatSource({ sessionId, messageId, seq, text }: OwnerSource): ChatSource {
  return { sessionId, messageId, seq, text };
}

function combineChatSources(previous: ChatSource, current: ChatSource): ChatSource {
  return {
    ...current,
    text: `${previous.text}\n\n${current.text}`,
    messages: [
      ...(previous.messages ?? [previous]).map(({ messageId, seq, text }) => ({
        messageId,
        seq,
        text,
      })),
      { messageId: current.messageId, seq: current.seq, text: current.text },
    ],
  };
}

function selectedOption<T>(options: readonly T[], choice: unknown): T | undefined {
  return typeof choice === 'number' && Number.isSafeInteger(choice) && choice >= 1
    ? options[choice - 1]
    : undefined;
}

function conventionExcerpt(value: unknown, source: Pick<ChatSource, 'text'>): string {
  const text = requiredText(value, '工作约定', CONVENTION_LIMIT);
  if (
    !source.text.includes(text) ||
    text.includes('\0') ||
    Buffer.from(text).toString('utf8') !== text
  ) {
    throw new AppError('memory-human-text', '请只复制当前用户消息中明确指定的工作约定原文。');
  }
  return text;
}

export class Managers {
  private userMessages = new Map<string, ChatSource[]>();
  private ownerSources = new Map<string, OwnerSource>();
  private mixedOwnerTurns = new Set<string>();
  private turnStartSeqs = new Map<string, number>();
  private retainedOwnerInputs = new Map<string, Set<string>>();
  private scopes = new Map<
    string,
    { agent: Agent; nativeTurn?: ManagerNativeTurn; retire: () => void; release: () => void }
  >();
  private creating = new Map<string, Promise<ManagerBinding>>();
  private botWrites = new Map<string, { payload: string; promise: Promise<Bot> }>();
  private waking = new Map<string, Promise<void>>();
  private finishing = new Map<string, Promise<void>>();
  private recoveryScopes = new Map<string, { taskId: string; messageId: string }>();
  private deliveryScopes = new Map<string, { taskId: string; resultId: string }>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private policy: WorkdirPolicy;
  private feishuInputs: FeishuInputs;
  constructor(
    private ctx: Context,
    private store: Store,
    private execution: DshExecution,
    private dataDir: string,
    private webOrigin: () => string = () => '',
    private options: RuntimeOptions = {},
    private reloadAdmission = new ReloadAdmission(),
  ) {
    this.policy = workdirPolicy(options, dataDir);
    this.feishuInputs = new FeishuInputs(store);
  }

  reloadBlockers(): string[] {
    const blockers = [...this.waking.keys()].map(
      (id) => `Manager Bot ${id} (automatic turn settling)`,
    );
    for (const id of this.creating.keys())
      blockers.push(`Manager binding ${id} (session preparation)`);
    for (const id of this.botWrites.keys())
      blockers.push(`Manager request ${id} (Bot configuration write)`);
    for (const id of this.finishing.keys())
      blockers.push(`Manager session ${id} (delivery settlement)`);
    for (const { agent } of this.scopes.values()) {
      const label = `Manager session ${agent.id}`;
      if (agent.status !== 'idle') blockers.push(`${label} (${agent.status})`);
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
        blockers.push(`${label} (queued native input)`);
      for (const job of this.ctx.jobs.list(agent.id)) {
        if (job.owner === agent.id && ['running', 'stopping'].includes(job.status))
          blockers.push(`${label}, job ${job.id} (${job.status})`);
      }
    }
    return blockers;
  }

  async waitForChatDelivery(sessionId: string): Promise<void> {
    // Listeners on the same native turn/end may run in either order.
    await Promise.resolve();
    await this.finishing.get(sessionId);
  }

  private authority(sessionId: string, id?: string): ManagerBinding {
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const manager = this.store.managerForSession(sessionId);
    if (
      !manager ||
      manager.state !== 'ready' ||
      (id && manager.id !== id) ||
      this.store.getBot(manager.botId).configRevision !== manager.configRevision
    )
      throw new AppError('manager-scope', '管理会话或配置已失效。');
    return manager;
  }
  registerFeishuBindingCheck(check: (botId: string, bindingId: string) => boolean): () => void {
    const dispose = this.feishuInputs.registerBindingCheck(check);
    this.execution.resumeUnsentDispatches?.();
    return dispose;
  }
  checkStageSources(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (task.stageState !== 'ready') return;
    const stage = this.store.taskStage(task);
    if (stage?.state !== 'ready') return;
    const active = (source: ChatSource) =>
      this.store.botForSession(source.sessionId)?.id === task.botId &&
      this.feishuInputs.hasCurrentSource(source, task.botId);
    const supplement = this.store.stageSupplement(taskId, stage.runId);
    if (
      (stage.planSource && !active(stage.planSource)) ||
      (supplement &&
        (!active(supplement.source) || !this.currentInstructionSources(supplement, task.botId)))
    ) {
      throw new AppError(
        'stage-source',
        '阶段指示的原对话或飞书本人绑定已改变。请在当前对话核对该具体指示。',
      );
    }
  }
  async submitFeishu(input: FeishuInput, message: UserMessage): Promise<boolean> {
    if (this.closed || input.signal.aborted || !input.isCurrent()) return false;
    return this.reloadAdmission.run('Feishu Manager input', async () => {
      const manager = this.authority(input.sessionId);
      if (manager.botId !== input.botId) return false;
      const resolved = await untilFeishuAbort(
        this.ctx.sessionController.resolveAgent(SessionId(input.sessionId)),
        input.signal,
      );
      if ('error' in resolved || resolved.agent.id !== input.sessionId)
        throw new AppError('feishu-manager-unavailable', '管理会话暂不可用，请打开 Bot 对话核对。');
      const agent = resolved.agent;
      await untilFeishuAbort(agent.whenIdle(), input.signal);
      await untilFeishuAbort(this.finishing.get(agent.id) ?? Promise.resolve(), input.signal);
      if (this.closed || input.signal.aborted || !input.isCurrent()) return false;
      this.authority(agent.id, manager.id);
      if (!(selectedModel(this.ctx, agent) ?? agent.model?.current?.()))
        throw new AppError('feishu-model-required', '请先在 Bot 管理对话中选择并配置模型。');
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
        throw new AppError('feishu-manager-busy', '管理会话仍有排队输入，请在原生对话中核对。');
      }
      this.attachScope(agent);
      return this.feishuInputs.submit(agent, input, message);
    });
  }
  private recordHuman(source: ChatSource): boolean {
    const sources = this.userMessages.get(source.sessionId) ?? [];
    if (sources.some((item) => item.messageId === source.messageId || item.seq === source.seq))
      return false;
    sources.push(source);
    this.userMessages.set(source.sessionId, sources);
    return true;
  }
  private currentOwner(sessionId: string): OwnerSource | undefined {
    const source = this.ownerSources.get(sessionId);
    if (
      this.nativeTurns.has(sessionId) &&
      !this.mixedOwnerTurns.has(sessionId) &&
      source &&
      (!source.feishu || (!source.feishu.signal.aborted && source.feishu.isCurrent()))
    ) {
      return source;
    }
  }
  private humanTurnSource(sessionId: string): ChatSource {
    const sources = this.userMessages.get(sessionId);
    if (!sources?.length)
      throw new AppError(
        'human-message-required',
        '需要当前对话中的真实用户消息；自动通知不能代替用户提出新工作、回答或返工。',
      );
    const ordered = [...sources].sort((a, b) => a.seq - b.seq),
      latest = ordered.at(-1)!;
    return ordered.length === 1
      ? latest
      : {
          ...latest,
          text: ordered.map((source) => source.text).join('\n\n'),
          messages: ordered.map(({ messageId, seq, text }) => ({ messageId, seq, text })),
        };
  }
  private ownerTurn(
    agent: Agent,
    authorize: () => void,
  ): { owner: OwnerSource; check: () => void } {
    const initial = this.currentOwner(agent.id);
    const check = () => {
      authorize();
      const owner = this.currentOwner(agent.id);
      if (
        !owner ||
        owner !== initial ||
        this.notificationTurns.has(agent.id) ||
        agent.inbox?.nextTurn.length ||
        agent.inbox?.nextStep.length
      ) {
        throw new AppError('human-message-required', '需要当前 Bot 对话中真实且明确的用户指令。');
      }
      return owner;
    };
    return { owner: check(), check };
  }
  private clarificationKey(manager: ManagerBinding): string {
    return `manager-clarification:${manager.id}`;
  }
  private getClarification(manager: ManagerBinding): Clarification | undefined {
    const saved = this.store.get(this.clarificationKey(manager));
    if (saved) return JSON.parse(saved) as Clarification;
  }
  private sessionConversationKey(manager: ManagerBinding): string {
    return `manager-session-choice:${manager.id}`;
  }
  private getSessionConversation(manager: ManagerBinding): SessionConversation | undefined {
    const saved = this.store.get(this.sessionConversationKey(manager));
    if (saved) return JSON.parse(saved) as SessionConversation;
  }
  private workConfirmationKey(manager: ManagerBinding): string {
    return `manager-work-confirmation:${manager.id}`;
  }
  private getWorkConfirmation(manager: ManagerBinding): WorkConfirmation | undefined {
    const saved = this.store.get(this.workConfirmationKey(manager));
    if (saved) return JSON.parse(saved) as WorkConfirmation;
  }
  private gitLabQuestionKey(manager: ManagerBinding): string {
    return `manager-gitlab-choice:${manager.id}`;
  }
  private getGitLabQuestion(manager: ManagerBinding): GitLabQuestion | undefined {
    const saved = this.store.get(this.gitLabQuestionKey(manager));
    if (saved) return JSON.parse(saved) as GitLabQuestion;
  }
  private offerGitLabChoices(manager: ManagerBinding, task: Task, stage: WorkStage | null) {
    const observation = stage?.state === 'blocked' ? stage.observation : undefined;
    const choices = observation?.releaseChoices?.filter(
      (choice): choice is ReleaseTarget => typeof choice !== 'string' && !!choice.jobId,
    );
    if (!stage || !observation || !choices?.length || !manager.sessionId) return;
    const sessionId = manager.sessionId,
      question = observation.detail;
    const offered = {
      gitLabReleaseQuestion: question,
      gitLabReleaseChoices: choices.map((choice) => choice.name),
    };
    const previous = this.getGitLabQuestion(manager);
    const same =
      previous?.taskId === task.id &&
      previous.rowVersion === task.rowVersion &&
      previous.stageRunId === stage.runId &&
      previous.observedAt === observation.at;
    if (same && previous.shown) return offered;
    const turn = this.nativeTurns.get(sessionId);
    const notice = this.notificationTurns.get(sessionId),
      owner = this.currentOwner(sessionId);
    const exactNotice =
      notice &&
      notice.turn === turn &&
      notice.eventId.startsWith(`manager-event:stage-blocked:${stage.runId}:`) &&
      this.store.managerEventTargets(notice.eventId, notice.messageId, manager.botId, task.id)
        ? notice
        : undefined;
    const source = owner
      ? chatSource(owner)
      : exactNotice
        ? this.store.gitLabReleaseForStage(stage.runId)?.source
        : undefined;
    if (
      turn === undefined ||
      !source ||
      source.sessionId !== sessionId ||
      (!owner && previous?.shown && previous.taskId !== task.id)
    )
      return;
    this.store.set(
      this.gitLabQuestionKey(manager),
      JSON.stringify({
        turn,
        source,
        question,
        taskId: task.id,
        rowVersion: task.rowVersion,
        stageRunId: stage.runId,
        observedAt: observation.at,
        choices,
        ...(exactNotice ? { noticeMessageId: exactNotice.messageId } : {}),
      } satisfies GitLabQuestion),
    );
    return offered;
  }
  private shownGitLabChoice(
    manager: ManagerBinding,
    task: Task,
    stage: WorkStage,
    jobName: string | undefined,
    owner: OwnerSource,
  ) {
    const shown = this.getGitLabQuestion(manager),
      target = shown?.choices.find((choice) => choice.name === jobName);
    if (
      !shown?.shown ||
      !target ||
      shown.taskId !== task.id ||
      shown.rowVersion !== task.rowVersion ||
      shown.stageRunId !== stage.runId ||
      shown.selectionTurn !== this.nativeTurns.get(owner.sessionId) ||
      shown.source.sessionId !== owner.sessionId ||
      shown.source.seq >= owner.seq ||
      !this.feishuInputs.hasCurrentSource(shown.source, task.botId)
    ) {
      throw new AppError('gitlab-choice-stale', '请在原聊天展示当前作业选项，再按用户的回答选择。');
    }
    return { observedAt: shown.observedAt, target };
  }
  private ownerQuestions(manager: ManagerBinding): [string, DisplayedQuestion | undefined][] {
    return [
      [this.clarificationKey(manager), this.getClarification(manager)],
      [this.sessionConversationKey(manager), this.getSessionConversation(manager)],
      [this.workConfirmationKey(manager), this.getWorkConfirmation(manager)],
      [this.gitLabQuestionKey(manager), this.getGitLabQuestion(manager)],
    ];
  }
  private recordOwner(manager: ManagerBinding, turn: number, source: OwnerSource): void {
    if (
      source.seq <= (this.turnStartSeqs.get(source.sessionId) ?? -1) ||
      this.retainedOwnerInputs.get(source.sessionId)?.has(source.messageId)
    )
      return;
    if (!this.recordHuman(chatSource(source))) return;
    const previous = this.ownerSources.get(source.sessionId);
    if (previous && !!previous.feishu !== !!source.feishu)
      this.mixedOwnerTurns.add(source.sessionId);
    if (!previous || source.seq > previous.seq) this.ownerSources.set(source.sessionId, source);
    for (const [key, saved] of this.ownerQuestions(manager)) {
      if (!saved) continue;
      if (turn === saved.turn && source.seq > saved.source.seq) this.store.set(key, '');
      else if (turn > saved.turn && saved.selectionTurn !== turn) {
        this.store.set(
          key,
          saved.selectionTurn === undefined
            ? JSON.stringify({ ...saved, selectionTurn: turn })
            : '',
        );
      }
    }
  }
  private retainOwnerInputs(agent: Agent): void {
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(isNativeOwner);
    if (!pending.length) return;
    const retained = this.retainedOwnerInputs.get(agent.id) ?? new Set<string>();
    for (const message of pending) retained.add(message.id);
    this.retainedOwnerInputs.set(agent.id, retained);
  }
  private clarifiedSource(
    manager: ManagerBinding,
    task: Task,
    data: Record<string, unknown>,
    owner: OwnerSource,
  ): ChatSource {
    const receipt = this.getClarification(manager),
      source = chatSource(owner);
    if (
      !receipt?.shown ||
      receipt.action !== data.action ||
      receipt.selectionTurn !== this.nativeTurns.get(owner.sessionId) ||
      receipt.source.sessionId !== source.sessionId ||
      receipt.source.seq >= source.seq ||
      !this.feishuInputs.hasCurrentSource(receipt.source, manager.botId)
    ) {
      throw new AppError(
        'clarification-stale',
        '先前的聊天问题或候选任务已改变，请核对当前任务后再向用户提问。',
      );
    }
    const option = selectedOption(receipt.options, data.choice);
    if (
      !option ||
      option.taskId !== task.id ||
      (data.action === 'respond' && option.attentionId !== data.attentionId) ||
      ((data.action === 'accept' || data.action === 'rework') && option.resultId !== data.resultId)
    ) {
      throw new AppError('clarification-selection', '所选项目与已展示的候选不一致。');
    }
    if (option.rowVersion !== data.expectedRowVersion)
      throw new AppError('clarification-stale', '所选任务版本已改变。');
    return combineChatSources(receipt.source, source);
  }
  private checkWorkLinks(
    text: string,
    taskId: string,
    attentionId?: string,
    resultId?: string,
  ): boolean {
    let exactResult = false;
    for (const url of chatUrls(text.replace(/[，。；、！？「」『』]/gu, ' '))) {
      if (url.pathname !== '/' || !new URLSearchParams(url.hash.slice(1)).has('super-bot-task'))
        continue;
      const linked = parseWorkLink(url.hash);
      if (
        attentionId &&
        (!linked ||
          linked.taskId !== taskId ||
          (linked.kind === 'question' && linked.attentionId !== attentionId))
      ) {
        throw new AppError('attention-scope', '请回答消息中明确引用的原问题。');
      }
      if (
        resultId &&
        (!linked ||
          linked.taskId !== taskId ||
          (linked.kind === 'result' && linked.resultId !== resultId))
      ) {
        throw new AppError('result-stale', '请核对用户消息中引用的任务与成果版本。');
      }
      if (!linked || linked.taskId !== taskId)
        throw new AppError('control-task-link', '请核对当前消息中引用的任务。');
      if (linked.kind === 'result' && linked.resultId === resultId) exactResult = true;
    }
    return exactResult;
  }
  private async inspectChatSession(
    manager: ManagerBinding,
    task: Task,
    source: ChatSource,
    data: Record<string, unknown>,
    turn: number,
    authorize: () => void,
    signal: AbortSignal,
  ) {
    const key = this.sessionConversationKey(manager);
    let selected: SessionChoice,
      requestSource = source;
    if (data.choice !== undefined && data.sessionQuery === undefined) {
      const prior = this.getSessionConversation(manager),
        option = prior && selectedOption(prior.choices, data.choice);
      if (
        !prior?.shown ||
        prior.preview ||
        prior.taskId !== task.id ||
        prior.rowVersion !== task.rowVersion ||
        prior.selectionTurn !== turn ||
        prior.source.sessionId !== source.sessionId ||
        prior.source.seq >= source.seq ||
        !this.feishuInputs.hasCurrentSource(prior.source, task.botId) ||
        !option
      ) {
        throw new AppError(
          'session-choice-stale',
          '先前列出的会话或任务版本已经改变，请核对新的会话选择。',
        );
      }
      selected = option;
      requestSource = combineChatSources(prior.source, source);
    } else {
      const query = requiredText(data.sessionQuery, '原生会话的标题或链接', 500);
      const url = chatUrls(query)[0];
      const explicitId =
        url &&
        url.pathname === '/' &&
        url.origin === this.webOrigin() &&
        (url.searchParams.get('sessionId') ?? url.searchParams.get('session'));
      if (explicitId && !source.text.includes(query))
        throw new AppError('session-query-source', '链接须来自当前用户消息。');
      const { items } = await this.ctx.sessionController.list({}, signal);
      authorize();
      const choices = items.flatMap((item) => {
        const title = item.projections?.values.title;
        if (
          typeof title !== 'string' ||
          !item.cwd ||
          item.origin === 'subagent' ||
          item.formatStatus === 'migration-required' ||
          (explicitId ? item.sessionId !== explicitId : title !== query)
        )
          return [];
        try {
          this.store.assertSessionAttachable(task.id, item.sessionId);
        } catch (error) {
          if (error instanceof AppError && error.code === 'session-owned') return [];
          throw error;
        }
        return [{ sessionId: item.sessionId, title, cwd: item.cwd, updatedAt: item.updatedAt }];
      });
      if (choices.length > 8)
        throw new AppError(
          'session-choice-ambiguous',
          '找到多于八个相同标题的会话。请用已有的原会话链接确定目标。',
        );
      if (!choices.length)
        throw new AppError(
          'session-unavailable',
          '找不到标题相符且可以关联的原生会话。请核对会话标题或已有链接。',
        );
      if (choices.length > 1) {
        if (this.store.getTask(task.id).rowVersion !== task.rowVersion)
          throw new AppError('version-conflict', '任务已经更新，请重新核对。');
        const question = `请选定要关联的会话。\n${choices.map(({ title, cwd, updatedAt }, i) => `${i + 1}. ${title} · ${cwd} · ${new Date(updatedAt).toISOString()}`).join('\n')}`;
        this.store.set(
          key,
          JSON.stringify({
            taskId: task.id,
            rowVersion: task.rowVersion,
            turn,
            source: requestSource,
            choices,
            question,
          } satisfies SessionConversation),
        );
        return {
          choices: choices.map(({ title, cwd, updatedAt }, index) => ({
            number: index + 1,
            title,
            cwd,
            updatedAt,
          })),
          confirmationText: question,
        };
      }
      selected = choices[0]!;
    }
    const preview = await this.execution.inspectExistingSession(task.id, selected.sessionId);
    authorize();
    if (this.store.getTask(task.id).rowVersion !== task.rowVersion)
      throw new AppError('version-conflict', '任务已经更新，请重新核对。');
    if (!preview.quiet)
      return { title: selected.title, cwd: preview.cwd, quiet: false, reason: preview.reason };
    const next = { title: selected.title, sessionId: preview.sessionId, cwd: preview.cwd };
    const question = `关联「${next.title}」后，本任务的模型可读取完整会话历史，并按任务范围在 ${next.cwd} 读取、写入和编辑文件。关联后保持暂停。你同意上述范围并关联吗？`;
    this.store.set(
      key,
      JSON.stringify({
        taskId: task.id,
        rowVersion: task.rowVersion,
        turn,
        source: requestSource,
        choices: [],
        preview: next,
        question,
      } satisfies SessionConversation),
    );
    return { title: next.title, cwd: next.cwd, quiet: true, confirmationText: question };
  }

  private async ownerWorkAction(
    action: OwnerWorkAction,
    manager: ManagerBinding,
    task: Task,
    source: ChatSource,
    data: Record<string, unknown>,
    authorize: () => void,
    signal: AbortSignal,
    verifiedChoice: boolean,
  ) {
    const version = data.expectedRowVersion as number;
    const turn = this.nativeTurns.get(source.sessionId)!;
    const decision = data.decision;
    if (
      decision !== undefined &&
      ((decision !== 'ask' && decision !== 'confirm') ||
        !(action === 'accept' || action === 'recover-and-continue') ||
        (decision === 'confirm' && data.choice !== undefined))
    ) {
      throw new AppError('invalid-input', '请选择适用于当前动作的确认方式。');
    }
    if (data.ownerFact !== undefined && action !== 'recover' && action !== 'recover-and-continue') {
      throw new AppError('invalid-input', '旧执行的事实只能用于恢复核对。');
    }
    const targetId = action === 'accept' ? data.resultId : data.runId;
    const attentionId = action === 'recover-and-continue' ? data.attentionId : undefined;
    const key = this.workConfirmationKey(manager);
    const confirmed = decision === 'confirm' ? this.getWorkConfirmation(manager) : undefined;
    if (
      decision === 'confirm' &&
      (!confirmed?.shown ||
        confirmed.selectionTurn !== turn ||
        confirmed.action !== action ||
        confirmed.taskId !== task.id ||
        confirmed.rowVersion !== version ||
        confirmed.targetId !== targetId ||
        confirmed.attentionId !== attentionId ||
        confirmed.source.sessionId !== source.sessionId ||
        confirmed.source.seq >= source.seq)
    ) {
      throw new AppError(
        'work-confirmation-stale',
        '刚才询问的操作、目标或版本已经改变。请核对原聊天。',
      );
    }
    const fullSource = confirmed ? combineChatSources(confirmed.source, source) : source;
    const check = () => {
      authorize();
      if (confirmed && !this.feishuInputs.hasCurrentSource(fullSource, task.botId)) {
        throw new AppError('work-confirmation-stale', '原确认问题或当前回答的本人来源已经改变。');
      }
    };
    const ask = (
      action: WorkConfirmation['action'],
      question: string,
      exactId: string,
      exactAttention?: string,
      ownerFact?: string,
    ) => {
      if (task.rowVersion !== version)
        throw new AppError('version-conflict', '任务或候选版本已经改变，请重新核对。');
      const pending = this.getWorkConfirmation(manager);
      if (
        pending?.turn === turn &&
        (pending.action !== action ||
          pending.taskId !== task.id ||
          pending.targetId !== exactId ||
          pending.attentionId !== exactAttention)
      ) {
        throw new AppError(
          'clarification-required',
          '本轮已有一个待确认目标，请在原聊天完成该项核对。',
        );
      }
      this.store.set(
        key,
        JSON.stringify({
          action,
          taskId: task.id,
          rowVersion: version,
          targetId: exactId,
          attentionId: exactAttention,
          turn,
          source,
          question,
          ownerFact,
        } satisfies WorkConfirmation),
      );
      return { status: 'confirmation-required', confirmationText: question };
    };
    const requestId = `chat-work:${createHash('sha256')
      .update(JSON.stringify([source.sessionId, source.messageId, action, task.id]))
      .digest('hex')}`;
    check();
    if (action === 'accept') {
      const resultId = requiredText(data.resultId, '成果标识', 200);
      const exactLink = this.checkWorkLinks(fullSource.text, task.id, undefined, resultId);
      const receipt = this.store.commandReceipt<Task>(requestId, 'result.accept', {
        taskId: task.id,
        expectedRowVersion: version,
        resultId,
        source: fullSource,
      });
      if (receipt) return { task: receipt, resultId };
      const detail = this.store.taskDetail(task.id);
      if (task.lifecycle !== 'review' || detail.result?.id !== resultId)
        throw new AppError('result-stale', '只能接受该任务当前待验收的成果。');
      const newerUndelivered = detail.deliveredResult && detail.deliveredResult.id !== resultId;
      if (decision === 'ask' || (newerUndelivered && !exactLink && !verifiedChoice && !confirmed)) {
        const versionNote = newerUndelivered ? '上次交付后已有新成果。' : '';
        return ask(
          action,
          `${versionNote}是否接受「${task.goal}」的这份成果？${deliveryResultLink(workUrl({ kind: 'result', taskId: task.id, resultId }), this.webOrigin())}`,
          resultId,
        );
      }
      return {
        task: await this.execution.accept(requestId, task.id, version, resultId, check, fullSource),
        resultId,
      };
    }
    if (task.rowVersion !== version)
      throw new AppError('version-conflict', '任务或候选版本已经改变，请重新核对。');
    this.checkWorkLinks(fullSource.text, task.id);
    if (action === 'revise')
      return {
        task: this.store.reviseTask(
          requestId,
          task.id,
          version,
          {
            goal: data.goal === undefined ? task.goal : requiredText(data.goal, '任务目标'),
            scope: data.scope === undefined ? task.scope : optionalText(data.scope, '范围'),
            acceptance:
              data.acceptance === undefined
                ? task.acceptance
                : optionalText(data.acceptance, '验收条件'),
          },
          source,
        ),
      };
    if (action === 'recover' || action === 'recover-and-continue') {
      const original = confirmed?.source ?? source;
      const claim = confirmed ? confirmed.ownerFact : data.ownerFact;
      if (
        typeof claim !== 'string' ||
        !claim.trim() ||
        claim.length > 32_000 ||
        !(original.messages ?? [original]).some((message) => message.text.includes(claim)) ||
        (confirmed && data.ownerFact !== undefined && data.ownerFact !== claim)
      ) {
        throw new AppError('recovery-fact', '请引用可归属到当前恢复事项的本人事实原文。');
      }
      const target = this.store.recoveryTarget(task.id, version);
      const runId = requiredText(data.runId, '当前待核对的执行标识', 200);
      if (target.run?.id !== runId)
        throw new AppError('recovery-stale', '原执行已经改变，请核对当前确切任务。');
      const continuation =
        action === 'recover-and-continue' && target.binding
          ? {
              attentionId: requiredText(data.attentionId, '恢复事项标识', 200),
              bindingId: target.binding.id,
              expectedBindingGeneration: target.binding.generation,
            }
          : undefined;
      if (action === 'recover-and-continue' && !continuation)
        throw new AppError('binding-stale', '当前会话关联不能续跑。');
      if (continuation) {
        this.store.recoveryTarget(task.id, version, continuation);
        if (decision === 'ask')
          return ask(
            'recover-and-continue',
            `你对「${task.goal}」上一轮的说明是「${claim}」。是否完成核对并立即派发下一轮？`,
            runId,
            continuation.attentionId,
            claim,
          );
      }
      const recovered = await this.execution.recover(
        requestId,
        task.id,
        version,
        true,
        continuation,
        check,
        fullSource,
        claim,
      );
      return {
        task: this.store.getTask(task.id),
        ...('inputId' in recovered ? { run: recovered } : {}),
      };
    }
    if (action === 'session-prepare')
      return {
        binding: await this.execution.prepareSession(
          requestId,
          task.id,
          version,
          undefined,
          authorize,
        ),
      };
    if (action === 'session-inspect')
      return this.inspectChatSession(manager, task, source, data, turn, authorize, signal);
    if (action === 'session-attach') {
      const conversation = this.getSessionConversation(manager),
        preview = conversation?.preview;
      if (
        !conversation ||
        !preview ||
        !(conversation.shown || preview.shown) ||
        conversation.selectionTurn !== turn ||
        conversation.taskId !== task.id ||
        conversation.rowVersion !== version ||
        conversation.source.sessionId !== source.sessionId ||
        conversation.source.seq >= source.seq ||
        !this.feishuInputs.hasCurrentSource(conversation.source, task.botId)
      ) {
        throw new AppError(
          'session-preview-stale',
          '请先在原聊天展示当前会话的完整历史和目录授权范围，再接收本人确认。',
        );
      }
      const fullSource = combineChatSources(conversation.source, source);
      const binding = await this.execution.attachExistingSession(
        requestId,
        {
          taskId: task.id,
          expectedRowVersion: version,
          sessionId: preview.sessionId,
          cwd: preview.cwd,
          fullHistoryApproved: true,
          directoryApproved: true,
          source: fullSource,
        },
        () => {
          authorize();
          if (!this.feishuInputs.hasCurrentSource(fullSource, task.botId)) {
            throw new AppError('session-preview-stale', '原关联预览或确认的本人来源已经改变。');
          }
        },
      );
      this.store.set(this.sessionConversationKey(manager), '');
      return { binding, task: this.store.getTask(task.id) };
    }
    if (action === 'session-detach')
      return {
        task: await this.execution.endTaskLink(
          'session.detach',
          requestId,
          task.id,
          version,
          authorize,
        ),
      };
    if (action === 'session-reconcile') {
      const binding = this.store.activeBinding(task.id);
      if (!binding) throw new AppError('binding-stale', '任务没有可核对的执行会话申请。');
      return {
        binding: await this.execution.reconcileBinding(binding.id, () => {
          authorize();
          const current = this.store.getTask(task.id);
          if (
            current.rowVersion !== version ||
            this.store.activeBinding(task.id)?.id !== binding.id
          ) {
            throw new AppError('binding-stale', '任务或当前会话申请已经改变。');
          }
        }),
      };
    }
    if (action === 'workdir-cleanup')
      return { binding: await this.execution.cleanupWorkdir(task.id, authorize) };
    const notificationId = requiredText(data.notificationId, '通知标识', 300),
      event = this.store.managerEvent(notificationId);
    const resolution = data.notificationResolution;
    if (!event || event.taskId !== task.id || JSON.parse(event.payload).botId !== task.botId)
      throw new AppError('not-found', '通知不属于当前任务。');
    this.checkWorkLinks(source.text, task.id, undefined, JSON.parse(event.payload).resultId);
    if (resolution !== 'handled' && resolution !== 'retry-unsent')
      throw new AppError('invalid-input', '请选择处理或重试当前通知。');
    this.resolveNotification(requestId, task.botId, notificationId, resolution, true, source);
    return { notification: this.store.managerEvent(notificationId)?.state };
  }
  private earlierDirections(
    raw: unknown,
    owner: OwnerSource,
    task: Task,
  ): Omit<RecoveryDirection, 'id'>[] | undefined {
    if (raw === undefined) return;
    if (!Array.isArray(raw) || !raw.length)
      throw new AppError('invalid-input', '请选择本轮对同一任务的补充消息。');
    const candidates = (this.userMessages.get(owner.sessionId) ?? [])
      .filter((source) => source.seq < owner.seq)
      .sort((a, b) => a.seq - b.seq);
    let lastSeq = -1;
    return raw.map((item) => {
      const text = requiredText(item?.text, '用户指令原文', 32_000),
        mode = item?.continuationMode;
      if (mode !== 'read-only' && mode !== 'authorized-work')
        throw new AppError('invalid-input', '请核对具体补充指示的授权范围。');
      const source = candidates.find(
        (candidate) => candidate.seq > lastSeq && candidate.text.trim() === text,
      );
      if (!source || !this.feishuInputs.hasCurrentSource(source, task.botId)) {
        throw new AppError('control-human-text', '请按顺序使用本轮中对同一任务的真实补充原文。');
      }
      this.checkWorkLinks(source.text, task.id);
      lastSeq = source.seq;
      return { source, mode };
    });
  }
  private deliveryAccess(sessionId: string, data: Record<string, unknown>): void {
    const delivery = this.deliveryScopes.get(sessionId);
    if (!delivery) return;
    if (
      !['list', 'detail', 'deliver'].includes(String(data.action)) ||
      (data.action !== 'list' && data.taskId !== delivery.taskId) ||
      (data.action === 'deliver' &&
        (data.resultId !== delivery.resultId ||
          data.links !== undefined ||
          data.primaryLink !== undefined))
    ) {
      throw new AppError('delivery-only', '本轮只补交付指定成果，不能派发、返工或修改任务。');
    }
    if (
      data.action === 'detail' &&
      this.store.taskDetail(delivery.taskId).result?.id !== delivery.resultId
    )
      throw new AppError('result-stale', '补交付的成果已经改变，请核对当前任务。');
  }
  private async manage(args: unknown, exec: ToolRunContext): Promise<unknown> {
    const agent = exec.agent;
    if (!agent) throw new AppError('manager-scope', '缺少管理身份。');
    const manager = this.authority(agent.id),
      bot = this.store.getBot(manager.botId),
      data = args as Record<string, unknown>;
    const checkAction = () => {
      this.deliveryAccess(agent.id, data);
      const notice = this.notificationTurns.get(agent.id);
      const stageNotice = notice && this.store.managerEvent(notice.eventId);
      if (
        stageNotice?.taskId &&
        (this.lateJobNotice(stageNotice) ||
          stageNotice.id.startsWith('manager-event:continuation-blocked:')) &&
        (data.taskId !== stageNotice.taskId || data.action !== 'detail')
      ) {
        throw new AppError('recovery-only', '此通知只读取原任务的续轮状态。');
      }
      if (
        stageNotice?.taskId &&
        /^manager-event:stage-(settled|blocked|unavailable):/.test(stageNotice.id) &&
        (data.taskId !== stageNotice.taskId ||
          !['detail', 'advance_stage', 'block_stage', 'model-preview'].includes(
            String(data.action),
          ))
      ) {
        throw new AppError('stage-scope', '阶段通知只允许核对同一任务及其已授权下一步。');
      }
      if (
        stageNotice?.taskId &&
        stageNotice.id.startsWith('manager-event:gitlab-release:') &&
        (data.taskId !== stageNotice.taskId || data.action !== 'detail')
      ) {
        throw new AppError('gitlab-release-scope', '正式作业通知只能读取该任务的实际回执。');
      }
      const recovery = this.recoveryScopes.get(agent.id);
      if (
        recovery &&
        (data.taskId !== recovery.taskId ||
          !['detail', 'inspect-recovery', 'recover-preflight', 'continue'].includes(
            String(data.action),
          ))
      ) {
        throw new AppError('recovery-only', '恢复通知只允许处理同一任务的已授权只读步骤。');
      }
    };
    checkAction();
    const authorize = () => {
      exec.signal.throwIfAborted();
      this.authority(agent.id, manager.id);
      checkAction();
    };
    const requestId = `manager:${manager.id}:${exec.callId}`;
    if (data.action === 'list')
      return this.store.listTasks({
        botId: bot.id,
        q: optionalText(data.query, '搜索', 200),
        offset: data.offset as number | undefined,
        limit: 25,
      });
    if (data.action === 'model-preview') {
      const taskId =
        data.taskId === undefined ? undefined : requiredText(data.taskId, '任务标识', 200);
      if (taskId && this.store.getTask(taskId).botId !== bot.id)
        throw new AppError('manager-scope', '只能查看自己负责的任务。');
      const preview = await this.execution.modelPreview(bot.id, taskId, agent);
      authorize();
      return preview;
    }
    if (
      data.action === 'memory-index' ||
      data.action === 'memory-read' ||
      data.action === 'memory-save-convention'
    ) {
      const memory = this.store.memory;
      if (!memory) throw new AppError('memory-unavailable', '本端 Bot 记忆不可用。');
      authorize();
      if (data.action === 'memory-index') return { markdown: memory.index(bot.id) };
      if (data.action === 'memory-save-convention') {
        const source = this.humanTurnSource(agent.id),
          latest = source.messages?.at(-1) ?? source;
        const text = conventionExcerpt(data.text, latest);
        memory.saveConvention(bot.id, text, manager.generation, latest.seq);
        return { entry: CONVENTION_FILE, text };
      }
      const entry = requiredText(data.entry, '记忆条目', 100);
      if (entry === CONVENTION_FILE)
        return { entry, text: memory.defaultConvention(bot.id) ?? null };
      const { source, text } = memory.readDecision(bot.id, entry);
      if (
        this.store.getTask(source.taskId).botId !== bot.id ||
        (source.kind === 'result' &&
          this.store.resultById(source.resultId)?.taskId !== source.taskId)
      ) {
        throw new AppError('memory-source', '无法核对此 Bot 的决策来源。');
      }
      return { entry, text, source: `[来源](${chatHref(workUrl(source), this.webOrigin())})` };
    }
    if (data.action === 'create') {
      // Default one step: Bot-inferred scope/acceptance (or conservative defaults) satisfy the ledger, then dispatch.
      // dispatch:false keeps the clarification flow: missing essentials become an input question.
      const oneStep = data.dispatch !== false;
      const scope = optionalText(data.scope, '范围') || (oneStep ? DEFAULT_SCOPE : ''),
        acceptance =
          optionalText(data.acceptance, '验收条件') || (oneStep ? DEFAULT_ACCEPTANCE : '');
      const workdir = parseWorkdirRequest(data.workdir);
      const source = this.humanTurnSource(agent.id);
      const override =
        data.conventionOverride === undefined
          ? undefined
          : conventionExcerpt(data.conventionOverride, source.messages?.at(-1) ?? source);
      const releaseFields = data.gitLabRelease as Record<string, unknown> | undefined;
      let authorizedRelease, releaseSource;
      if (releaseFields !== undefined) {
        const { owner } = this.ownerTurn(agent, authorize);
        if (
          !releaseFields ||
          releaseFields.intent !== 'publish' ||
          data.userInstruction !== owner.text.trim() ||
          !fullAccessEnabled(this.options) ||
          data.continuationMode === 'read-only'
        ) {
          throw new AppError('gitlab-release-scope', '需要原聊天中的完整、明确的发布授权。');
        }
        authorizedRelease = {
          reference: requiredText(releaseFields.reference, 'GitLab 合并请求链接', 1000),
          jobName: releaseJobName(releaseFields.jobName),
          requiresJobName: releaseFields.requiresJobName === true,
        };
        releaseSource = chatSource(owner);
      }
      const created = this.store.createTask(
        requestId,
        {
          botId: bot.id,
          goal: requiredText(data.goal, '目标'),
          scope,
          acceptance,
          reviewPolicy: 'human',
          ...(workdir ? { workdir } : {}),
        },
        releaseSource ?? source,
        override,
        authorizedRelease,
      );
      if (!oneStep) return { task: created };
      authorize();
      const started = await this.startCreated(requestId, created.id, agent, authorize);
      return { task: this.store.getTask(created.id), ...started };
    }
    if (data.action === 'clarify') {
      const { owner } = this.ownerTurn(agent, authorize),
        turn = this.nativeTurns.get(owner.sessionId)!;
      const action = data.followUp as ClarificationAction;
      if (
        chatUrls(owner.text).some(
          (url) =>
            url.pathname === '/' && new URLSearchParams(url.hash.slice(1)).has('super-bot-task'),
        )
      ) {
        throw new AppError(
          'clarification-scope',
          '请选择当前 Bot 中确实可能对应这条消息的候选任务。',
        );
      }
      const options = clarificationOptions(this.store, bot.id, action, data);
      const numberedChoices = options.map((item, index) => ({
        number: index + 1,
        label: item.label ?? item.name,
      }));
      const question = `请选定要处理的项目。\n${numberedChoices.map(({ number, label }) => `${number}. ${label}`).join('\n')}`;
      const receipt: Clarification = { turn, action, source: chatSource(owner), options, question };
      this.store.set(this.clarificationKey(manager), JSON.stringify(receipt));
      return {
        choices: options.map((item) => item.name),
        numberedChoices,
        confirmationText: question,
      };
    }
    const task = this.store.getTask(requiredText(data.taskId, '任务标识', 200));
    if (task.botId !== bot.id)
      throw new AppError('manager-scope', '只能查看或管理自己负责的任务。');
    const sessionId = agent.id,
      notice = this.notificationTurns.get(sessionId);
    const event = notice && this.store.managerEvent(notice.eventId);
    if (isOwnerWorkAction(data.action)) {
      const { owner, check } = this.ownerTurn(agent, authorize);
      if (requiredText(data.userInstruction, '用户指令原文', 32_000) !== owner.text.trim()) {
        throw new AppError('control-human-text', '请使用当前用户消息的完整原文。');
      }
      if (!Number.isSafeInteger(data.expectedRowVersion) || Number(data.expectedRowVersion) < 1) {
        throw new AppError('version-conflict', '请使用当前任务的版本。');
      }
      const sessionChoice = data.action === 'session-inspect' && data.sessionQuery === undefined;
      const chosen =
        data.choice !== undefined && !sessionChoice
          ? this.clarifiedSource(manager, task, data, owner)
          : undefined;
      const source = chosen ?? chatSource(owner);
      const authorizeOwner = () => {
        check();
        if (
          this.store.getTask(task.id).botId !== bot.id ||
          !this.feishuInputs.hasCurrentSource(source, bot.id)
        ) {
          throw new AppError('manager-scope', '用户消息来源或任务权限已经改变。');
        }
      };
      return this.ownerWorkAction(
        data.action,
        manager,
        task,
        source,
        data,
        authorizeOwner,
        exec.signal,
        chosen !== undefined,
      );
    }
    if (data.action === 'advance_stage' || data.action === 'block_stage') {
      const runId = requiredText(data.runId, '阶段执行标识', 200),
        version = data.expectedRowVersion as number;
      const actionOwner = notice ? null : this.ownerTurn(agent, authorize);
      const check = notice
        ? () => {
            authorize();
            const target = `manager-event:stage-settled:${runId}`;
            if (
              !event ||
              (event.id !== target && event.id !== `${target}:${version}`) ||
              !this.store.managerEventTargets(event.id, notice.messageId, bot.id, task.id) ||
              this.notificationTurns.get(sessionId) !== notice ||
              this.nativeTurns.get(sessionId) !== notice.turn ||
              this.userMessages.get(sessionId)?.length ||
              agent.inbox.nextTurn.length ||
              agent.inbox.nextStep.length
            ) {
              throw new AppError(
                'stage-scope',
                '阶段通知只处理同一任务，且不能取代更新的用户指示。',
              );
            }
          }
        : actionOwner!.check;
      check();
      if (data.action === 'block_stage')
        return this.store.blockStage(requestId, bot.id, task.id, version, runId, data.note);
      const replacing = data.stageFollowUp === 'replace';
      const retrying = !!actionOwner && task.stageState === 'blocked' && !replacing;
      if ((data.stageFollowUp !== undefined && !replacing) || (replacing && !actionOwner)) {
        throw new AppError('stage-scope', '只有当前 Bot 对话的真实用户可以替换阶段。');
      }
      const releaseData = data.gitLabRelease;
      if (replacing || retrying || (releaseData !== undefined && actionOwner)) {
        const text = requiredText(data.userInstruction, '用户指令原文', 32_000);
        if (text !== actionOwner!.owner.text.trim())
          throw new AppError('control-human-text', '请使用当前用户消息的完整原文。');
        this.checkWorkLinks(text, task.id);
      }
      let release: ReleaseAuthorization | undefined;
      if (releaseData !== undefined) {
        if (!fullAccessEnabled(this.options))
          throw new AppError(
            'gitlab-release-permission',
            '当前 Worker 为文件权限模式。正式 GitLab 作业需要宿主提供执行权限。',
          );
        if (
          !releaseData ||
          typeof releaseData !== 'object' ||
          Array.isArray(releaseData) ||
          data.continuationMode === 'read-only' ||
          Object.keys(releaseData).some(
            (key) => !['jobName', 'intent', 'requiresJobName'].includes(key),
          )
        ) {
          throw new AppError(
            'gitlab-release-scope',
            '请使用核对过的 GitLab 合并请求和发布作业名称。',
          );
        }
        const fields = releaseData as Record<string, unknown>;
        const { intent } = fields;
        if (
          intent !== 'publish' &&
          intent !== 'select' &&
          intent !== 'retry' &&
          intent !== 'clarify'
        ) {
          throw new AppError(
            'gitlab-release-scope',
            '需要明确的发布授权、作业选择或对已恢复权限的确认。',
          );
        }
        const recorded = this.store.taskDetail(task.id).stage;
        const jobName = releaseJobName(fields.jobName);
        if (
          intent === 'select' &&
          (!actionOwner || !recorded || recorded.runId !== runId || task.rowVersion !== version)
        ) {
          throw new AppError('gitlab-choice-stale', '该作业选项、任务版本或原聊天已经改变。');
        }
        const selection =
          intent === 'select'
            ? this.shownGitLabChoice(manager, task, recorded!, jobName, actionOwner!.owner)
            : undefined;
        check();
        release = actionOwner
          ? {
              source: chatSource(actionOwner.owner),
              intent,
              jobName,
              requiresJobName: fields.requiresJobName === true,
              ...(selection ? { selection } : {}),
            }
          : intent === 'publish' && recorded
            ? (this.store.gitLabTaskAuthorization(task.id, recorded.evidenceRef) ?? undefined)
            : undefined;
        if (!release)
          throw new AppError(
            'gitlab-release-scope',
            '需要原 Bot 对话对当前任务版本的明确发布授权。',
          );
      }
      const saved = this.store.advanceStage(
        requestId,
        bot.id,
        task.id,
        version,
        runId,
        data.nextStep,
        data.condition,
        gitLabObservationOrigin(this.options.gitLabObserverOrigin),
        retrying,
        replacing || release
          ? {
              ...(replacing ? { source: chatSource(actionOwner!.owner) } : {}),
              ...(release ? { release } : {}),
            }
          : undefined,
      );
      if (release?.selection) this.store.set(this.gitLabQuestionKey(manager), '');
      if (saved.stage.state !== 'ready') return saved;
      const latest = this.store.taskDetail(task.id);
      if (latest.task.rowVersion !== saved.task.rowVersion) {
        const stage = latest.stages.find((item) => item.runId === runId) ?? saved.stage;
        return {
          task: latest.task,
          stage,
          ...(stage.dispatchedRunId ? { run: this.store.getRun(stage.dispatchedRunId) } : {}),
        };
      }
      const dispatched = await this.runPrepared(
        `${requestId}:stage-dispatch`,
        saved.task,
        agent,
        check,
      );
      return { ...saved, ...dispatched, task: this.store.getTask(task.id) };
    }
    const checkRecoveryNotice = () => {
      authorize();
      if (
        !notice ||
        !event ||
        !this.isRecoveryNotice(event) ||
        !this.store.managerEventTargets(event.id, notice.messageId, bot.id, task.id) ||
        this.notificationTurns.get(sessionId) !== notice ||
        this.nativeTurns.get(sessionId) !== notice.turn ||
        this.userMessages.get(sessionId)?.length ||
        agent.inbox.nextTurn.length ||
        agent.inbox.nextStep.length
      ) {
        throw new AppError(
          'recovery-scope',
          '恢复通知只处理当前任务。若收到更新的用户输入，先处理那条输入。',
        );
      }
    };
    if (data.action === 'inspect-recovery' || data.action === 'recover-preflight') {
      const check = notice ? checkRecoveryNotice : this.ownerTurn(agent, authorize).check;
      check();
      const currentRunId = this.store.latestRun(task.id)?.id;
      const runId = notice
        ? ((event && this.recoveryNoticeRun(event)) ?? currentRunId)
        : currentRunId;
      if (!runId) throw new AppError('recovery-scope', '当前没有可直接核对的执行记录。');
      if (data.action === 'inspect-recovery')
        return this.execution.inspectAutoRecovery(
          task.id,
          task.rowVersion,
          runId,
          manager.id,
          check,
        );
      const rowVersion = data.expectedRowVersion;
      if (typeof rowVersion !== 'number' || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
        throw new AppError('recovery-version', '请使用核对结果中的 rowVersion。');
      }
      return this.execution.performAutoRecovery(
        task.id,
        rowVersion,
        runId,
        manager.id,
        exec.signal,
        check,
      );
    }
    if (data.action === 'continue') {
      if (notice) {
        checkRecoveryNotice();
        const pending = this.pendingRecoveryInstruction(task.id);
        return {
          status: pending ? 'waiting' : 'already-handled',
          message: pending
            ? '宿主会按已保存的用户指示安排接续。请读取该任务的当前状态。'
            : '此通知没有待派发的用户补充。',
        };
      }
      const { owner, check } = this.ownerTurn(agent, authorize);
      if (data.ownerFact !== undefined || data.decision !== undefined) {
        throw new AppError('recovery-scope', '沿用授权不会核对旧执行的外部效果。');
      }
      const instruction = requiredText(data.userInstruction, '用户指令原文');
      const mode = data.continuationMode;
      if (mode !== undefined && mode !== 'read-only' && mode !== 'authorized-work')
        throw new AppError('invalid-input', '请核对当前具体指示的授权范围。');
      const stageFollowUp = data.stageFollowUp;
      const lateJobFollowUp = data.lateJobFollowUp;
      if (lateJobFollowUp !== undefined && lateJobFollowUp !== 'append')
        throw new AppError('invalid-input', '后台等待只接收同一报告的补充。');
      if (
        stageFollowUp !== undefined &&
        stageFollowUp !== 'append' &&
        stageFollowUp !== 'replace' &&
        stageFollowUp !== 'revoke'
      ) {
        throw new AppError('invalid-input', '请核对阶段指示属于追加、替换还是撤回。');
      }
      const changeKind = data.directionChange,
        ids = data.directionIds;
      if (
        (changeKind !== undefined && changeKind !== 'replace' && changeKind !== 'revoke') ||
        (ids !== undefined &&
          (!changeKind ||
            !Array.isArray(ids) ||
            !ids.length ||
            ids.some((id) => typeof id !== 'string')))
      ) {
        throw new AppError('invalid-input', '请核对要替代或撤回的已保存指示。');
      }
      const change: RecoveryDirectionChange | undefined = changeKind
        ? { kind: changeKind, ...(ids ? { ids: ids as string[] } : {}) }
        : undefined;
      const useEarlier = data.useEarlierDirection === true;
      if (
        useEarlier &&
        (!mode ||
          change ||
          data.earlierDirections !== undefined ||
          data.choice !== undefined ||
          data.useLatestDirection ||
          data.resumeManagement)
      ) {
        throw new AppError('direction-stale', '同轮较早的指示只能用于追加正在执行的工作。');
      }
      if (!useEarlier && instruction !== owner.text.trim())
        throw new AppError('control-human-text', '请使用当前用户消息的完整原文。');
      this.checkWorkLinks(instruction, task.id);
      const source = useEarlier
        ? this.earlierDirections([{ text: instruction, continuationMode: mode }], owner, task)![0]!
            .source
        : data.choice !== undefined
          ? this.clarifiedSource(manager, task, data, owner)
          : chatSource(owner);
      if (data.earlierDirections !== undefined && (change || data.choice !== undefined)) {
        throw new AppError('invalid-input', '合并同轮的补充消息仅适用于已确定任务的追加指示。');
      }
      const earlier = this.earlierDirections(data.earlierDirections, owner, task);
      const keepDirection = data.useLatestDirection === true;
      if (mode && keepDirection)
        throw new AppError(
          'recovery-scope',
          '用户确认继续时沿用上一条具体指示，请勿添加新的授权范围。',
        );
      if (!mode && !keepDirection && !change && stageFollowUp !== 'revoke') {
        throw new AppError('invalid-input', '请选择新指示的工作范围，或明确沿用已有授权。');
      }
      if (
        keepDirection &&
        !stageFollowUp &&
        !data.resumeManagement &&
        ['awaiting-decision', 'waiting', 'ready'].includes(task.stageState ?? '')
      ) {
        const detail = this.store.taskDetail(task.id);
        if (task.rowVersion !== data.expectedRowVersion)
          throw new AppError('version-conflict', '任务或阶段已经更新。');
        return {
          status: 'waiting',
          task: detail.task,
          stage: detail.stage,
          directionStatus: detail.directionStatus,
          wait: detail.wait,
          message: '已保留原阶段的条件和下一步。请按当前阶段、控制模式与名额状态回报。',
        };
      }
      const pending = this.pendingRecoveryInstruction(task.id);
      const stage = this.store.taskStage(task);
      const appendingToStage = stageFollowUpForDirection(stage, stageFollowUp, !!(mode || change));
      const earlierInstruction =
        stage && appendingToStage === 'append'
          ? this.store.stageSupplement(task.id, stage.runId)
          : pending;
      const retained =
        earlierInstruction?.directions?.filter(
          (direction) => !change || change.ids?.includes(direction.id) === false,
        ) ?? [];
      if (
        retained.some((direction) => !this.feishuInputs.hasCurrentSource(direction.source, bot.id))
      ) {
        throw new AppError(
          'recovery-scope',
          '此前补充指示的飞书身份或群绑定已变更，请在当前对话确认具体下一步。',
        );
      }
      const saved = this.store.saveRecoveryInstruction(
        task.id,
        data.expectedRowVersion as number,
        source,
        mode,
        keepDirection,
        data.resumeManagement === true,
        change,
        earlier || useEarlier || stageFollowUp || lateJobFollowUp
          ? { earlier, onlyWhileActive: useEarlier || undefined, stageFollowUp, lateJobFollowUp }
          : undefined,
      );
      if (saved.instruction.source.messageId !== source.messageId) {
        return {
          status: 'already-handled',
          directionStatus: 'archived',
          message: '这条指示已有记录。',
        };
      }
      const receipt = () => {
        const current = this.store.recoveryInstruction(task.id);
        return current?.id === saved.instruction.id
          ? this.store.recoveryDirectionStatus(current)
          : 'archived';
      };
      if (saved.instruction.runId)
        return {
          status: 'already-started',
          task: saved.task,
          run: this.store.getRun(saved.instruction.runId),
          directionStatus: receipt(),
        };
      if (receipt() === 'revoked')
        return { status: 'revoked', directionStatus: 'revoked', message: '已撤回待处理的指示。' };
      if (saved.instruction.stageRunId) {
        const detail = this.store.taskDetail(task.id);
        return {
          status: 'waiting',
          task: detail.task,
          stage: detail.stage,
          wait: detail.wait,
          directionStatus: receipt(),
          message: '已保存补充指示。原阶段的条件和下一步继续保留，将随原计划一并交给 Worker。',
        };
      }
      if (lateJobFollowUp === 'append')
        return {
          status: 'waiting',
          task: saved.task,
          directionStatus: receipt(),
          message: '已保存同一报告的补充。Bot 继续核对原后台结果，并在续轮把补充交给原 Worker。',
        };
      if (useEarlier) {
        const directionStatus = receipt();
        return {
          status: 'waiting',
          directionStatus,
          message:
            directionStatus === 'next-run'
              ? '已记下指示，将在原任务的下一轮处理。'
              : '已记下指示。',
        };
      }
      const outcome = await this.execution.continueRecovery(
        task.id,
        saved.task.rowVersion,
        manager.id,
        () => {
          check();
          if (!this.currentInstructionSources(saved.instruction, bot.id)) {
            throw new AppError('recovery-scope', '用户原消息的飞书绑定已变更。');
          }
        },
        agent,
      );
      if (
        outcome.status === 'blocked' ||
        outcome.code === 'capacity' ||
        outcome.code === 'session-unavailable'
      )
        this.continuationAttempts.set(task.id, {
          rowVersion: saved.task.rowVersion,
          managerSessionId: agent.id,
          waitingForCapacity: outcome.code === 'capacity',
          retryAt:
            outcome.code === 'session-unavailable'
              ? Date.now() + WORKER_SESSION_RETRY_MS
              : undefined,
        });
      return { ...outcome, directionStatus: receipt() };
    }
    if (
      data.action === 'pause' ||
      data.action === 'resume' ||
      data.action === 'stop' ||
      data.action === 'close' ||
      data.action === 'cancel'
    ) {
      const { owner, check } = this.ownerTurn(agent, authorize);
      const authorizeControl = () => {
        check();
        if (this.store.getTask(task.id).botId !== bot.id)
          throw new AppError('manager-scope', '只能管理自己负责的任务。');
      };
      authorizeControl();
      const instruction = requiredText(data.userInstruction, '用户指令原文');
      if (instruction !== owner.text.trim())
        throw new AppError('control-human-text', '请提供当前用户消息的完整原文，包括其中的链接。');
      const targetSource =
        data.choice !== undefined
          ? this.clarifiedSource(manager, task, data, owner)
          : chatSource(owner);
      this.checkWorkLinks(targetSource.text, task.id);
      const rowVersion = data.expectedRowVersion as number;
      if (data.action === 'stop') {
        const runId = requiredText(data.runId, '执行标识', 200);
        const stop = await this.execution.stop(
          requestId,
          task.id,
          rowVersion,
          runId,
          authorizeControl,
        );
        return { task: this.store.getTask(task.id), run: this.store.getRun(stop.runId), stop };
      }
      if (data.action === 'close' || data.action === 'cancel')
        return this.execution.closeTask(requestId, task.id, rowVersion, authorizeControl);
      this.store.controlTask(
        requestId,
        task.id,
        rowVersion,
        data.action === 'pause' ? 'paused' : 'auto',
      );
      if (data.action === 'resume') this.execution.resumeUnsentTask?.(task.id);
      return { task: this.store.getTask(task.id), run: this.store.latestRun(task.id) };
    }
    if (data.action === 'respond' || data.action === 'rework') {
      const currentInput = this.humanTurnSource(agent.id);
      const { owner } = this.ownerTurn(agent, authorize);
      const source =
        data.choice !== undefined ? this.clarifiedSource(manager, task, data, owner) : currentInput;
      if (data.action === 'respond') {
        const attentionId = requiredText(data.attentionId, '问题标识', 200);
        if (!this.store.taskDetail(task.id).attentions.some((item) => item.id === attentionId))
          throw new AppError('manager-scope', '问题不属于当前任务。');
        this.checkWorkLinks(source.text, task.id, attentionId);
        // Route by immutable command values, not a binding that may change before a retry.
        // Only omitted/exact-empty optional strings are neutral; other values retain completion validation.
        if ([data.scope, data.acceptance].some((value) => value !== undefined && value !== ''))
          return {
            task: this.store.completeTaskInput(
              requestId,
              task.id,
              attentionId,
              data.expectedRowVersion as number,
              {
                scope: data.scope as string | undefined,
                acceptance: data.acceptance as string | undefined,
              },
              source,
            ),
          };
        return {
          input: this.store.respondAttention(
            requestId,
            attentionId,
            data.expectedRowVersion as number,
            source.text,
            source,
          ),
          task: this.store.getTask(task.id),
        };
      }
      const resultId = requiredText(data.resultId, '成果标识', 200);
      this.checkWorkLinks(source.text, task.id, undefined, resultId);
      return {
        task: this.store.rejectResult(
          requestId,
          task.id,
          data.expectedRowVersion as number,
          resultId,
          source.text,
          source,
        ),
      };
    }
    if (data.action === 'detail') {
      const detail = this.store.taskDetail(task.id);
      const files: { path: string; text: string; bytes: number; truncated: boolean }[] = [];
      let gitLabCurrentStatus;
      if (data.refreshGitLabRelease === true && detail.gitLabRelease) {
        const { check } = this.ownerTurn(agent, authorize);
        const receipt = detail.gitLabRelease;
        if (task.rowVersion !== data.expectedRowVersion)
          throw new AppError('version-conflict', '任务已经更新，请重新读取当前发布作业。');
        const read = await gitLabReader(
          receipt.target.origin,
          this.options.gitLabObserverOrigin,
          exec.signal,
        );
        const response = await read(releaseJobPath(receipt.target), exec.signal);
        check();
        const latest = this.store.taskDetail(task.id);
        if (
          latest.task.rowVersion !== task.rowVersion ||
          latest.gitLabRelease?.stageRunId !== receipt.stageRunId
        ) {
          throw new AppError('gitlab-release-stale', '核对期间正式作业或任务版本已改变。');
        }
        const status = exactJobStatus(response.data, receipt.target);
        gitLabCurrentStatus = {
          url: receipt.url,
          checkedAt: Date.now(),
          status: status ?? null,
          detail: status ? `指定作业当前显示 ${status}。` : '本次无法读取指定作业的最新状态。',
        };
      }
      let evidenceValidation: {
        status: 'not-applicable' | 'verified' | 'failed';
        code?: string;
        message?: string;
      } = { status: 'not-applicable' };
      if (detail.result && detail.binding) {
        try {
          files.push(...(await previewEvidence(detail.binding.cwd, detail.result.evidence)));
          evidenceValidation = { status: 'verified' };
        } catch (error) {
          // Metadata remains readable; never return an unverified or partially verified preview.
          if (
            !(error instanceof AppError) ||
            ![
              'evidence-changed',
              'evidence-unavailable',
              'evidence-size',
              'invalid-evidence',
              'path-outside',
              'evidence-sensitive',
            ].includes(error.code)
          )
            throw error;
          evidenceValidation = { status: 'failed', code: error.code, message: error.message };
        }
      }
      authorize();
      const current = this.store.taskDetail(task.id),
        origin = this.webOrigin();
      if (current.result?.id !== detail.result?.id || current.binding?.id !== detail.binding?.id) {
        files.length = 0;
        evidenceValidation = { status: 'not-applicable' };
      }
      const questionEvent = this.workerQuestionEvent(this.notificationTurns.get(agent.id)?.eventId);
      const pendingQuestions = current.pendingQuestions.filter(
        (question) => !questionEvent || question.id === questionEvent,
      );
      const result = current.result,
        humanAcceptanceRequired = current.task.lifecycle === 'review';
      const links = result
        ? deliveryLinks(
            task.id,
            result.id,
            result.evidence.map((file) => file.path),
          )
        : null;
      const { stages: _stageHistory, stage, ...snapshot } = current;
      const gitLabReleaseQuestion = this.offerGitLabChoices(manager, current.task, current.stage);
      const { releaseChoices, ...observation } = stage?.observation ?? {};
      const visibleStage = releaseChoices && stage ? { ...stage, observation } : stage;
      const notifications = this.store
        .managerNotifications(bot.id, 50)
        .filter((item) => item.taskId === task.id && ['unknown', 'blocked'].includes(item.state))
        .map((item) => {
          const { reason, resultId, preflightFailures, messageId } = JSON.parse(item.payload);
          return {
            id: item.id,
            state: item.state,
            ...(typeof reason === 'string' ? { reason } : {}),
            ...(typeof resultId === 'string' ? { resultId } : {}),
            at: item.createdAt,
            retryable:
              item.state === 'blocked' && Number(preflightFailures) === 5 && messageId == null,
          };
        });
      return {
        ...snapshot,
        stage: visibleStage,
        stageObserver: {
          provider: 'gitlab',
          origin: gitLabObservationOrigin(this.options.gitLabObserverOrigin),
        },
        ...gitLabReleaseQuestion,
        ...(gitLabCurrentStatus ? { gitLabCurrentStatus } : {}),
        notifications,
        pendingQuestions: pendingQuestions.map((question) => questionLink(question, origin)),
        ...(pendingQuestions.length ? { questionReplyInstruction: QUESTION_REPLY } : {}),
        evidenceValidation,
        delivery:
          result && links
            ? {
                summary: result.summary,
                checks: result.checks,
                ...links,
                humanAcceptanceRequired,
                ...(current.deliveredResult?.id !== result.id
                  ? { artifacts: this.store.reportedDeliveryArtifacts(result.runId) }
                  : {}),
                chatMarkdown: deliveryResultLink(links.workUrl, origin),
              }
            : null,
        botContext: this.store.taskBotContext(task.id),
        files,
      };
    }
    const current = () => {
      if (task.rowVersion !== data.expectedRowVersion || task.controlMode !== 'auto')
        throw new AppError('manager-stale', '任务已更新或自动管理已暂停，请重新读取。');
    };
    if (data.action === 'dispatch') {
      const receipt = this.store.managerDispatchReceipt(
        requestId,
        task.id,
        data.expectedRowVersion as number,
      );
      if (receipt) {
        if ('run' in receipt)
          return {
            ...receipt,
            workdir: this.runWorkdir(receipt.run),
            expectedModel: this.store.runModelPlan(receipt.run.id),
          };
        return this.preparedDispatch(receipt.prepared, true);
      }
      current();
      const detail = this.store.taskDetail(task.id);
      if (
        detail.recoveryInstruction?.mode &&
        !detail.recoveryInstruction.runId &&
        !detail.recoveryInstruction.stageRunId
      ) {
        return {
          status: 'waiting',
          task: detail.task,
          directionStatus: detail.directionStatus,
          message: '后续指示已记录，Bot 正在原任务中安排执行。',
        };
      }
      if (
        task.status === 'recovery' ||
        (!detail.stage && detail.recoveryCheck) ||
        task.status === 'blocked'
      ) {
        throw new AppError(
          task.status === 'recovery' ? 'recovery-required' : 'recovery-scope',
          '沿用原任务的已授权指示；缺少下一步时，请先结合原聊天和任务现状确定要做的事。',
        );
      }
      const binding = this.store.activeBinding(task.id),
        workdir = parseWorkdirRequest(data.workdir);
      if (
        binding &&
        workdir &&
        !(workdir.mode === 'existing' && workdir.path === binding.cwd) &&
        JSON.stringify(workdir) !== JSON.stringify(task.workdirRequest)
      )
        throw new AppError(
          'workdir-locked',
          `任务已在 ${binding.cwd} 工作；若用户要求迁移，请用会话管理工具在原任务内处理。`,
        );
      if (!binding) {
        const prepared = await this.execution.prepareSession(
          requestId,
          task.id,
          task.rowVersion,
          workdir,
          authorize,
        );
        authorize();
        return this.preparedDispatch(this.store.getBinding(prepared.id), false);
      }
      return this.runPrepared(requestId, task, agent, authorize);
    }
    if (data.action === 'deliver') {
      const resultId = requiredText(data.resultId, '成果标识', 200),
        text = requiredText(data.text, '交付说明', 4000);
      const detail = this.store.taskDetail(task.id);
      if (
        !detail.result ||
        detail.result.id !== resultId ||
        !['review', 'completed'].includes(task.lifecycle)
      )
        throw new AppError('result-stale', '只能交付当前任务已报告、待确认或已完成的成果。');
      authorize();
      const humanAcceptanceRequired = task.lifecycle === 'review',
        links = deliveryLinks(
          task.id,
          resultId,
          detail.result.evidence.map((file) => file.path),
        );
      const resultLink = deliveryResultLink(links.workUrl, this.webOrigin());
      const delivery = {
        taskId: task.id,
        resultId,
        text,
        ...links,
        humanAcceptanceRequired,
        resultLink,
        markdown: `${text}\n\n${resultLink}`,
      };
      const sessionId = agent.id,
        notice = this.notificationTurns.get(sessionId);
      const taskNotice =
        notice &&
        notice.turn === this.nativeTurns.get(sessionId) &&
        this.store.managerEventTargets(notice.eventId, notice.messageId, bot.id, task.id);
      const initial =
        !this.deliveryScopes.has(sessionId) && (this.currentOwner(sessionId) || taskNotice);
      if ((data.links !== undefined || data.primaryLink !== undefined) && !initial)
        throw new AppError('manager-scope', '只能在当前管理轮次提交初始交付物链接。');
      return {
        delivery: this.store.managerDeliver(
          requestId,
          bot.id,
          agent.id,
          exec.rootCallId ?? exec.callId,
          delivery,
          initial ? { links: data.links, primaryLink: data.primaryLink } : undefined,
        ),
      };
    }
    if (data.action === 'update_delivery_links') {
      authorize();
      const sessionId = agent.id,
        source = this.currentOwner(sessionId);
      if (!source || this.notificationTurns.has(sessionId)) {
        throw new AppError(
          'human-message-required',
          '交付物链接更新需要当前 Bot 对话中明确的用户指令。',
        );
      }
      const resultId = requiredText(data.resultId, '成果标识', 200);
      for (const url of chatUrls(source.text.replace(/[，。；、！？「」『』]/gu, ' '))) {
        if (url.pathname !== '/' || !new URLSearchParams(url.hash.slice(1)).has('super-bot-task'))
          continue;
        const linked = parseWorkLink(url.hash);
        if (
          !linked ||
          linked.taskId !== task.id ||
          (linked.kind === 'result' && linked.resultId !== resultId)
        ) {
          throw new AppError('result-stale', '请核对用户消息中引用的任务与成果版本。');
        }
      }
      const links = this.store.managerUpdateDeliveryLinks(
        requestId,
        bot.id,
        sessionId,
        task.id,
        data.expectedRowVersion as number,
        resultId,
        data.links,
        data.primaryLink,
      );
      const primaryLink = this.store.deliveredResult(this.store.getTask(task.id))?.primaryLink;
      return { links, ...(primaryLink ? { primaryLink } : {}) };
    }
    if (data.action === 'review') {
      const resultId = requiredText(data.resultId, '成果标识', 200),
        saved = this.store.resultById(resultId);
      const verdict = data.verdict;
      if (!['accept', 'rework', 'human'].includes(String(verdict)))
        throw new AppError('invalid-review', '请选择验收判断。');
      const partial = verdict === 'accept' && saved?.evidence.some((file) => file.bytes > 12000);
      const note = requiredText(data.note, '验收说明');
      const decision = partial ? 'human' : (verdict as 'accept' | 'rework' | 'human'),
        explanation = requiredText(
          partial
            ? `文件超过 12,000 字节的预览范围，仅完整校验哈希，需人工检查全文。模型建议：${note}`.slice(
                0,
                10000,
              )
            : note,
          '验收判断',
        );
      const requested = partial ? { verdict: 'accept' as const, note } : undefined;
      const receipt = this.store.commandReceipt<import('./model.ts').Task>(
        requestId,
        'manager.review',
        {
          botId: bot.id,
          taskId: task.id,
          expectedRowVersion: data.expectedRowVersion,
          resultId,
          verdict: decision,
          note: explanation,
          ...(requested ? { requested } : {}),
        },
      );
      if (receipt)
        return { task: receipt, humanAcceptanceRequired: receipt.lifecycle === 'review' };
      current();
      const detail = this.store.taskDetail(task.id);
      if (!detail.result || !detail.binding || detail.result.id !== resultId)
        throw new AppError('result-stale', '成果已经改变。');
      if (verdict === 'accept') await this.execution.verifyResult(task.id, resultId);
      authorize();
      const result = this.store.managerReview(
        requestId,
        bot.id,
        task.id,
        task.rowVersion,
        resultId,
        decision,
        explanation,
        requested,
        { reviewSessionId: agent.id, reviewCallId: exec.rootCallId ?? exec.callId },
      );
      return { task: result, humanAcceptanceRequired: result.lifecycle === 'review' };
    }
    throw new AppError('unknown-action', '不支持的管理操作。');
  }

  install(): void {
    this.store.resetUnconfirmedManagerEvents();
    this.execution.registerUnsentDispatchSourceCheck?.(
      (source, botId) => !this.closed && this.feishuInputs.hasCurrentSource(source, botId),
    );
    this.ctx.effect(() =>
      this.ctx.tools.register(
        { ...MANAGER_TOOL, execute: (args, exec) => this.manage(args, exec) },
        { when: ({ agent }) => this.store.managerForSession(agent.id)?.state === 'ready' },
      ),
    );
    const retryContinuationsFor = (sessionId: string) => {
      const workerTaskId =
        this.store.workerTaskForSession(sessionId) ??
        this.store.pendingWorkerTaskForSession(sessionId);
      if (workerTaskId) this.continuationAttempts.delete(workerTaskId);
      for (const [taskId, attempt] of this.continuationAttempts)
        if (attempt.managerSessionId === sessionId) this.continuationAttempts.delete(taskId);
    };
    this.ctx.on('agent/created', ({ agent }) => {
      retryContinuationsFor(agent.id);
      this.attachScope(agent);
    });
    this.ctx.on('session/created', (session) => retryContinuationsFor(session.id));
    this.ctx.on('agent/disposed', ({ agent }) => {
      const scope = this.scopes.get(agent.id);
      if (scope && scope.agent !== agent) return;
      scope?.retire();
      this.scopes.delete(agent.id);
      this.userMessages.delete(agent.id);
      this.ownerSources.delete(agent.id);
      this.mixedOwnerTurns.delete(agent.id);
      this.turnStartSeqs.delete(agent.id);
      this.retainedOwnerInputs.delete(agent.id);
      this.nativeTurns.delete(agent.id);
    });
    for (const agent of this.ctx.agents.list()) this.attachScope(agent);
    this.ctx.on('session/event', (_session, event) => {
      if (this.closed) return;
      const scope = this.scopes.get(_session.id);
      if (scope && scope.agent.session !== _session) return;
      if (event.type === 'model/selection' || event.type === 'working-directory/change')
        retryContinuationsFor(_session.id);
      const nativeTurn = scope?.nativeTurn;
      const liveTurn = this.nativeTurns.get(_session.id);
      if (event.type === 'turn/end' && liveTurn !== undefined && event.data.turn !== liveTurn)
        return;
      if (event.type !== 'user/message') nativeTurn?.observe(event);
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        this.userMessages.delete(_session.id);
        this.ownerSources.delete(_session.id);
        this.mixedOwnerTurns.delete(_session.id);
      }
      if (event.type === 'turn/start' && this.store.managerForSession(_session.id)) {
        this.nativeTurns.set(_session.id, event.data.turn);
        this.turnStartSeqs.set(_session.id, event.seq);
      }
      if (event.type === 'assistant/message') {
        const manager = this.store.managerForSession(_session.id);
        const text = manager && finalAssistantText(event),
          source = text && this.currentOwner(_session.id);
        const notice = this.notificationTurns.get(_session.id);
        if (manager && text)
          for (const [key, question] of this.ownerQuestions(manager)) {
            const sameInput = question?.noticeMessageId
              ? notice?.messageId === question.noticeMessageId &&
                !this.userMessages.get(_session.id)?.length
              : source && source.messageId === question?.source.messageId;
            if (
              question?.question &&
              event.data.turn === question.turn &&
              text.includes(question.question) &&
              sameInput &&
              event.seq > question.source.seq
            ) {
              this.store.set(key, JSON.stringify({ ...question, finalSeq: event.seq }));
            }
          }
      }
      if (event.type === 'turn/end') {
        if (scope && event.data.reason.kind !== 'completed') this.retainOwnerInputs(scope.agent);
        const manager = this.store.managerForSession(_session.id);
        if (manager)
          for (const [key, question] of this.ownerQuestions(manager)) {
            if (question?.selectionTurn === event.data.turn) this.store.set(key, '');
            else if (question?.turn === event.data.turn) {
              this.store.set(
                key,
                event.data.reason.kind === 'completed' &&
                  question.finalSeq !== undefined &&
                  question.finalSeq < event.seq
                  ? JSON.stringify({ ...question, shown: true })
                  : '',
              );
            }
          }
        const own = this.notificationTurns.get(_session.id);
        if (own && own.turn === event.data.turn) {
          this.endedInputs.set(_session.id, own.messageId);
          clearTimeout(this.wakeTimers.get(own.messageId));
          this.wakeTimers.delete(own.messageId);
          this.notificationTurns.delete(_session.id);
          if (this.recoveryScopes.get(_session.id)?.messageId === own.messageId)
            this.recoveryScopes.delete(_session.id);
        }
        this.nativeTurns.delete(_session.id);
        this.turnStartSeqs.delete(_session.id);
      }
      if (event.type === 'user/message') {
        const source = event.data.source,
          turn = this.nativeTurns.get(_session.id);
        let feed: FeishuInput | undefined;
        const manager = turn === undefined ? undefined : this.store.managerForSession(_session.id);
        const nativeOwner = isNativeOwner(event.data);
        const nativeSource = {
          sessionId: _session.id,
          messageId: event.data.id,
          seq: event.seq,
          text: messageText(event.data),
        };
        if (manager && nativeOwner && event.surfaceOp === 'append')
          this.recordOwner(manager, turn!, nativeSource);
        if (isFeishuSource(source) && turn !== undefined) {
          let verified: ReturnType<FeishuInputs['consume']>;
          try {
            verified = this.feishuInputs.consume(_session.id, turn, event);
          } catch {
            /* Failed receipt verification grants no human authority. */
          }
          if (verified && manager) {
            feed = verified.input;
            this.recordOwner(manager, turn, { ...verified.source, feishu: verified.input });
          } else if (this.feishuInputs.hasProposedInput(_session.id, turn, event.data.id)) {
            // Binding or connection changed after native pre-step approval.
            this.ctx.agents.get(_session.id)?.cancel({ kind: 'user' }, { keepInbox: true });
          }
        }
        if (
          manager &&
          event.surfaceOp === 'append' &&
          !nativeOwner &&
          !feed &&
          !isHostContext(event.data)
        ) {
          this.mixedOwnerTurns.add(_session.id);
        }
        nativeTurn?.observe(event, feed);
      }
      if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
        const manager = this.store.managerForSession(_session.id);
        if (manager?.state === 'ready' && !this.store.managerInfo(manager.botId).problem)
          this.store.managerProblem(manager.botId, modelFailureNote(event.data.reason.error.code));
      }
      if (event.type === 'user/message' && event.data.source.kind === 'super-bot-manager') {
        const source = event.data.source;
        const manager = this.store.managerForSession(_session.id);
        if (
          manager?.state === 'ready' &&
          manager.botId === source.botId &&
          manager.id === source.managerId
        ) {
          this.restoreDeliveryScope(_session.id, source.eventId, event.data.id);
          this.store.managerEventEntered(source.eventId, event.data.id);
          const eventRecord = this.store.managerEvent(source.eventId);
          if (
            eventRecord &&
            (this.lateJobNotice(eventRecord) ||
              eventRecord.id.startsWith('manager-event:continuation-blocked:'))
          )
            nativeTurn?.restrict();
          if (
            eventRecord?.taskId &&
            this.isRecoveryNotice(eventRecord) &&
            this.store.managerEventTargets(
              source.eventId,
              event.data.id,
              manager.botId,
              eventRecord.taskId,
              true,
            )
          ) {
            this.scopes.get(_session.id)?.nativeTurn?.restrict();
            this.recoveryScopes.set(_session.id, {
              taskId: eventRecord.taskId,
              messageId: event.data.id,
            });
          }
          const turn = this.nativeTurns.get(_session.id);
          if (turn !== undefined)
            this.notificationTurns.set(_session.id, {
              turn,
              messageId: event.data.id,
              eventId: source.eventId,
            });
          if (/^manager-event:stage-(settled|blocked|unavailable):/.test(source.eventId))
            nativeTurn?.restrict();
        }
      }
      if (event.type === 'turn/end' && this.store.managerForSession(_session.id)) {
        const scope = this.deliveryScopes.get(_session.id),
          botId = this.store.managerForSession(_session.id)!.botId;
        const previous = this.finishing.get(_session.id) ?? Promise.resolve();
        const done = previous
          .then(() => this.reconcileDelivery(_session))
          .catch(() => {
            if (!this.closed) {
              const manager = this.store.managerForSession(_session.id);
              if (manager)
                this.store.managerProblem(
                  manager.botId,
                  '聊天交付尚未得到持久确认；通知已保留，不会重新执行 Worker。',
                );
            }
          })
          .finally(() => {
            // A retained native Inbox input has no monitorWake in this instance. Release only its own turn scope.
            if (!this.waking.has(botId) && this.deliveryScopes.get(_session.id) === scope)
              this.deliveryScopes.delete(_session.id);
            if (this.finishing.get(_session.id) === done) this.finishing.delete(_session.id);
          });
        this.finishing.set(_session.id, done);
        return done;
      }
    });
    this.timer = setInterval(() => {
      void this.pump();
    }, 1000);
    this.timer.unref();
  }
  private preparedDispatch(binding: Binding, replayed: boolean) {
    const task = this.store.getTask(binding.taskId);
    if (binding.state === 'released')
      return { prepared: false, task, message: '此前的会话关联已解除；此请求没有重新关联。' };
    if (binding.state !== 'ready')
      throw new AppError('session-recovery', '此前的会话创建结果需要核对，没有重复创建。');
    if (replayed)
      return { prepared: true, task, message: '此前已准备执行会话；当前状态请以账本为准。' };
    return {
      prepared: true,
      task,
      workdir: workdirSummary(binding.cwd, binding.workdir),
      message: '会话已准备；使用返回的版本再次 dispatch。',
    };
  }
  /** Reserve a Run on an already prepared binding or queue a capacity notification. */
  private async runPrepared(requestId: string, task: Task, manager: Agent, authorize: () => void) {
    const binding = this.store.activeBinding(task.id);
    if (!binding?.sessionId)
      throw new AppError('session-recovery', '执行会话需要核对，不能自动重建。');
    const workdir = workdirSummary(binding.cwd, binding.workdir);
    try {
      const run = await this.execution.dispatch(
        requestId,
        task.id,
        task.rowVersion,
        () => {
          authorize();
          this.checkStageSources(task.id);
        },
        manager,
      );
      return { run, workdir, expectedModel: this.store.runModelPlan(run.id) };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'capacity') throw error;
      authorize();
      this.store.recordCapacityWait(requestId, task.id, task.rowVersion);
      const wait = this.store.dispatchWait(task.id);
      const behind = wait?.holderTaskId
        ? `排在任务 ${wait.holderTaskId}（${(wait.holderGoal ?? '').slice(0, 80)}）之后。`
        : '';
      return {
        deferred: true,
        reason: error.code,
        holderTaskId: wait?.holderTaskId ?? null,
        holderGoal: wait?.holderGoal ?? null,
        capacityScope: 'bot',
        workdir,
        message: `已加入此 Bot 的执行队列。${behind}轮到时会通知你，不要轮询。`,
      };
    }
  }
  private runWorkdir(run: Run): string | null {
    const binding = this.store.getBinding(run.bindingId);
    return binding ? workdirSummary(binding.cwd, binding.workdir) : null;
  }
  /** One-step create: prepare the Worker session and reserve its run inside the create call; retries reuse receipts. */
  private async startCreated(
    requestId: string,
    taskId: string,
    manager: Agent,
    authorize: () => void,
  ): Promise<Record<string, unknown>> {
    const prior = this.store.runForRequest(`${requestId}:dispatch`);
    if (prior)
      return {
        run: prior,
        workdir: this.runWorkdir(prior),
        expectedModel: this.store.runModelPlan(prior.id),
      };
    let task = this.store.getTask(taskId);
    if (
      task.status === 'recovery' ||
      task.controlMode !== 'auto' ||
      task.lifecycle !== 'open' ||
      !task.scope ||
      !task.acceptance
    )
      return { message: '任务已保存，未自动派发；请核对任务状态。' };
    try {
      if (!this.store.activeBinding(task.id)) {
        await this.execution.prepareSession(`${requestId}:prepare`, task.id, task.rowVersion);
        authorize();
        task = this.store.getTask(task.id);
      }
      const result = await this.runPrepared(`${requestId}:dispatch`, task, manager, authorize);
      // The task is already scheduled (or queued for resources); the generic "new task" wake would be redundant.
      this.store.settleManagerEvent(`manager-event:created:${task.id}`);
      return result;
    } catch (error) {
      if (
        error instanceof AppError &&
        !['manager-scope', 'manager-unavailable'].includes(error.code)
      )
        return { dispatchError: { code: error.code, message: error.message } };
      throw error;
    }
  }
  /** Flush then read the native durable log. Live session/event and idle are not storage receipts. */
  private async reconcileDelivery(
    session: Session,
    flush = true,
    selected?: ManagerEvent[],
  ): Promise<void> {
    const manager = this.authority(session.id),
      notifications = selected ?? this.store.managerNotifications(manager.botId, 50);
    if (!notifications.length) return;
    // The Web client also augments Context.sessions; this adapter uses the Host SessionStore.
    if (flush && !(await (this.ctx.sessions as unknown as SessionStore).flush(session)))
      throw new AppError('delivery-unconfirmed', '原生会话没有持久化确认。');
    const signal = AbortSignal.timeout(5000);
    if (typeof this.ctx.sessionPersistence.stat === 'function') {
      const snapshot = await this.ctx.sessionPersistence.stat(SessionId(session.id), { signal });
      if ((snapshot?.sizeBytes ?? 0) > 32 * 1024 * 1024 || (snapshot?.eventCount ?? 0) > 100000)
        throw new AppError(
          'delivery-unconfirmed',
          '会话日志超过自动核对上限，请人工核对；不会重复通知。',
        );
    }
    const handle = await this.ctx.sessionPersistence.open(SessionId(session.id), 'read', {
      signal,
    });
    let events: readonly SessionEvent[];
    try {
      if (handle.header && handle.header.id !== session.id)
        throw new AppError('delivery-unconfirmed', '持久会话身份不符。');
      events = (await handle.read(0, 100001, { signal })).events;
      if (events.length > 100000)
        throw new AppError('delivery-unconfirmed', '会话日志超过自动核对上限，请人工核对。');
      if (events.some((event, i) => event.seq !== i))
        throw new AppError('delivery-unconfirmed', '持久日志不是连续完整前缀。');
    } finally {
      await handle.close();
    }
    if (this.closed) return;
    this.authority(session.id, manager.id);
    const inputs = new Map<string, { turn: number; seq: number; messageId: string }[]>();
    const calls = new Map<string, number>();
    const finals = new Map<number, SessionEvent<'assistant/message'>>(),
      ends = new Map<number, SessionEvent<'turn/end'>>();
    let turn: number | undefined;
    const starts = new Set<number>(),
      invalid = new Set<number>();
    for (const event of events) {
      if (event.type === 'turn/start') {
        if (turn !== undefined) invalid.add(turn);
        if (starts.has(event.data.turn)) invalid.add(event.data.turn);
        starts.add(event.data.turn);
        turn = event.data.turn;
      }
      if (
        event.type === 'user/message' &&
        event.surfaceOp === 'append' &&
        turn !== undefined &&
        event.data.source.kind === 'super-bot-manager'
      ) {
        const source = event.data.source;
        if (source.botId === manager.botId && source.managerId === manager.id) {
          const key = `${source.eventId}:${event.data.id}`,
            matches = inputs.get(key) ?? [];
          matches.push({ turn, seq: event.seq, messageId: event.data.id });
          inputs.set(key, matches);
        }
      }
      if (
        event.type === 'tool/call' &&
        event.data.name === 'super_bot_manage' &&
        turn === event.data.turn
      )
        calls.set(event.data.callId, event.seq);
      if (event.type === 'assistant/message') {
        // Only the last, naturally stopped, visible model reply can be final. Tool chatter is not delivery.
        const data = event.data;
        if (turn === data.turn && finalAssistantText(event)) finals.set(data.turn, event);
        else finals.delete(data.turn);
      }
      if (event.type === 'turn/end') {
        if (turn === event.data.turn) ends.set(event.data.turn, event);
        else invalid.add(event.data.turn);
        turn = undefined;
      }
    }
    for (const id of invalid) {
      ends.delete(id);
      finals.delete(id);
    }
    const origin = this.webOrigin();
    for (const notification of notifications) {
      const payload = JSON.parse(notification.payload),
        matches = inputs.get(`${notification.id}:${payload.messageId}`) ?? [];
      if (matches.length > 1) {
        this.store.managerEventUnknown(notification.id);
        continue;
      }
      const input = matches[0],
        inputEnd = input ? ends.get(input.turn) : undefined;
      if (!payload.deliveryRetryExhausted && input && (!payload.deliveryOnly || inputEnd)) {
        this.store.managerEventEntered(notification.id, input.messageId, true);
      }
      let candidates: SessionEvent<'assistant/message'>[];
      let delivery: { result: Result; cwd: string } | undefined;
      if (payload.deliveryOnly) {
        const { task, result, binding } = this.store.taskDetail(notification.taskId!);
        if (
          task.botId !== manager.botId ||
          !result ||
          !binding ||
          result.id !== payload.resultId ||
          task.taskRevision !== payload.taskRevision ||
          !['review', 'completed'].includes(task.lifecycle)
        ) {
          this.store.supersedeManagerDelivery(notification.id);
          continue;
        }
        delivery = { result, cwd: binding.cwd };
        const callId = payload.reviewCallId ?? payload.deliverCallId;
        const callSession = payload.reviewSessionId ?? payload.deliverSessionId;
        // The native tool call or the bound notification input locates the first eligible reply.
        const after = (callSession === session.id ? calls.get(callId) : undefined) ?? input?.seq;
        candidates = [...finals.values()].filter((event) => {
          if (
            after === undefined ? callId || event.time < notification.createdAt : event.seq <= after
          )
            return false;
          const blocks = event.data.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text);
          const allowLegacy = !payload.exactResultLink;
          return hasDeliveryLink(
            blocks,
            origin,
            result.id,
            task.id,
            result.evidence.length,
            allowLegacy,
          );
        });
      } else {
        const final = input ? finals.get(input.turn) : undefined;
        candidates = input && final && final.seq > input.seq ? [final] : [];
      }
      const final = candidates.find((event) => {
        const end = ends.get(event.data.turn);
        return end?.data.reason.kind === 'completed' && end.seq > event.seq;
      });
      if (final) {
        if (delivery?.result.evidence.length) {
          try {
            await verifyEvidence(delivery.cwd, delivery.result.evidence);
          } catch (error) {
            if (this.closed) return;
            this.authority(session.id, manager.id);
            if (
              this.store.managerDeliveryUncertain(notification.id) ||
              notification.state === 'unknown'
            ) {
              const reason = error instanceof AppError ? error.message : '成果文件无法核对。';
              this.store.managerProblem(
                manager.botId,
                `原聊天已有成果链接，但当前文件无法按该版本打开。${reason}`,
                notification.id,
              );
            }
            continue;
          }
          if (this.closed) return;
          this.authority(session.id, manager.id);
        }
        const end = ends.get(final.data.turn)!;
        this.store.managerNotificationDelivered(notification.id, session.id, {
          turn: final.data.turn,
          messageId: final.data.message.id,
          seq: final.seq,
          endSeq: end.seq,
        });
      } else if (!payload.deliveryOnly) {
        this.store.managerEventUnknown(notification.id);
      } else if (payload.deliveryOnly && candidates.length) {
        // A persisted visible reply with a missing/error/repaired closer is ambiguous; do not blindly redeliver it.
        if (this.store.managerDeliveryUncertain(notification.id))
          this.store.managerProblem(
            manager.botId,
            '已有成果回复但原生轮次未确认结束，请打开管理对话核对；没有自动重复交付或执行。',
            notification.id,
          );
      } else if (payload.deliveryOnly && !payload.deliveryRetryExhausted) {
        if (input && inputEnd && inputEnd.seq > input.seq) {
          if (inputEnd.data.reason.kind === 'completed' || inputEnd.data.reason.kind === 'error')
            this.store.managerDeliveryAttemptEnded(notification.id, input.messageId, {
              sessionId: session.id,
              turn: input.turn,
              endSeq: inputEnd.seq,
            });
          else if (this.store.managerDeliveryUncertain(notification.id))
            this.store.managerProblem(
              manager.botId,
              '补交付轮次已被中断，请打开 Bot 对话核对；没有自动重复交付。',
              notification.id,
            );
        } else if (
          (input || notification.state === 'entered') &&
          this.store.managerDeliveryUncertain(notification.id)
        ) {
          this.store.managerProblem(
            manager.botId,
            '补交付输入已进入会话，但没有可确认的轮次结束记录；已停止自动唤醒，请打开 Bot 对话核对。',
            notification.id,
          );
        }
      }
    }
  }
  private restoreDeliveryScope(sessionId: string, eventId?: string, messageId?: string): void {
    const manager = this.store.managerForSession(sessionId);
    if (!manager) return;
    for (const event of this.store.managerNotifications(manager.botId)) {
      const payload = JSON.parse(event.payload);
      if (
        !payload.deliveryOnly ||
        !payload.messageJson ||
        (eventId && event.id !== eventId) ||
        (messageId && payload.messageId !== messageId)
      )
        continue;
      const message = JSON.parse(payload.messageJson) as UserMessage;
      if (message.source.kind === 'super-bot-manager' && message.source.managerId === manager.id) {
        this.scopes.get(sessionId)?.nativeTurn?.restrict();
        this.deliveryScopes.set(sessionId, { taskId: event.taskId!, resultId: payload.resultId });
      }
    }
  }
  private quarantineNotificationInputs(agent: Agent, onlyId?: string): void {
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      const source = message.source;
      if (
        source?.kind === 'super-bot-manager' &&
        (!onlyId || source.eventId === onlyId) &&
        this.store.quarantinedManagerInput(
          agent.id,
          source.eventId,
          message.id,
          source.botId,
          source.managerId,
        )
      )
        agent.inbox.remove(message.id);
    }
  }
  resolveNotification(
    requestId: string,
    botId: string,
    id: string,
    resolution: 'handled' | 'retry-unsent',
    acknowledged: unknown,
    source?: ChatSource,
  ): void {
    this.store.resolveManagerNotification(requestId, botId, id, resolution, acknowledged, source);
    // Explicit owner action: clean only already loaded Inbox items, without resolving/waking Agents or cancelling a driver.
    for (const agent of this.ctx.agents.list()) this.quarantineNotificationInputs(agent, id);
  }
  private attachScope(agent: Agent): void {
    if (this.closed) return;
    this.quarantineNotificationInputs(agent);
    if (this.store.isDeletedManagerSession(agent.id)) {
      for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
        if (message.source && isFeishuSource(message.source)) agent.inbox.remove(message.id);
      }
      return;
    }
    const attached = this.scopes.get(agent.id);
    if (attached?.agent === agent) return;
    if (attached) {
      attached.retire();
      this.scopes.delete(agent.id);
      this.userMessages.delete(agent.id);
      this.ownerSources.delete(agent.id);
      this.mixedOwnerTurns.delete(agent.id);
      this.turnStartSeqs.delete(agent.id);
      this.nativeTurns.delete(agent.id);
    }
    const manager = this.store.managerForSession(agent.id);
    if (!manager) return;
    this.retainOwnerInputs(agent);
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.source && isFeishuSource(message.source) && !this.feishuInputs.isPending(message))
        agent.inbox.remove(message.id);
    }
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      this.restoreDeliveryScope(agent.id);
      const restored = this.deliveryScopes.get(agent.id);
      void agent.whenIdle().then(
        () => {
          if (
            this.scopes.get(agent.id)?.agent === agent &&
            this.deliveryScopes.get(agent.id) === restored
          )
            this.deliveryScopes.delete(agent.id);
        },
        () => {},
      );
    }
    configureRole(this.ctx, agent, 'manager', this.options);
    const fullAccess = fullAccessEnabled(this.options);
    const allow = fullAccess ? [...MANAGER_NATIVE_TOOLS, 'super_bot_manage'] : ['super_bot_manage'];
    let retired = false;
    const nativeTurn =
      fullAccess && typeof this.ctx.agents.get === 'function'
        ? new ManagerNativeTurn(agent, () => {
            if (
              retired ||
              agent.status !== 'running' ||
              this.ctx.agents.get(agent.id) !== agent ||
              this.deliveryScopes.has(agent.id)
            )
              return false;
            try {
              const current = this.authority(agent.id, manager.id);
              return current.sessionId === agent.id && current.generation === manager.generation;
            } catch {
              return false;
            }
          })
        : undefined;
    // DSH resolves the model's tools before it admits input. The guard remains authoritative.
    const mask = nativeTurn ? undefined : agent.ctx.tools.restrict({ allow });
    const nativeHooks = nativeTurn
      ? [
          agent.ctx.on('agent/inbox/inserted', (payload) => {
            if (payload.agent === agent) nativeTurn.insert(payload.message);
          }),
          agent.ctx.on('agent/inbox/discarded', (payload) => {
            if (payload.agent === agent) nativeTurn.discard(payload.message);
          }),
          agent.ctx.on('agent/inbox/claimed', (payload) => {
            if (payload.agent === agent) nativeTurn.claim(payload.turn, payload.message);
          }),
          agent.ctx.on('system-prompt/assemble', (_assembly, context, next) => {
            if (context.scope === agent) nativeTurn.assemble(context.signal, context.toolSet);
            return next();
          }),
        ]
      : [];
    const dispatchGuard = agent.ctx.on('tools/execute', (exec, next) => {
      if (retired) throw new AppError('manager-tool-scope', '管理会话已失效，未执行宿主工具。');
      if (this.recoveryScopes.has(agent.id) && exec.name !== 'super_bot_manage') {
        throw new AppError('recovery-only', '恢复通知未授权原生工具。');
      }
      if (!allow.includes(exec.name) && !nativeTurn?.authorize(exec, 'dispatch')) {
        throw new AppError('manager-tool-scope', '本轮执行依据已失效，未执行该宿主工具。');
      }
      return next();
    });
    const guard = agent.ctx.tools.guard((exec) => {
      if (retired) return 'This Bot session no longer has management authority.';
      try {
        this.authority(agent.id);
      } catch {
        return 'This Bot session no longer has management authority.';
      }
      if (this.recoveryScopes.has(agent.id) && exec.name !== 'super_bot_manage')
        return 'Only the current task’s read-only recovery tools are authorized.';
      if (this.deliveryScopes.has(agent.id) && exec.name !== 'super_bot_manage')
        return 'Delivery-only recovery cannot execute native tools or modify work.';
      if (!allow.includes(exec.name) && !nativeTurn?.authorize(exec, 'prepare'))
        return fullAccess
          ? 'This tool is not available to the Bot in this turn. Use super_bot_manage to delegate multi-step work to a Worker.'
          : 'Bot Shell 与 Worker 完整权限未开启：当前 fullAccess: false。请在当前 profile 的 cordis.patch.yml 中将 Super Bot config.fullAccess 设为 true，空闲后重载插件；不要要求用户开启工具通道。';
      return managerNoWait(exec);
    });
    let turn = -1,
      steps = 0;
    const budget = agent.ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        const live = payload.agent === agent ? nativeTurn : undefined;
        const claimed = live ? payload.messages.slice() : [];
        live?.prepare(payload.turn, payload.signal);
        if (payload.turn !== turn) {
          turn = payload.turn;
          steps = 0;
        }
        if (++steps > (fullAccessEnabled(this.options) ? 24 : 12)) {
          const active = this.store.managerForSession(agent.id);
          if (active)
            this.store.managerProblem(active.botId, '单次管理轮次已达步数上限，请检查账本后继续。');
          throw new AppError('manager-budget', '单次管理轮次已达步数上限，请检查账本后继续。');
        }
        const decision = await next();
        if (decision.kind === 'reject') return decision;
        const verified = new Set<string>();
        for (const message of decision.messages) {
          if (!isFeishuSource(message.source)) continue;
          if (
            verified.has(message.id) ||
            !this.feishuInputs.authorize(agent.id, payload.turn, message)
          )
            return { kind: 'reject' };
          verified.add(message.id);
        }
        live?.propose(payload, payload.signal, claimed, decision.messages.slice());
        return decision;
      },
      { prepend: !!nativeTurn },
    );
    const prompt = agent.ctx.systemPrompt.section({
      name: 'super-bot-manager',
      order: 9000,
      interpolate: false,
      text: () => {
        const active = this.store.managerForSession(agent.id);
        if (!active)
          return 'This is an archived manager session. Open the current manager from Super Bot.';
        const bot = this.store.getBot(active.botId);
        return managerPrompt(
          bot,
          this.store.currentBotContext(bot.id).materials,
          fullAccess,
          this.policy,
        );
      },
    });
    const retire = () => {
      retired = true;
      nativeTurn?.closeTurn();
    };
    let released = false;
    this.scopes.set(agent.id, {
      agent,
      nativeTurn,
      retire,
      release: () => {
        if (released) return;
        released = true;
        retire();
        for (const dispose of nativeHooks) dispose();
        dispatchGuard();
        budget();
        prompt();
        guard();
        mask?.();
      },
    });
  }
  async prepare(requestId: string, botId: string): Promise<ManagerBinding> {
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const bot = this.store.getBot(botId),
      receipt = this.store.managerPreparationReceipt(requestId, botId);
    if (receipt && (receipt.state === 'ready' || receipt.state === 'released')) return receipt;
    const cwd = receipt?.cwd ?? join(this.dataDir, 'managers', bot.id);
    await mkdir(cwd, { recursive: true });
    const canonical = receipt?.cwd ?? (await realpath(cwd));
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const manager = receipt ?? this.store.beginManager(requestId, botId, canonical);
    const current = this.store.getManager(manager.id);
    if (current.state === 'ready' || current.state === 'released') {
      if (
        current.state === 'ready' &&
        current.sessionId &&
        (this.options.managerModel || fullAccessEnabled(this.options))
      ) {
        const resolved = await this.ctx.sessionController.resolveAgent(
          SessionId(current.sessionId),
        );
        const latest = this.store.getManager(current.id);
        if (latest.state === 'ready' && 'agent' in resolved && resolved.agent.status === 'idle')
          configureRole(this.ctx, resolved.agent, 'manager', this.options);
        return latest;
      }
      return current;
    }
    const active = this.creating.get(manager.id);
    if (active) return active;
    const promise = (async () => {
      try {
        let sessionId: string;
        if (this.store.get(`native-create-mismatch:${manager.id}`))
          throw new AppError(
            'manager-recovery',
            '宿主已返回不同会话，保留待人工核对，不能自动关联原请求 ID。',
          );
        if (!this.store.claimManagerCreation(manager.id)) {
          const resolved = await this.ctx.sessionController.resolveAgent(
            SessionId(manager.requestedSessionId),
          );
          if ('error' in resolved || resolved.agent.session.header.cwd !== manager.cwd)
            throw new AppError('manager-recovery', '管理会话创建结果待核对，没有重复创建。');
          sessionId = manager.requestedSessionId;
        } else {
          const workspace = await this.ctx.workspaceRegistry.create(manager.cwd, bot.name);
          if (this.store.getManager(manager.id).state === 'released')
            return this.store.getManager(manager.id);
          const created = await this.ctx.sessionController.create({
            workspaceId: workspace.id,
            sessionId: SessionId(manager.requestedSessionId),
          });
          sessionId = created.sessionId;
        }
        if (this.store.getManager(manager.id).state === 'released')
          return this.store.getManager(manager.id);
        if (sessionId !== manager.requestedSessionId) {
          this.store.set(`native-create-mismatch:${manager.id}`, sessionId);
          throw new AppError('manager-recovery', '宿主返回了不同会话，尚未命名或关联。');
        }
        const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
        if (
          'error' in resolved ||
          resolved.agent.session.id !== sessionId ||
          resolved.agent.session.header.origin === 'subagent' ||
          resolved.agent.session.header.isSeeded ||
          resolved.agent.session.header.cwd !== manager.cwd
        )
          throw new AppError('manager-recovery', '管理会话归属待核对，尚未命名或关联 Workspace。');
        if (this.store.getManager(manager.id).state === 'released')
          return this.store.getManager(manager.id);
        const workspace = await this.ctx.workspaceRegistry.create(manager.cwd, bot.name);
        if (this.store.getManager(manager.id).state === 'released')
          return this.store.getManager(manager.id);
        await workspace.attachSession(SessionId(sessionId));
        if (this.store.getManager(manager.id).state === 'released')
          return this.store.getManager(manager.id);
        await nameAutomaticSession(this.ctx, resolved.agent.session, bot.name);
        if (this.store.getManager(manager.id).state === 'released')
          return this.store.getManager(manager.id);
        return this.store.confirmManager(manager.id, sessionId);
      } finally {
        this.creating.delete(manager.id);
      }
    })();
    this.creating.set(manager.id, promise);
    return promise;
  }
  private writeBot(
    requestId: string,
    action: 'bot.create' | 'bot.update',
    payload: unknown,
    operation: () => Promise<Bot>,
  ): Promise<Bot> {
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const receipt = this.store.commandReceipt<Bot>(requestId, action, payload);
    if (receipt) return Promise.resolve(this.store.getBot(receipt.id));
    const serialized = JSON.stringify({ action, payload }),
      active = this.botWrites.get(requestId);
    if (active) {
      if (active.payload !== serialized)
        throw new AppError('idempotency-conflict', '同一请求标识不能用于不同的内容。');
      return active.promise;
    }
    const promise = operation().finally(() => this.botWrites.delete(requestId));
    this.botWrites.set(requestId, { payload: serialized, promise });
    return promise;
  }
  async createBot(requestId: string, input: NewBot): Promise<Bot> {
    const draft = botDraft(input);
    const bot = await this.writeBot(requestId, 'bot.create', draft, async () => {
      const materials = await readMaterials(draft.referencePaths);
      if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出，未保存配置。');
      return this.store.createBot(requestId, draft, materials);
    });
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    // This also finishes initialization on a retry after the ledger committed the Bot.
    this.store.memory?.index(bot.id);
    return bot;
  }
  updateBot(
    requestId: string,
    botId: string,
    expectedRevision: number,
    input: NewBot,
  ): Promise<Bot> {
    const draft = botDraft(input),
      payload = { botId, expectedRevision, ...draft };
    return this.writeBot(requestId, 'bot.update', payload, async () => {
      const before = this.store.activeManager(botId);
      let agent: Agent | undefined;
      const quiet = () => {
        if (
          agent &&
          (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
        )
          throw new AppError(
            'manager-busy',
            '管理会话正在工作，请等待结束或在原生会话停止后再修改配置。',
          );
      };
      if (before) {
        if (before.state !== 'ready' || !before.sessionId)
          throw new AppError('manager-unavailable', '旧管理会话尚未准备好，请先核对会话。');
        const resolved = await this.ctx.sessionController.resolveAgent(SessionId(before.sessionId));
        if ('error' in resolved)
          throw new AppError('manager-unavailable', '旧管理会话暂不可用，尚未修改配置。');
        agent = resolved.agent;
        quiet();
      }
      const materials = await readMaterials(draft.referencePaths);
      if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出，未保存配置。');
      if (this.store.activeManager(botId)?.id !== before?.id)
        throw new AppError('version-conflict', '管理会话已经改变，请重新检查配置。');
      quiet();
      const updated = this.store.updateBot(requestId, botId, expectedRevision, draft, materials);
      if (before?.sessionId && this.store.activeManager(botId)?.id !== before.id)
        this.scopes.get(before.sessionId)?.nativeTurn?.restrict();
      return updated;
    });
  }
  deleteBot(
    requestId: string,
    botId: string,
    expectedRevision: number,
    force: boolean,
    authorize: (replay?: BotDeletionReceipt) => void,
  ): BotDeletionReceipt {
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const payload = { botId, expectedRevision, force };
    const replay = this.store.commandReceipt<BotDeletionReceipt>(requestId, 'bot.delete', payload);
    authorize(replay);
    if (replay) return replay;
    this.store.assertBotDeletable(botId, expectedRevision, force);
    const manager = this.store.activeManager(botId);
    if (!force && manager) {
      const sessionId = manager.sessionId;
      if (manager.state !== 'ready' || !sessionId) this.deleteBusy();
      // Resolving an unloaded Agent can wake its Inbox. Only inspect live host state here.
      const agent = this.ctx.agents.get(SessionId(sessionId));
      if (
        (agent &&
          (agent.status !== 'idle' ||
            agent.inbox.nextTurn.length ||
            agent.inbox.nextStep.length)) ||
        this.waking.has(botId) ||
        this.finishing.has(sessionId) ||
        this.activeManagerJobs(SessionId(sessionId)).length
      )
        this.deleteBusy();
    }
    const receipt = this.store.deleteBot(requestId, botId, expectedRevision, force);
    if (receipt.managerSessionId) {
      try {
        this.retireDeletedManager(receipt.managerSessionId, force);
      } catch {
        this.ctx.logger.warn('[super-bot] 已撤销 Bot 管理权限，原生会话或后台工作停止请求待核对。');
      }
    }
    this.retryAfter.delete(botId);
    return receipt;
  }
  private deleteBusy(): never {
    throw new AppError('manager-busy', '管理会话仍在工作或待核对，请先等待结束，或使用强制删除。');
  }
  private activeManagerJobs(sessionId: ReturnType<typeof SessionId>) {
    return this.ctx.jobs
      .list(sessionId)
      .filter((job) => job.owner === sessionId && ['running', 'stopping'].includes(job.status));
  }
  private retireDeletedManager(sessionId: string, force: boolean): void {
    const scope = this.scopes.get(sessionId);
    if (scope) {
      scope.retire();
      this.quarantineNotificationInputs(scope.agent);
      for (const message of [...scope.agent.inbox.nextTurn, ...scope.agent.inbox.nextStep]) {
        if (message.source && isFeishuSource(message.source)) scope.agent.inbox.remove(message.id);
      }
      const release = () => {
        if (this.scopes.get(sessionId) !== scope) return;
        scope.release();
        this.scopes.delete(sessionId);
      };
      // Cancellation requests and idle status do not prove that old tool calls have stopped.
      void scope.agent.whenIdle().then(release, () => {});
      if (force) scope.agent.cancel({ kind: 'user' }, { keepInbox: true });
    }
    if (force) {
      const id = SessionId(sessionId);
      for (const job of this.activeManagerJobs(id))
        this.ctx.jobs.kill(job.id, id, 'Super Bot deleted');
    }
    this.userMessages.delete(sessionId);
    this.ownerSources.delete(sessionId);
    this.mixedOwnerTurns.delete(sessionId);
    this.turnStartSeqs.delete(sessionId);
    this.retainedOwnerInputs.delete(sessionId);
    this.nativeTurns.delete(sessionId);
    this.deliveryScopes.delete(sessionId);
    this.recoveryScopes.delete(sessionId);
  }
  async replace(
    requestId: string,
    botId: string,
    expectedGeneration: number,
  ): Promise<ManagerBinding> {
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const receipt = this.store.commandReceipt<ManagerBinding>(requestId, 'manager.replace', {
      botId,
      expectedGeneration,
    });
    if (receipt) {
      // Resume only this replacement's preparation. A completed retry must not touch another generation or model choice.
      const prepared = this.store.managerPreparationReceipt(`${requestId}:new`, botId);
      if (
        !prepared &&
        (this.store.getBot(botId).configRevision !== receipt.configRevision ||
          this.store.activeManager(botId))
      )
        throw new AppError(
          'manager-stale',
          '原更换请求已释放旧会话，之后配置或管理会话已经改变；没有再次更换。',
        );
      return this.prepare(`${requestId}:new`, botId);
    }
    const manager = this.store.activeManager(botId);
    if (!manager?.sessionId) throw new AppError('manager-missing', '当前管理会话尚未准备好。');
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(manager.sessionId));
    if ('error' in resolved)
      throw new AppError('manager-unavailable', '无法核对旧管理会话，尚未更换。');
    const agent = resolved.agent;
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
      throw new AppError('manager-busy', '管理会话正在工作，请等待结束或在原生会话停止后再更换。');
    if (this.closed) throw new AppError('manager-unavailable', '管理器正在退出。');
    const model = selectedModel(this.ctx, agent);
    this.store.releaseManager(requestId, botId, expectedGeneration);
    this.scopes.get(agent.id)?.nativeTurn?.restrict();
    const next = await this.prepare(`${requestId}:new`, botId);
    if (model && next.sessionId && next.state === 'ready') {
      const created = await this.ctx.sessionController.resolveAgent(SessionId(next.sessionId));
      const current = this.store.activeManager(botId);
      if (
        !this.closed &&
        current?.id === next.id &&
        current.state === 'ready' &&
        current.configRevision === manager.configRevision &&
        'agent' in created &&
        !selectedModel(this.ctx, created.agent)
      )
        created.agent.model.select(model);
    }
    return this.store.getManager(next.id);
  }
  private pumping = false;
  private retryAfter = new Map<string, number>();
  private continuationAttempts = new Map<
    string,
    { rowVersion: number; managerSessionId: string; waitingForCapacity: boolean; retryAt?: number }
  >();
  private nativeTurns = new Map<string, number>();
  private notificationTurns = new Map<
    string,
    { turn: number; messageId: string; eventId: string }
  >();
  private lateJobNotice(event: ManagerEvent) {
    const match = event.id.match(
      /^manager-event:late-job-(waiting|ready|blocked|continued):([a-f0-9-]{36})$/,
    );
    if (event.taskId && match) return { state: match[1]!, runId: match[2]! };
  }
  private recoveryNoticeRun(event: ManagerEvent): string | undefined {
    if (!event.taskId) return;
    const match = /^manager-event:(recovery|settled):([a-f0-9-]{36})$/.exec(event.id);
    if (!match) return;
    const [, kind, runId] = match;
    if (
      kind === 'recovery' ||
      ['blocked', 'failed'].includes(this.store.finalReport(runId!)?.kind ?? '')
    )
      return runId;
  }
  private isRecoveryNotice(event: ManagerEvent): boolean {
    return (
      !!event.taskId &&
      (!!this.recoveryNoticeRun(event) ||
        event.id.startsWith('manager-event:continuation:') ||
        (event.id.startsWith('manager-event:capacity:') &&
          !!this.pendingRecoveryInstruction(event.taskId)))
    );
  }
  private pendingRecoveryInstruction(taskId: string) {
    const instruction = this.store.recoveryInstruction(taskId);
    if (
      instruction &&
      instruction.mode &&
      !instruction.runId &&
      !instruction.stageRunId &&
      instruction.taskRevision === this.store.getTask(taskId).taskRevision &&
      instruction.priorRunId === this.store.latestRun(taskId)?.id
    )
      return instruction;
  }
  private currentInstructionSources(instruction: RecoveryInstruction, botId: string): boolean {
    return (
      this.feishuInputs.hasCurrentSource(instruction.source, botId) &&
      (instruction.directions ?? []).every((direction) =>
        this.feishuInputs.hasCurrentSource(direction.source, botId),
      )
    );
  }
  private async dispatchSavedContinuation(
    botId: string,
    manager: ManagerBinding,
  ): Promise<boolean> {
    const sessionId = manager.sessionId;
    if (!sessionId) return false;
    for (const { id, rowVersion } of this.store.pendingWorkerContinuations(botId, sessionId)) {
      if (!this.execution.canWakeRecoveryContinuation(id)) {
        this.continuationAttempts.delete(id);
        continue;
      }
      const attempt = this.continuationAttempts.get(id);
      if (
        attempt?.rowVersion === rowVersion &&
        attempt.managerSessionId === sessionId &&
        (!attempt.waitingForCapacity || this.store.dispatchBlocker(id)) &&
        (attempt.retryAt === undefined || attempt.retryAt > Date.now())
      )
        continue;
      const instruction = this.store.recoveryInstruction(id);
      if (!instruction || !this.currentInstructionSources(instruction, botId)) continue;
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
      if ('error' in resolved)
        throw new AppError('manager-unavailable', '管理会话暂不可用，已保存的指示仍待执行。');
      const agent = resolved.agent;
      const idle = () =>
        agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length;
      if (this.closed || !idle()) return false;
      const check = () => {
        this.authority(agent.id, manager.id);
        if (this.closed || !idle())
          throw new AppError('manager-busy', 'Bot 正在处理更新的消息，已保存指示等待接续。');
        const task = this.store.getTask(id);
        if (
          task.controlMode !== 'auto' ||
          task.lifecycle !== 'open' ||
          this.pendingRecoveryInstruction(id)?.id !== instruction.id ||
          !this.currentInstructionSources(instruction, botId)
        )
          throw new AppError('recovery-scope', '原后续指示或授权已经改变。');
      };
      const outcome = await this.execution.continueRecovery(
        id,
        rowVersion,
        manager.id,
        check,
        agent,
      );
      if (outcome.status === 'started' || outcome.status === 'already-started') {
        this.continuationAttempts.delete(id);
        for (const suffix of ['', ':settled', ':restart'])
          this.store.settleManagerEvent(`manager-event:continuation:${instruction.id}${suffix}`);
        return true;
      }
      this.continuationAttempts.set(id, {
        rowVersion,
        managerSessionId: sessionId,
        waitingForCapacity: outcome.code === 'capacity',
        retryAt:
          outcome.code === 'session-unavailable' ? Date.now() + WORKER_SESSION_RETRY_MS : undefined,
      });
      if (
        outcome.status === 'blocked' &&
        outcome.code !== 'session-unavailable' &&
        this.store.getTask(id).rowVersion === rowVersion
      )
        this.store.enqueueManager(
          botId,
          `continuation-blocked:${instruction.id}`,
          outcome.message,
          id,
        );
      return false;
    }
    return false;
  }
  private nextManagerEvent(botId: string): ManagerEvent | undefined {
    return this.store.nextManagerEvent(botId, (event) => {
      const late = this.lateJobNotice(event);
      if (late?.state === 'ready' && this.store.lateJobTarget(late.runId))
        return this.store.lateJobCanDispatch(late.runId);
      if (event.id.startsWith('manager-event:continuation:')) return false;
      return !(
        event.taskId &&
        event.id.startsWith('manager-event:capacity:') &&
        this.pendingRecoveryInstruction(event.taskId)
      );
    });
  }
  private staleRecoveryNotice(event: ManagerEvent): boolean {
    if (!event.taskId) return false;
    const late = this.lateJobNotice(event);
    if (late) {
      const saved = this.store.lateJobRecovery(late.runId),
        current = this.store.latestRun(event.taskId);
      if (saved?.state === 'continued' && late.state === 'continued')
        return current?.id !== saved.nextRunId || current.finishedAt !== null;
      return (
        !saved ||
        current?.id !== late.runId ||
        saved.state !== late.state ||
        this.store.getTask(event.taskId).rowVersion !== saved.rowVersion ||
        !!this.store.taskClose(event.taskId)
      );
    }
    const runId = this.recoveryNoticeRun(event);
    if (runId) return this.store.latestRun(event.taskId)?.id !== runId;
    if (event.id.startsWith('manager-event:continuation-blocked:')) {
      const instruction = this.pendingRecoveryInstruction(event.taskId);
      return (
        !instruction ||
        event.id !== `manager-event:continuation-blocked:${instruction.id}` ||
        !this.currentInstructionSources(instruction, this.store.getTask(event.taskId).botId)
      );
    }
    return false;
  }
  private recoveryNoticeInstructions(event: ManagerEvent): string {
    const instruction = this.pendingRecoveryInstruction(event.taskId!);
    if (instruction) {
      return [
        `This task already has a saved owner follow-up.`,
        `The host schedules it directly from the ledger as soon as the work can proceed.`,
        `Read detail and report its actual state without retrying or dispatching it from this notice.`,
        `Do not ask the user to repeat their instruction or authorize the task again.`,
        `Finish without any action if this notice was already handled.`,
      ].join(' ');
    }
    return [
      `Call inspect-recovery for this exact task before reporting a blocker.`,
      `If eligible, call recover-preflight with the returned rowVersion.`,
      `That performs the known authorized read-only next step.`,
      `Use the observed outcome and prior receipts as evidence, and keep credentials private.`,
      `Report any actual missing dependency, permission or uncertainty.`,
      `State when the prior attempt already ended.`,
      `A successful check covers the measured condition.`,
      `Do not dispatch the original task or claim that it passed.`,
      `Ask here only for a specific necessary human decision.`,
      `Finish quietly when the check was already handled or the blocker is unchanged.`,
    ].join(' ');
  }
  private workerQuestionEvent(eventId?: string): string | undefined {
    const runId = eventId?.match(/^manager-event:settled:([a-f0-9-]{36})$/)?.[1];
    return runId && this.store.finalReport(runId)?.kind === 'waiting' ? `run:${runId}` : undefined;
  }
  private questionNotice(botId: string, event: ManagerEvent): string {
    const attentionId = this.workerQuestionEvent(event.id);
    if (!attentionId || !event.taskId) return '';
    const detail = this.store.taskDetail(event.taskId);
    const question =
      detail.task.botId === botId
        ? detail.pendingQuestions.find((item) => item.id === attentionId)
        : undefined;
    if (!question)
      return '\n原 Worker 问题已回答或失效。不要再次提出这个问题，也不要用另一个问题替代它。';
    const link = questionLink(question, this.webOrigin());
    return `\nWorker 问题 ${question.id}（目标版本 ${question.taskRevision}）。先读 detail 确认同一问题仍可回答；若已失效，不要询问或替换成其他问题。${QUESTION_REPLY}\n${link.markdown}`;
  }
  private deliveryNotice(taskId: string, resultId: string, draft: unknown): string {
    const { task, result } = this.store.taskDetail(taskId);
    if (!result || result.id !== resultId || !['review', 'completed'].includes(task.lifecycle))
      return 'This result changed. Finish without delivering it.';
    const resultLink = deliveryResultLink(
      workUrl({ kind: 'result', taskId, resultId }),
      this.webOrigin(),
    );
    const savedText =
      typeof draft === 'string' ? `\nRegistered delivery draft (use as context): ${draft}` : '';
    return `Finish the handoff here with a short outcome and this one exact result link. Copy the link verbatim into your final visible reply. Use detail for facts if needed. Use detail.progress.reload for any code load claim. There is no need to call deliver again.${savedText}\n${resultLink}`;
  }
  private endedInputs = new Map<string, string>();
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private monitorWake(botId: string, eventId: string, agent: Agent, message: UserMessage): void {
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        if (
          this.closed ||
          this.store.isBotDeleted(botId) ||
          this.endedInputs.get(agent.id) === message.id
        )
          return;
        timedOut = true;
        agent.inbox.remove(message.id);
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        if (!this.closed)
          this.store.managerProblem(
            botId,
            `自动管理达到 ${runtimeLimits(this.options).managerTurnMinutes} 分钟上限，已请求停止；请检查最新账本。`,
          );
      },
      runtimeLimits(this.options).managerTurnMinutes * 60 * 1000,
    );
    timeout.unref();
    this.wakeTimers.set(message.id, timeout);
    const done = agent
      .whenIdle()
      .catch(() => {
        if (!this.closed)
          this.store.managerProblem(botId, '自动管理未正常结束，请打开管理会话核对。');
      })
      .finally(async () => {
        await this.finishing.get(agent.id);
        clearTimeout(timeout);
        this.wakeTimers.delete(message.id);
        if (!this.closed) {
          this.store.managerEventUnknown(eventId);
          if (timedOut)
            this.store.managerProblem(
              botId,
              `自动管理达到 ${runtimeLimits(this.options).managerTurnMinutes} 分钟上限，本轮已结束、管理会话已空闲。可打开管理对话检查账本后继续。`,
            );
        }
        this.deliveryScopes.delete(agent.id);
        if (this.recoveryScopes.get(agent.id)?.messageId === message.id)
          this.recoveryScopes.delete(agent.id);
        this.waking.delete(botId);
      });
    this.waking.set(botId, done);
  }
  private async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    const leave = this.reloadAdmission.tryEnter('Manager automatic notification preflight');
    if (!leave) return;
    this.pumping = true;
    try {
      for (const bot of this.store.managerOrder()) {
        let retryEventId: string | undefined, problemEventId: string | undefined;
        if (this.closed) break;
        if ((this.retryAfter.get(bot.id) ?? 0) > Date.now()) continue;
        try {
          const manager = this.store.activeManager(bot.id);
          if (
            !manager?.sessionId ||
            manager.state !== 'ready' ||
            bot.managerSessionId !== manager.sessionId ||
            bot.configRevision !== manager.configRevision ||
            this.waking.has(bot.id)
          )
            continue;
          if (await this.dispatchSavedContinuation(bot.id, manager)) continue;
          const recover = this.store.claimManagerReconciliation(bot.id);
          if (recover.length) {
            problemEventId = recover[0]!.id;
            await this.reconcileDelivery(
              { id: SessionId(manager.sessionId) } as Session,
              false,
              recover,
            );
            if (this.closed) break;
            this.authority(manager.sessionId, manager.id);
          }
          let event = this.nextManagerEvent(bot.id);
          if (!event) continue;
          if (this.staleRecoveryNotice(event)) {
            this.store.settleManagerEvent(event.id);
            continue;
          }
          const wakeFull = () =>
            this.waking.size >= runtimeLimits(this.options).managerConcurrentWakes;
          if (
            wakeFull() &&
            !event.id.startsWith('manager-event:stage-ready:') &&
            this.lateJobNotice(event)?.state !== 'ready' &&
            !JSON.parse(event.payload).deliveryOnly
          )
            continue;
          retryEventId = problemEventId = event.id;
          const resolved = await this.ctx.sessionController.resolveAgent(
            SessionId(manager.sessionId),
          );
          if (this.closed) break;
          if ('error' in resolved)
            throw new AppError('manager-unavailable', '管理会话暂不可用；请打开管理会话核对。');
          const agent = resolved.agent;
          this.attachScope(agent);
          this.authority(agent.id, manager.id);
          // Resource and task state can change while resolving the native Agent or reading receipts.
          event = this.nextManagerEvent(bot.id);
          if (!event) continue;
          if (this.staleRecoveryNotice(event)) {
            this.store.settleManagerEvent(event.id);
            continue;
          }
          retryEventId = problemEventId = event.id;
          if (
            agent.status !== 'idle' ||
            agent.inbox.nextTurn.length ||
            agent.inbox.nextStep.length
          ) {
            this.store.deferManagerEvent(
              event.id,
              '管理会话忙碌，通知等待空闲。',
              Date.now() + 30000,
            );
            continue;
          }
          const late = this.lateJobNotice(event);
          if (late?.state === 'ready') {
            const check = () => {
              this.authority(agent.id, manager.id);
              if (
                this.closed ||
                agent.status !== 'idle' ||
                agent.inbox.nextTurn.length ||
                agent.inbox.nextStep.length
              ) {
                throw new AppError('manager-busy', 'Bot 正在处理更新的消息，后台接续等待核对。');
              }
              const instruction = this.store.lateJobTarget(late.runId)?.instruction;
              if (instruction && !this.currentInstructionSources(instruction, bot.id)) {
                throw new AppError(
                  'late-job-unproven',
                  '补充指示所在原群或用户身份已变更，请在当前聊天确认报告内容。',
                );
              }
            };
            await this.execution.continueLateJob(late.runId, agent, check);
            continue;
          }
          if (event.taskId && event.id.startsWith('manager-event:stage-ready:')) {
            const { task, stage } = this.store.taskDetail(event.taskId);
            if (
              stage?.state !== 'ready' ||
              task.status !== 'unscheduled' ||
              event.id !== `manager-event:${stageReadyKey(stage)}`
            )
              continue;
            const check = () => {
              this.authority(agent.id, manager.id);
              if (
                this.closed ||
                agent.status !== 'idle' ||
                agent.inbox.nextTurn.length ||
                agent.inbox.nextStep.length
              ) {
                throw new AppError('stage-scope', 'Bot 正在处理更新的消息，阶段接续等待核对。');
              }
            };
            const outcome = await this.runPrepared(
              `stage-dispatch:${stage.runId}:${task.rowVersion}`,
              task,
              agent,
              check,
            );
            if ('run' in outcome) this.store.managerProblem(bot.id, '');
            continue;
          }
          if (JSON.parse(event.payload).deliveryOnly) {
            const checkedId = event.id;
            await this.reconcileDelivery(agent.session, true, [event]);
            if (this.closed) break;
            this.authority(agent.id, manager.id);
            if (
              agent.status !== 'idle' ||
              agent.inbox.nextTurn.length ||
              agent.inbox.nextStep.length
            )
              continue;
            event = this.nextManagerEvent(bot.id);
            if (!event) continue;
            // A different delivery receives its own receipt check on the next pump.
            if (event.id !== checkedId && JSON.parse(event.payload).deliveryOnly) continue;
            retryEventId = problemEventId = event.id;
          }
          if (wakeFull()) continue;
          const wakeLimit = runtimeLimits(this.options).managerWakesPerHour;
          if (this.store.managerWakeCount(bot.id, Date.now() - 60 * 60 * 1000) >= wakeLimit) {
            // Deduplicated by message: recorded once until a later successful wake clears it.
            if (event)
              this.store.deferManagerEvent(
                event.id,
                '每小时自动唤醒上限，等待窗口自然重置。',
                this.store.managerWakeAvailableAt(bot.id),
              );
            const delivery = JSON.parse(event.payload).deliveryOnly;
            this.store.managerProblem(
              bot.id,
              `最近一小时自动唤醒已达 ${wakeLimit} 次上限，通知已保留、暂停自动唤醒；可打开 Bot 对话处理，或调整 managerWakesPerHour。`,
              delivery ? event.id : undefined,
            );
            continue;
          }
          if (!(selectedModel(this.ctx, agent) ?? agent.model?.current?.())) {
            if (event)
              this.store.deferManagerEvent(
                event.id,
                '尚未配置模型，通知保留。',
                Date.now() + 30000,
              );
            this.store.managerProblem(
              bot.id,
              '当前没有可用的管理模型。任务通知已保留，配置恢复后会继续。',
            );
            continue;
          }
          const payload = JSON.parse(event.payload);
          const instructions =
            payload.deliveryOnly && event.taskId
              ? this.deliveryNotice(event.taskId, payload.resultId, payload.deliveryText)
              : this.lateJobNotice(event)
                ? 'Read detail for this exact task. Briefly report the newest Job recovery fact and who takes the next step. Clearly distinguish the ended old attempt, a pending or entered Worker continuation, and actual report delivery. The host handles safe continuation. Ask for help only if detail identifies a specific missing fact or permission.'
                : event.id.startsWith('manager-event:continuation-blocked:')
                  ? 'Read detail for this exact task. Briefly report the recorded blocker and whether the saved direction is still pending. The host schedules the Worker when conditions change. Ask only for a specific fact, decision, or permission that the host cannot obtain.'
                  : this.isRecoveryNotice(event)
                    ? this.recoveryNoticeInstructions(event)
                    : event.id.startsWith('manager-event:gitlab-release:')
                      ? 'Read detail for this exact task and report gitLabRelease.detail and its exact job link in your reply. Use current observed status. Do not dispatch, retry or poll this job.'
                      : /^manager-event:stage-(settled|blocked|unavailable):/.test(event.id)
                        ? `Read detail for this exact task. Preserve its original owner scope. ${STAGE_GUIDANCE} ${GITLAB_RELEASE_GUIDANCE} Briefly state actual progress and current next action when information changed. Report a blocked condition without attempting to bypass it.`
                        : `Read current ledger state. Do not assume the event is still current. Do not manufacture new tasks. If a new result is ready, follow the delivery instructions and put its single exact result link in the final reply. For a pending Worker question, follow detail's questionReplyInstruction. Keep pre-creation clarification conversational. Do not repeat stale notices. Finish after useful bounded work; do not poll.${this.questionNotice(bot.id, event)}`;
          const message = createUserMessage({
            source: {
              kind: 'super-bot-manager',
              botId: bot.id,
              managerId: manager.id,
              eventId: event.id,
            },
            content: [
              {
                type: 'text',
                text: `Important task event: ${payload.reason}\nTask: ${event.taskId ?? 'all current work'}\n${instructions}`,
              },
            ],
          });
          if (!this.store.claimManagerEvent(event.id, message.id, JSON.stringify(message)))
            continue;
          retryEventId = undefined;
          if (payload.deliveryOnly) {
            this.scopes.get(agent.id)?.nativeTurn?.restrict();
            this.deliveryScopes.set(agent.id, {
              taskId: event.taskId!,
              resultId: payload.resultId,
            });
          } else if (event.taskId && this.isRecoveryNotice(event)) {
            this.scopes.get(agent.id)?.nativeTurn?.restrict();
            this.recoveryScopes.set(agent.id, { taskId: event.taskId, messageId: message.id });
          } else if (
            this.lateJobNotice(event) ||
            event.id.startsWith('manager-event:continuation-blocked:') ||
            event.id.startsWith('manager-event:gitlab-release:') ||
            /^manager-event:stage-(settled|blocked|unavailable):/.test(event.id)
          ) {
            this.scopes.get(agent.id)?.nativeTurn?.restrict();
          }
          this.store.managerProblem(bot.id, '');
          this.retryAfter.delete(bot.id);
          try {
            agent.followup(message);
          } catch {
            this.store.managerEventUnknown(event.id);
            agent.inbox.remove(message.id);
            agent.cancel({ kind: 'user' }, { keepInbox: true });
            this.monitorWake(bot.id, event.id, agent, message);
            throw new AppError(
              'manager-delivery',
              '管理通知回执未确认，已请求停止且不会重发该通知。请读取最新账本核对。',
            );
          }
          this.monitorWake(bot.id, event.id, agent, message);
        } catch (error) {
          if (!this.closed && !this.store.isBotDeleted(bot.id)) {
            this.store.managerProblem(
              bot.id,
              error instanceof AppError ? error.message : '自动管理暂不可用，请打开管理会话核对。',
              problemEventId,
            );
            if (retryEventId)
              this.store.deferManagerEvent(
                retryEventId,
                error instanceof AppError ? error.message : '管理会话暂不可用。',
                Date.now() + 30000,
                true,
              );
            this.retryAfter.set(bot.id, Date.now() + 30000);
          }
        }
      }
    } catch {
      /* A ledger read failure cannot justify delivering any notification. */
    } finally {
      this.pumping = false;
      leave();
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const scope of this.scopes.values()) scope.retire();
    await Promise.allSettled([...this.botWrites.values()].map((write) => write.promise));
    for (const { agent } of this.scopes.values())
      if (agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true });
    await Promise.allSettled([...this.scopes.values()].map(({ agent }) => agent.whenIdle()));
    await Promise.allSettled([...this.finishing.values()]);
    for (const scope of this.scopes.values()) scope.release();
    this.scopes.clear();
    this.recoveryScopes.clear();
    this.deliveryScopes.clear();
    this.finishing.clear();
  }
}
