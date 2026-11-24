import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { ResultSummary } from '../../src/ui/work/ResultCard.tsx';
import { WorkMarkdown } from '../../src/ui/work/WorkMarkdown.tsx';

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const children = elements(node.props.children);
  return typeof node.type === 'string' ? [node, ...children] : children;
}

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  return typeof node === 'string' ? node : isValidElement(node) ? textOf(node.props.children) : '';
}

test('work prose renders Markdown structure and preserves literal characters and line breaks', () => {
  const view = WorkMarkdown({ text: [
    '合成 **重点** 和 `a < b & c`\n下一行用 2 < 3 & 4 > 1。', '',
    '- 阅读 [文档](https://example.test/guide?a=1&amp;b=2)', '- 运行 `npm test`', '',
    '3. 编译', '4. 验收', '', '```txt', '<fixture> & text', '```',
  ].join('\n') });
  const nodes = elements(view);
  assert.deepEqual(nodes.map(node => node.type), [
    'div', 'p', 'strong', 'code', 'ul', 'li', 'a', 'li', 'code', 'ol', 'li', 'li', 'pre', 'code',
  ]);
  assert.equal(textOf(nodes.find(node => node.type === 'p')), '合成 重点 和 a < b & c\n下一行用 2 < 3 & 4 > 1。');
  assert.equal(textOf(nodes.find(node => node.type === 'strong')), '重点');
  assert.equal(textOf(nodes.find(node => node.type === 'pre')), '<fixture> & text');
  assert.equal(nodes.find(node => node.type === 'ol')?.props.start, 3);
  const link = nodes.find(node => node.type === 'a')!;
  assert.equal(link.props.href, 'https://example.test/guide?a=1&b=2');
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noopener noreferrer');
});

test('work prose keeps unsafe destinations and raw HTML inert', () => {
  const view = WorkMarkdown({ text: [
    '[script](javascript:void(0)) [encoded](jav&#x61;script:void(0)) [data](data:text/plain,fixture)',
    '[file](file:///synthetic.txt) [relative](./notes.md) [schemeless](//example.test/guide)',
    '[credentials](https://owner@example.test) [attachment](https://example.test/api/super-bot-file?index=0)',
    '<img src="https://example.test/ignored.png"> ![image](https://example.test/ignored.png)',
    '', '<script type="text/plain">synthetic markup</script>',
  ].join('\n') });
  const nodes = elements(view);
  assert.ok(nodes.every(node => !['a', 'img', 'script'].includes(String(node.type)) && !node.props.dangerouslySetInnerHTML));
  assert.match(textOf(view), /script encoded data\nfile relative schemeless\ncredentials attachment/);
  assert.match(textOf(view), /<img src="https:\/\/example\.test\/ignored\.png">/);
  assert.match(textOf(view), /<script type="text\/plain">synthetic markup<\/script>/);
});

test('a Bot delivery keeps Markdown and leaves named artifact actions to their links group', () => {
  const artifact = 'https://example.test/result';
  const reference = 'https://example.test/reference';
  const result = { id: 'delivery', summary: 'Worker report', links: { 成果: artifact },
    deliveryText: `**准备完成** [成果](${artifact}) [参考](${reference})` };
  const description = ResultSummary({ result });
  assert.equal(description.key, result.id);
  const view = WorkMarkdown(description.props);
  assert.equal(textOf(view), '准备完成 成果 参考');
  assert.equal(textOf(elements(view).find(node => node.type === 'strong')), '准备完成');
  assert.deepEqual(elements(view).filter(node => node.type === 'a').map(node => node.props.href), [reference]);
});
