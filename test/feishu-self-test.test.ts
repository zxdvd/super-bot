import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { FeishuSelfTest } from '../src/feishu-self-test.ts';
import type {
  FeishuPrivateTextMessage,
  FeishuSelfTestView,
  FeishuTransport,
} from '../src/feishu-types.ts';

const appId = 'cli_fixture';

function fixture(t: TestContext) {
  let now = 1_795_427_300_000;
  const flow = new FeishuSelfTest(() => now);
  t.after(() => flow.clear());
  const sends: {
    chatId: string;
    text: string;
    uuid: string;
    canDispatch?: () => boolean;
    resolve: () => void;
    reject: (cause: Error) => void;
  }[] = [];
  const sendText: FeishuTransport['sendText'] = (chatId, text, uuid, canDispatch) =>
    new Promise<void>((resolve, reject) => {
      sends.push({ chatId, text, uuid, canDispatch, resolve, reject });
    });
  const args = () => ({ sessionId: randomUUID(), startToken: flow.startToken()! });
  const start = ({ sessionId, startToken } = args()) =>
    flow.start(sessionId, startToken, appId, sendText);
  const message = (fields: Partial<FeishuPrivateTextMessage> = {}): FeishuPrivateTextMessage => ({
    appId,
    chatId: 'oc_private',
    senderOpenId: 'ou_candidate',
    messageId: 'om_message',
    text: '不带 @ 的任意一句',
    createdAt: ++now,
    ...fields,
  });
  return {
    flow,
    sends,
    start,
    args,
    message,
    now: () => now,
    advanceTo: (at: number) => {
      now = at;
    },
  };
}

function candidate(view: FeishuSelfTestView) {
  assert.ok('candidate' in view);
  return view.candidate;
}

test('only fresh input from the active application proposes a candidate and a private reply', async (t) => {
  const f = fixture(t);
  const old = f.message();
  f.flow.receive(old);
  const request = f.args();
  const opened = f.start(request);
  assert.equal(opened.state, 'waiting');
  assert.deepEqual(f.start(request), opened);
  assert.equal(f.flow.startToken(), undefined);
  assert.throws(() => f.start({ sessionId: randomUUID(), startToken: request.startToken }), {
    code: 'feishu-test-busy',
  });
  for (const ignored of [
    old,
    f.message({ appId: 'cli_other' }),
    f.message({ createdAt: f.now() + 5000 }),
    f.message({ text: '' }),
  ])
    f.flow.receive(ignored);
  assert.equal(f.sends.length, 0);

  const privateMessage = f.message();
  f.flow.receive(privateMessage);
  const received = f.flow.status(opened.sessionId);
  assert.equal(received.state, 'sending');
  const person = candidate(received);
  assert.equal(person.openId, privateMessage.senderOpenId);
  assert.equal(person.preview, privateMessage.text);
  assert.equal(person.receivedAt, f.now());
  assert.throws(() => f.flow.confirmedOpenId(opened.sessionId, person.confirmationToken), {
    code: 'feishu-test-unconfirmed',
  });
  f.flow.receive(privateMessage);
  f.flow.receive(f.message({ messageId: 'om_new_from_same_chat' }));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]!.chatId, privateMessage.chatId);
  assert.equal(f.sends[0]!.canDispatch?.(), true);
  assert.doesNotMatch(f.sends[0]!.text, /不带 @ 的任意一句|ou_candidate/);
  f.sends[0]!.resolve();
  await Promise.resolve();
  assert.equal(f.flow.status(opened.sessionId).state, 'sent');
  assert.throws(() => f.flow.confirmedOpenId(opened.sessionId, randomUUID()), {
    code: 'feishu-test-unconfirmed',
  });
  assert.throws(() => f.flow.confirmedOpenId(randomUUID(), person.confirmationToken), {
    code: 'feishu-test-stale',
  });
  assert.equal(f.flow.confirmedOpenId(opened.sessionId, person.confirmationToken), person.openId);
});

test('a failed send retains the receive receipt and concurrent retries keep one attempt and one UUID', async (t) => {
  const f = fixture(t),
    { sessionId } = f.start();
  f.flow.receive(f.message());
  f.sends[0]!.reject(Error('Synthetic send failure'));
  await Promise.resolve();
  const failed = f.flow.status(sessionId);
  assert.equal(failed.state, 'send-failed');
  assert.throws(() => f.flow.confirmedOpenId(sessionId, candidate(failed).confirmationToken), {
    code: 'feishu-test-unconfirmed',
  });
  assert.equal(f.flow.retry(sessionId).state, 'sending');
  assert.equal(f.flow.retry(sessionId).state, 'sending');
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0]!.uuid, f.sends[1]!.uuid);
  assert.deepEqual(candidate(f.flow.status(sessionId)), candidate(failed));
  f.sends[1]!.resolve();
  await Promise.resolve();
  assert.equal(f.flow.retry(sessionId).state, 'sent');
  assert.equal(f.sends.length, 2);
});

test('a distinct sender or private chat invalidates the whole test before confirmation', async (t) => {
  const f = fixture(t);
  for (const conflicting of [{ senderOpenId: 'ou_other' }, { chatId: 'oc_other_private' }]) {
    const { sessionId } = f.start();
    f.flow.receive(f.message());
    const first = f.sends.at(-1)!;
    const token = candidate(f.flow.status(sessionId)).confirmationToken;
    if (conflicting.chatId) {
      first.resolve();
      await Promise.resolve();
    }
    f.flow.receive(f.message(conflicting));
    assert.equal(first.canDispatch?.(), false);
    first.resolve();
    await Promise.resolve();
    assert.deepEqual(Object.keys(f.flow.status(sessionId)).sort(), [
      'expiresAt',
      'sessionId',
      'state',
    ]);
    assert.equal(f.flow.status(sessionId).state, 'conflict');
    assert.throws(() => f.flow.confirmedOpenId(sessionId, token), {
      code: 'feishu-test-unconfirmed',
    });
  }
  assert.equal(f.sends.length, 2);
});

test('old starts and replies cannot return after expiry, another session, stop, or skip', async (t) => {
  const f = fixture(t);
  const oldRequest = f.args(),
    first = f.start(oldRequest);
  const oldMessage = f.message();
  f.flow.receive(oldMessage);
  f.advanceTo(first.expiresAt);
  assert.equal(f.flow.status(first.sessionId).state, 'expired');
  assert.equal(f.sends[0]!.canDispatch?.(), false);
  f.flow.receive(f.message());
  const second = f.start();
  f.flow.receive(oldMessage);
  f.sends[0]!.resolve();
  await Promise.resolve();
  assert.equal(f.flow.status(second.sessionId).state, 'waiting');
  assert.throws(() => f.flow.assertCanSkip(first.sessionId, oldRequest.startToken), {
    code: 'feishu-test-busy',
  });
  f.flow.receive(f.message());
  f.flow.interrupt();
  f.sends[1]!.resolve();
  await Promise.resolve();
  assert.equal(f.flow.status(second.sessionId).state, 'interrupted');
  assert.throws(() => f.start(oldRequest), { code: 'feishu-test-stale' });

  const thirdRequest = f.args(),
    third = f.start(thirdRequest);
  f.flow.assertCanSkip(third.sessionId, thirdRequest.startToken);
  f.flow.clear();
  assert.throws(() => f.start(thirdRequest), { code: 'feishu-test-stale' });
  const beforeSkip = f.args();
  f.flow.assertCanSkip();
  f.flow.clear();
  assert.throws(() => f.start(beforeSkip), { code: 'feishu-test-stale' });
  const beforeStop = f.args();
  f.flow.stop(beforeStop.sessionId, beforeStop.startToken);
  assert.throws(() => f.start(beforeStop), { code: 'feishu-test-stale' });
  f.flow.receive(f.message());
  assert.equal(f.sends.length, 2);
});
