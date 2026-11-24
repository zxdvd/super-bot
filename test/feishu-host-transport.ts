import assert from 'node:assert/strict';
import type { FeishuConfig, FeishuHandlers, FeishuTransport } from '../src/feishu-types.ts';
import type { checkFeishuConfig as CheckConfig } from '../src/feishu-sdk.ts';

const ownerOpenId = 'ou_fixtureOwner';
export const fixtureCredentials = { appId: 'cli_fixtureApp', appSecret: 'synthetic-secret-never-returned', ownerOpenId };
export const alternateCredentials = {
  appId: 'cli_fixtureOther', appSecret: 'another-synthetic-secret', ownerOpenId: 'ou_fixtureAlternate',
};
export const alternateOwnerCredentials = { ...fixtureCredentials, ownerOpenId: alternateCredentials.ownerOpenId };
export const alternateAppCredentials = { ...fixtureCredentials, appId: alternateCredentials.appId };
export const existingGroup = { chatId: 'oc_fixtureExisting', name: '飞书测试已有群' };
export const sent: { chatId: string; text: string; uuid: string }[] = [];
export let starts = 0, handlers: FeishuHandlers | undefined, failSend = false;
export let checks = 0, stops = 0, creations = 0, inspections = 0;

export function setFailure(value: boolean) { failSend = value; }

function valid(config: FeishuConfig): boolean {
  const fixtures = [fixtureCredentials, alternateCredentials, alternateOwnerCredentials, alternateAppCredentials];
  return fixtures.some(({ appId, appSecret, ownerOpenId }) =>
    config.appId === appId && config.appSecret === appSecret && config.ownerOpenId === ownerOpenId);
}

export const checkFeishuConfig: typeof CheckConfig = async config => {
  checks++;
  return {
    credentials: valid(config) ? 'passed' : 'failed',
    permissions: [{ scope: 'im:message.group_at_msg:readonly', status: 'unverified' }],
  };
};

// esbuild substitutes this module for the official SDK only in the isolated test bundle.
export function createFeishuTransport(config: FeishuConfig): FeishuTransport {
  assert.ok(valid(config), 'Expected synthetic credentials');
  const created = new Map<string, { chatId: string; name: string }>();
  return {
    start(value) { starts++; handlers = value; value.onConnection('ready'); },
    stop() { stops++; handlers?.onConnection('stopped'); handlers = undefined; },
    async sendText(chatId, text, uuid) {
      if (failSend) throw Error(`Mock failure with a credential ${config.appSecret}`);
      sent.push({ chatId, text, uuid });
    },
    async inspectGroup(chatId) {
      inspections++;
      if (chatId === existingGroup.chatId) return existingGroup;
      const group = [...created.values()].find(group => group.chatId === chatId);
      assert.ok(group, 'Expected a fixture group');
      return group;
    },
    async createGroup(name, uuid) {
      creations++;
      const group = created.get(uuid) ?? { chatId: `oc_fixtureNew_${created.size + 1}`, name };
      created.set(uuid, group);
      return group;
    },
  };
}
