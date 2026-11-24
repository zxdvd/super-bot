import assert from 'node:assert/strict';
import type { FeishuConfig, FeishuCredentials, FeishuHandlers, FeishuTransport } from '../src/feishu-types.ts';
import type { checkFeishuConfig as CheckConfig } from '../src/feishu-sdk.ts';

const ownerOpenId = 'ou_fixtureOwner';
export const fixtureCredentials = { appId: 'cli_fixtureApp', appSecret: 'synthetic-secret-never-returned', ownerOpenId };
export const alternateCredentials = {
  appId: 'cli_fixtureOther', appSecret: 'another-synthetic-secret', ownerOpenId: 'ou_fixtureAlternate',
};
export const existingGroup = { chatId: 'oc_fixtureExisting', name: '飞书测试已有群' };
export const sent: { chatId: string; text: string; uuid: string }[] = [];
export let starts = 0, handlers: FeishuHandlers | undefined, failSend = false;
export let checks = 0, stops = 0, creations = 0, inspections = 0, diagnoses = 0;
let unknownDiagnosis = false;

export function setFailure(value: boolean) { failSend = value; }
export function setUnknownDiagnosis(value: boolean) { unknownDiagnosis = value; }

function valid(config: FeishuCredentials): boolean {
  const fixtures = [fixtureCredentials, alternateCredentials];
  return fixtures.some(({ appId, appSecret }) => config.appId === appId && config.appSecret === appSecret);
}

export const checkFeishuConfig: typeof CheckConfig = async config => {
  checks++;
  return { credentials: valid(config) ? 'passed' : config.appSecret === 'unknown-synthetic' ? 'unverified' : 'failed' };
};

// esbuild substitutes this module for the official SDK only in the isolated test bundle.
export function createFeishuTransport(config: FeishuConfig): FeishuTransport {
  assert.ok(valid(config), 'Expected synthetic credentials');
  const created = new Map<string, { chatId: string; name: string }>();
  return {
    async diagnoseGroup() {
      diagnoses++;
      if (unknownDiagnosis) return { ordinaryTextGrant: 'unknown', receiveSubscription: 'unknown' };
      return { ordinaryTextGrant: 'missing', receiveSubscription: 'missing' };
    },
    start(value) { starts++; handlers = value; value.onConnection('ready'); },
    stop() { stops++; handlers?.onConnection('stopped'); handlers = undefined; },
    async sendText(chatId, text, uuid, canDispatch) {
      assert.notEqual(canDispatch?.(), false);
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
