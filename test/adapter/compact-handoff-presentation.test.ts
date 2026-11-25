import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot, ToolChatData, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import { feishuDeliveryText } from '../../src/feishu-delivery.ts';
import { feishuTextData, feishuTextDataFits } from '../../src/feishu-types.ts';
import { DeliveryItems, deliveryCorrection } from '../../src/ui/ChatDeliveryLinks.tsx';
import { resultFileUrl, workUrl } from '../../src/work-links.ts';

const taskId = '11111111-1111-4111-8111-111111111111';
const resultId = '22222222-2222-4222-8222-222222222222';
const path = workUrl({ kind: 'result', taskId, resultId });
const file = resultFileUrl(resultId, 0);
const local = 'http://127.0.0.1:3080';
const publicHost = 'https://dsh.example.invalid';
const mr = 'https://git.example.invalid/team/service/-/merge_requests/42';
const plan = 'https://docs.example.invalid/plans/delivery';
const client = 'https://review.example.invalid/client/43';
const fits = (text: string) => feishuTextDataFits(feishuTextData('oc_synthetic', text, 'a'.repeat(40)));

test('Feishu presents one exact local delivery and two registered portable links from a large handoff', () => {
  const draft = 'http://localhost:7777/draft', reference = 'https://example.invalid/reference';
  const text = [`已完成。 [参考](${reference})`, `- [evidence.md](${local}${file})`, `[查看完整交付](${local}${path})`].join('\n\n');
  const delivery = { taskId, resultId, links: { draft, protected: `${publicHost}${file}`, '后端 MR': mr, '联调方案': plan, '客户端': client } };
  assert.equal(feishuDeliveryText(text, [], local, fits), text, 'unproven replies forward unchanged');
  assert.equal(feishuDeliveryText(text, [delivery], local, fits), [
    `已完成。 [参考](${reference})`, '', `在运行 Bot 的电脑上查看完整交付：${local}${path}`,
    `后端 MR：${mr}`, `联调方案：${plan}`, '另有 1 项交付物见完整成果。',
  ].join('\n'));
});

test('Feishu avoids repeated links and keeps the whole result under its real wire size limit', () => {
  const text = `已完成。\n\n[查看完整交付](${publicHost}${path})`;
  const delivery = { taskId, resultId, links: { '后端 MR': mr, plan, '客户端': client } };
  assert.equal(feishuDeliveryText(text, [delivery], publicHost, fits),
    `已完成。\n\n查看完整交付：${publicHost}${path}\n另有 3 项交付物见完整成果。`);
  assert.equal(feishuDeliveryText(`已核对 [MR](${mr})。`, [delivery], '', fits),
    `已核对 [MR](${mr})。\n\n完整成果请在原 Bot 对话中查看。\nplan：${plan}\n客户端：${client}`);
  const oversized = { ...delivery, links: { huge: `${mr}?token=${'S'.repeat(150_000)}`, plan } };
  assert.equal(feishuDeliveryText(text, [oversized], publicHost, fits),
    `已完成。\n\n查看完整交付：${publicHost}${path}\nplan：${plan}\n另有 1 项交付物见完整成果。`);
});

test('native chat shows short named choices and discloses larger sets without ranking them', () => {
  const links = { '后端 MR': mr, '联调方案': plan, '客户端': client, '外部记录': 'https://example.invalid/records' };
  const complete = DeliveryItems({ links, replyLinks: new Set() })!;
  const disclosure = complete.props.children;
  assert.equal(disclosure.type, 'details');
  assert.deepEqual(disclosure.props.children[0].props.children, ['交付物（', 4, '）']);
  assert.deepEqual(disclosure.props.children[1].props.children.map((link: typeof disclosure) => link.props.href), Object.values(links));
  const compact = DeliveryItems({ links: { ...links, duplicate: plan, invalid: 'javascript:ignored' }, replyLinks: new Set([mr]) })!;
  assert.equal(compact.props.children.type, 'div');
  assert.deepEqual(compact.props.children.props.children.map((link: typeof disclosure) => link.props.href), [plan, client, links['外部记录']]);
});

test('native and Feishu keep the registered primary visible with many secondary links', () => {
  const links = { '后端 MR': mr, '联调方案': plan, '客户端': client, '主要记录': 'https://project.example.invalid/latest' };
  const primaryLink = '主要记录';
  const display = DeliveryItems({ links, primaryLink, replyLinks: new Set() })!;
  const [primary, other] = display.props.children.props.children;
  assert.equal(primary.props.children.props.href, links[primaryLink]);
  assert.equal(other.type, 'details');
  assert.deepEqual(other.props.children[1].props.children.map((link: typeof other) => link.props.href), [mr, plan, client]);
  const text = `评审已准备，请打开记录。\n\n[查看完整交付](${publicHost}${path})`;
  const deliveries = [{taskId, resultId, links, primaryLink}];
  assert.equal(feishuDeliveryText(text, deliveries, publicHost, fits), [
    '评审已准备，请打开记录。', '', `查看完整交付：${publicHost}${path}`,
    `${primaryLink}：${links[primaryLink]}`, '另有 3 项交付物见完整成果。',
  ].join('\n'));
  const duplicate = `[原回复已有入口](${links[primaryLink]})\n\n${text}`;
  assert.equal(feishuDeliveryText(duplicate, deliveries, publicHost, fits).split(links[primaryLink]).length, 2);
  const noDuplicate = DeliveryItems({ links, primaryLink, replyLinks: new Set([links[primaryLink]]) })!;
  assert.equal(noDuplicate.props.children.type, 'div');
  assert.deepEqual(noDuplicate.props.children.props.children.map((link: typeof other) => link.props.href), [mr, plan, client]);
});

test('native link corrections invalidate only the exact matching result', () => {
  const tool = (action: string, id = resultId, isError = false): ToolChatData => ({ root: {
    kind: 'tool-result', name: 'super_bot_manage', seq: 12, time: 0, callId: 'synthetic', isError, subCalls: [],
    callTime: 0, content: [], args: {} as ToolResultNode['args'],
    call: { name: 'super_bot_manage', argsRaw: JSON.stringify({ action, resultId: id }) },
  } });
  const snapshot = (items: ToolChatData[]) => ({ timeline: { turnOrder: [3, 4] }, nodes: {
    turnDataSource(turn: number, kind: string) {
      assert.equal(turn, 4); assert.equal(kind, 'tool-call');
      return { getSnapshot: () => items };
    },
  } } as unknown as ChatSnapshot);
  const deliveries = [{ resultId, links: {} }];
  assert.equal(deliveryCorrection(snapshot([tool('detail'), tool('update_delivery_links', taskId), tool('update_delivery_links', resultId, true)]), deliveries), -1);
  assert.equal(deliveryCorrection(snapshot([tool('update_delivery_links')]), deliveries), 12);
});
