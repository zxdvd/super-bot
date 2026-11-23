import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement } from 'react';
import { installBotSidebar } from '../../src/ui/BotSidebar.tsx';
import type { WorkspaceApi } from '../../src/ui/work/api.ts';

test('sidebar mode switches only its own workspaces registration and keeps one footer toggle', () => {
  type Entry = { name: string; priority?: number; render: (props: { wide: boolean }) => ReactElement };
  const native = { name: 'sidebar.workspaces', render: () => assert.fail('plugin must not render the native list') };
  const entries = new Set<Entry>([native]);
  const registrations = new Set<string>();
  const slots = {
    inject(name: string, register: () => () => void) {
      assert.ok(!registrations.has(name));
      registrations.add(name);
      const release = register();
      return () => { assert.ok(registrations.delete(name)); release(); };
    },
    register(options: Omit<Entry, 'render'>, render: Entry['render']) {
      const entry = { ...options, render };
      entries.add(entry);
      return () => { assert.ok(entries.delete(entry)); };
    },
  } as Context['slots'];
  const unexpected = () => assert.fail('switching sidebar mode must not use the chat API');
  const api: WorkspaceApi = { call: unexpected, openSession: unexpected, beginNavigation: unexpected, openBot: unexpected };
  const dispose = installBotSidebar(slots, api);
  const visibleList = () => [...entries].filter(e => e.name === native.name).sort((a, b) =>
    (a.priority ?? 0) - (b.priority ?? 0))[0];
  const footer = [...entries].find(e => e.name === 'sidebar.footer.action')!;
  const { mode } = footer.render({ wide: true }).props;
  const states: boolean[] = [];
  const unsubscribe = mode.subscribe(() => states.push(mode.getSnapshot()));
  assert.equal(mode.getSnapshot(), true);

  for (let i = 0; i < 4; i++) {
    const botList = visibleList()!;
    assert.notEqual(botList, native);
    const { lifetime } = botList.render({ wide: true }).props;
    assert.equal(lifetime.aborted, false);
    assert.deepEqual(entries, new Set([native, botList, footer]));

    mode.toggle();
    assert.equal(lifetime.aborted, true);
    assert.equal(visibleList(), native);
    assert.deepEqual([...entries], [native, footer]);
    mode.toggle();
  }
  assert.deepEqual(states, [false, true, false, true, false, true, false, true]);
  const { lifetime } = visibleList()!.render({ wide: true }).props;
  unsubscribe();
  dispose();
  assert.equal(lifetime.aborted, true);
  assert.equal(registrations.size, 0);
  assert.deepEqual([...entries], [native]);
});
