import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GROUP_EVIDENCE_KEY_PREFIX } from './feishu-group-evidence.ts';
import { AppError, requiredText } from './model.ts';
import type { Store } from './store.ts';
import { isFeishuChatId, type FeishuBinding, type FeishuIdentity, type FeishuGroup, type FeishuGroupPreview,
  type FeishuTransport } from './feishu-types.ts';
export type { FeishuBinding } from './feishu-types.ts';

const PREVIEW_LIFETIME_MS = 5 * 60 * 1000;
// Leave a margin within Feishu's create-chat deduplication window.
const CREATE_RETRY_WINDOW_MS = 60 * 60 * 1000;
const CREATED_GROUP_CHECK_DELAYS_MS = [0, 250, 750, 1500];
const BINDING_FIELDS = 'id, botId, chatId, name, boundAt';
const CREATION_FIELDS = 'id, botId, appId, ownerOpenId, name, startedAt, chatId, resolvedAt';

type Creation = FeishuIdentity & {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  chatId: string | null;
  resolvedAt: number | null;
};
type Preview = { token: string; chatId: string; expiresAt: number };

export class FeishuGroups {
  private readonly appId: string;
  private readonly ownerOpenId: string;
  private readonly previews = new Map<string, Preview>();
  private readonly creating = new Map<string, Promise<FeishuBinding>>();
  private readonly unboundListeners = new Set<(bindingId: string) => void>();

  constructor(private readonly store: Store, config: FeishuIdentity,
    private readonly transport: Pick<FeishuTransport,'inspectGroup'|'createGroup'>,
    private readonly isActive: () => boolean = () => true) {
    this.appId = config.appId;
    this.ownerOpenId = config.ownerOpenId;
  }

  get(botId: string): FeishuBinding | null {
    return this.binding('botId', botId);
  }

  findByChat(chatId: string): FeishuBinding | null {
    return this.binding('chatId', chatId);
  }

  onUnbound(listener: (bindingId: string) => void): () => void {
    this.unboundListeners.add(listener);
    return () => { this.unboundListeners.delete(listener); };
  }

  private binding(key: 'botId' | 'chatId', value: string): FeishuBinding | null {
    const row = this.store.db.prepare(`SELECT ${BINDING_FIELDS} FROM feishu_group_bindings WHERE ${key}=? AND appId=? AND ownerOpenId=?`)
      .get(value, this.appId, this.ownerOpenId) as FeishuBinding | undefined;
    return row ? { ...row } : null;
  }

  async preview(botId: string, chatId: string): Promise<FeishuGroupPreview> {
    this.assertActive();
    this.store.getBot(botId);
    const target = typeof chatId === 'string' ? chatId.trim() : '';
    if (!isFeishuChatId(target)) throw new AppError('feishu-chat-id', '请输入有效的飞书群 chat_id。');
    this.assertAvailable(botId, target);
    const preview = { token: randomUUID(), chatId: target, expiresAt: Date.now() + PREVIEW_LIFETIME_MS };
    this.previews.set(botId, preview);
    try {
      const group = await this.inspectGroup(target);
      this.assertActive();
      this.assertPreview(botId, preview);
      this.assertAvailable(botId, target);
      return { chatId: group.chatId, name: group.name, confirmationToken: preview.token };
    } catch (error) {
      if (this.previews.get(botId) === preview) this.previews.delete(botId);
      throw error;
    }
  }

  async bind(botId: string, confirmationToken: string): Promise<FeishuBinding> {
    this.assertActive();
    this.store.getBot(botId);
    const current = this.get(botId);
    if (current && current.id === confirmationToken) return current;
    const preview = this.previews.get(botId);
    if (!preview || preview.token !== confirmationToken) throw this.previewExpired();
    this.assertPreview(botId, preview);
    if (this.creating.has(botId)) throw new AppError('feishu-create-pending', '飞书建群仍在进行，请稍后再确认绑定。');
    const group = await this.inspectGroup(preview.chatId);
    this.assertActive();
    const completed = this.get(botId);
    if (completed && completed.id === confirmationToken) return completed;
    this.assertPreview(botId, preview);
    if (this.creating.has(botId)) throw new AppError('feishu-create-pending', '飞书建群仍在进行，请稍后再确认绑定。');
    return this.storeBinding(botId, group, confirmationToken);
  }

  async create(botId: string, name: string, requestId?: string): Promise<FeishuBinding> {
    this.assertActive();
    this.store.getBot(botId);
    const title = requiredText(name, '飞书群名称', 60);
    const request = requestId === undefined ? undefined : requiredText(requestId, '请求标识', 200);
    const creation = this.reserveCreation(botId, title, request);
    const current = this.get(botId);
    if (current?.id === creation.id) return current;
    if (creation.resolvedAt !== null) throw new AppError('feishu-create-stale', '这次建群请求已结束，请重新发起建群。');
    const running = this.creating.get(botId);
    if (running) return running;
    this.previews.delete(botId);
    const promise = this.completeCreation(creation).finally(() => this.creating.delete(botId));
    this.creating.set(botId, promise);
    return promise;
  }

  unbind(botId: string, expectedBindingId: string): void {
    this.assertActive();
    this.store.getBot(botId);
    const current = this.get(botId);
    if (!current) return;
    if (current.id !== expectedBindingId) throw new AppError('feishu-binding-changed', '飞书群绑定已变更，请刷新后再解绑。');
    this.transaction(() => {
      this.store.db.prepare('DELETE FROM feishu_group_bindings WHERE botId=? AND id=? AND appId=? AND ownerOpenId=?')
        .run(botId, expectedBindingId, this.appId, this.ownerOpenId);
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(GROUP_EVIDENCE_KEY_PREFIX + current.id);
    });
    this.previews.delete(botId);
    for (const listener of this.unboundListeners) listener(current.id);
  }

  private previewExpired(): AppError {
    return new AppError('feishu-preview-expired', '飞书群预览已失效，请重新预览并确认。');
  }

  private assertActive(): void {
    if (!this.isActive()) throw new AppError('feishu-stopped', '飞书接入已停止，请重新打开工作台核对。');
  }

  private assertPreview(botId: string, preview: Preview): void {
    if (this.previews.get(botId) !== preview || preview.expiresAt <= Date.now()) throw this.previewExpired();
  }

  private assertAvailable(botId: string, chatId?: string): void {
    if (this.get(botId)) throw new AppError('feishu-bot-bound', '此 Bot 已绑定飞书群，请先解绑当前群。');
    if (chatId && this.findByChat(chatId)) {
      throw new AppError('feishu-chat-bound', '此飞书群已绑定其他 Bot。');
    }
  }

  private async inspectGroup(chatId: string): Promise<FeishuGroup> {
    const group = await this.transport.inspectGroup(chatId);
    this.assertActive();
    if (group.chatId !== chatId || !group.name?.trim()) {
      throw new AppError('feishu-group-unknown', '未能核对飞书群信息，请重新预览。');
    }
    return group;
  }

  private async inspectCreatedGroup(chatId: string): Promise<FeishuGroup> {
    for (const delayMs of CREATED_GROUP_CHECK_DELAYS_MS) {
      if (delayMs) await delay(delayMs);
      this.assertActive();
      try {
        return await this.inspectGroup(chatId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'feishu-bot-not-in-group') throw error;
        this.assertActive();
      }
    }
    throw new AppError('feishu-created-not-visible', '飞书已建群，但暂时无法确认机器人在群。请在飞书核对机器人已入群，再用原群名称重试绑定。');
  }

  private pending(botId: string): Creation | undefined {
    return this.store.db.prepare(`SELECT ${CREATION_FIELDS} FROM feishu_group_creations
      WHERE botId=? AND appId=? AND ownerOpenId=? AND resolvedAt IS NULL`).get(botId, this.appId, this.ownerOpenId) as Creation | undefined;
  }

  private reserveCreation(botId: string, name: string, requestId?: string): Creation {
    return this.transaction(() => {
      if (requestId) {
        const prior = this.store.db.prepare(`SELECT ${CREATION_FIELDS} FROM feishu_group_creations
          WHERE id=(SELECT creationId FROM feishu_group_creation_requests WHERE requestId=?)`).get(requestId) as Creation | undefined;
        if (prior) {
          if (prior.botId !== botId || prior.appId !== this.appId || prior.ownerOpenId !== this.ownerOpenId || prior.name !== name) {
            throw new AppError('idempotency-conflict', '同一请求标识不能用于不同的飞书建群请求。');
          }
          return prior;
        }
      }
      const current = this.get(botId);
      let creation = this.pending(botId);
      if (current) {
        creation = this.store.db.prepare(`SELECT ${CREATION_FIELDS} FROM feishu_group_creations WHERE id=?`)
          .get(current.id) as Creation | undefined;
        if (creation?.name !== name) this.assertAvailable(botId);
      }
      if (creation && creation.name !== name) {
        throw new AppError('feishu-create-pending', '之前的飞书建群仍待核对。请使用原群名称重试，或预览并绑定已有群。');
      }
      if (!creation) {
        const id = randomUUID(), startedAt = Date.now();
        creation = { id, botId, appId: this.appId, ownerOpenId: this.ownerOpenId, name, startedAt, chatId: null, resolvedAt: null };
        this.store.db.prepare('INSERT INTO feishu_group_creations(id,botId,appId,ownerOpenId,name,startedAt) VALUES (?,?,?,?,?,?)')
          .run(id, botId, this.appId, this.ownerOpenId, name, startedAt);
      }
      if (requestId) this.store.db.prepare('INSERT INTO feishu_group_creation_requests VALUES (?,?)').run(requestId, creation.id);
      return creation;
    });
  }

  private async completeCreation(creation: Creation): Promise<FeishuBinding> {
    let chatId = creation.chatId;
    if (!chatId) {
      const age = Date.now() - creation.startedAt;
      if (age < 0 || age >= CREATE_RETRY_WINDOW_MS) {
        throw new AppError('feishu-create-unknown', '飞书建群结果待核对。请在飞书查找已建的群，再使用群 chat_id 预览并绑定。');
      }
      const group = await this.transport.createGroup(creation.name, creation.id);
      this.assertActive();
      if (!isFeishuChatId(group.chatId)) throw new AppError('feishu-group-unknown', '未能核对飞书建群结果，请稍后重试。');
      const persisted = this.store.db.prepare(`UPDATE feishu_group_creations SET chatId=? WHERE id=?
        AND resolvedAt IS NULL AND (chatId IS NULL OR chatId=?)`).run(group.chatId, creation.id, group.chatId);
      const current = this.get(creation.botId);
      if (current?.id === creation.id && current.chatId === group.chatId) return current;
      if (!persisted.changes) throw new AppError('feishu-create-stale', '飞书建群状态已变更，请刷新后核对。');
      chatId = group.chatId;
    }
    const group = await this.inspectCreatedGroup(chatId);
    const current = this.get(creation.botId);
    if (current?.id === creation.id && current.chatId === chatId) return current;
    if (this.pending(creation.botId)?.id !== creation.id) {
      throw new AppError('feishu-create-stale', '飞书建群状态已变更，请刷新后核对。');
    }
    return this.storeBinding(creation.botId, group, creation.id);
  }

  private storeBinding(botId: string, group: FeishuGroup, id: string): FeishuBinding {
    this.assertActive();
    const boundAt = Date.now();
    const result = this.transaction(() => {
      this.assertAvailable(botId, group.chatId);
      // An explicit confirmation can replace mappings hidden by a credential change.
      this.store.db.prepare(`
        DELETE FROM metadata WHERE key IN (
          SELECT ? || id FROM feishu_group_bindings WHERE botId=? OR (chatId=? AND (appId!=? OR ownerOpenId!=?))
        )
      `).run(GROUP_EVIDENCE_KEY_PREFIX, botId, group.chatId, this.appId, this.ownerOpenId);
      this.store.db.prepare('DELETE FROM feishu_group_bindings WHERE chatId=? AND (appId!=? OR ownerOpenId!=?)')
        .run(group.chatId, this.appId, this.ownerOpenId);
      this.store.db.prepare(`INSERT INTO feishu_group_bindings (id,botId,appId,ownerOpenId,chatId,name,boundAt) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(botId) DO UPDATE SET id=excluded.id,appId=excluded.appId,ownerOpenId=excluded.ownerOpenId,
        chatId=excluded.chatId,name=excluded.name,boundAt=excluded.boundAt`).run(id, botId, this.appId, this.ownerOpenId, group.chatId, group.name, boundAt);
      this.store.db.prepare(`UPDATE feishu_group_creations SET resolvedAt=? WHERE botId=? AND appId=? AND ownerOpenId=? AND resolvedAt IS NULL`)
        .run(boundAt, botId, this.appId, this.ownerOpenId);
      return { id, botId, chatId: group.chatId, name: group.name, boundAt };
    });
    this.previews.delete(botId);
    return result;
  }

  private transaction<T>(operation: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
