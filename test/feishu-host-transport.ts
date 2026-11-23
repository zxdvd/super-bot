import assert from 'node:assert/strict';
import type { FeishuConfig, FeishuHandlers, FeishuTransport } from '../src/feishu-types.ts';

const ownerOpenId = 'ou_fixtureOwner';
export const fixtureCredentials = { appId: 'cli_fixtureApp', appSecret: 'synthetic-secret-never-returned', ownerOpenId };
export const existingGroup = { chatId: 'oc_fixtureExisting', name: '飞书测试已有群' };
export const sent: { chatId: string; text: string; uuid: string }[] = [];
export let starts = 0, handlers: FeishuHandlers | undefined, failSend = false;

export function setFailure(value: boolean) { failSend = value; }

// esbuild substitutes this module for the official SDK only in the isolated test bundle.
export function createFeishuTransport(config: FeishuConfig): FeishuTransport {
  assert.deepEqual(config, fixtureCredentials);
  const created = new Map<string, { chatId: string; name: string }>();
  return {
    start(value) { starts++; handlers = value; value.onConnection('ready'); },
    stop() { handlers?.onConnection('stopped'); handlers = undefined; },
    async sendText(chatId, text, uuid) {
      if (failSend) throw Error(`Mock failure with a credential ${config.appSecret}`);
      sent.push({ chatId, text, uuid });
    },
    async inspectGroup(chatId) {
      if (chatId === existingGroup.chatId) return existingGroup;
      const group = [...created.values()].find(group => group.chatId === chatId);
      assert.ok(group, 'Expected a fixture group');
      return group;
    },
    async createGroup(name, uuid) {
      const group = created.get(uuid) ?? { chatId: `oc_fixtureNew_${created.size + 1}`, name };
      created.set(uuid, group);
      return group;
    },
  };
}
