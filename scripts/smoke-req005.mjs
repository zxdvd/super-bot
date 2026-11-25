// Exercises the original chat in isolated native Web and the synthetic Feishu SDK transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureCredentials } from '../test/feishu-host-transport.ts';
import { ambiguous, baselineFile, baselineValue, cancelWiring, clarify, imageBlocked, imageGoal, imageRequest, imageResult, imageScope, imageVersion,
  pauseWiring, pendingContinue, pendingGoal, pendingInitial, pendingRequest, pendingResult, pendingScope,
  preflightFile, preflightGoal, preflightRequest, preflightResult, preflightValue, receiptFile, receiptValue,
  startupContinue, startupGoal, startupRequest, startupResult, versionFile,
  wiringCancelled, wiringGoal, wiringPaused, wiringQuestion, wiringRequest } from '../test/req005-host-fixture.ts';

const eventData = (detail, kind) => detail.events.filter(event => event.kind === kind).map(event => JSON.parse(event.data));
const runEvents = detail => eventData(detail, 'run.queued').map(event => event.runId).reverse();
const runInputs = snapshot => snapshot.events.filter(event => event.type === 'user/message'
  && event.data.source.kind === 'super-bot');
const openRecovery = detail => detail.attentions.some(item => item.kind === 'recovery' && item.state === 'open');
const content = event => event.data.content.map(block => block.type === 'text' ? block.text : '').join('\n');

export async function smokeReq005({ base, initialHost, restart, openChat, call, bot, manager, model, events, feishuInput,
  receive, sent, wait, deploymentFlag, readLog }) {
  let host = initialHost;
  const ownerBot = await bot(host, '原聊天恢复验收');
  const sessionId = await manager(host, ownerBot);
  const { binding: group } = await call(host, 'feishu.create', { botId: ownerBot.id, name: '恢复合成群', requestId: randomUUID() });
  let chat = await openChat(host, ownerBot, sessionId);
  const inspect = id => model(host, 'inspect-session', { sessionId: id });
  const page = () => call(host, 'task.list', { botId: ownerBot.id });
  const detail = id => call(host, 'task.detail', { id, sessionId });
  const task = goal => wait(async () => (await page()).items.find(task => task.goal === goal), goal);
  const assistant = async text => {
    const reply = await wait(async () => (await inspect(sessionId)).assistantTexts.find(reply => reply.includes(text)), text);
    await chat.see(text);
    return reply;
  };
  const syntheticMessage = (text, messageId, senderOpenId = fixtureCredentials.ownerOpenId) =>
    receive(host, group, text, { messageId, senderOpenId, receiptKind: 'plain' });
  const exactIngress = async messageId => (await events(host, sessionId)).filter(event => feishuInput(event)
    && event.data.source.feishuMessageId === messageId);
  const heldWorker = async goal => {
    const { id } = await task(goal);
    return wait(async () => {
      const current = await detail(id);
      if (!current.binding?.sessionId) return;
      const worker = await inspect(current.binding.sessionId);
      if (worker.stalled) return current;
    }, `${goal} synthetic fixture barrier`);
  };
  const release = held => model(host, 'release-stalled-model', { sessionId: held.binding.sessionId });
  const safeFile = async (goal, name, value) => {
    const held = await heldWorker(goal);
    await writeFile(join(held.binding.cwd, name), value + '\n', { flag: 'wx' });
    await release(held);
    return held;
  };

  // Set up two distinct tasks by typing normal requests in one native Web conversation.
  await chat.submit(imageRequest);
  await safeFile(imageGoal, versionFile, imageVersion);
  const image = await task(imageGoal);
  const previousImage = await wait(async () => {
    const state = await detail(image.id);
    return state.run?.state === 'failed' && !state.runHeld && state.runTurn?.endSeq && state;
  }, 'original blocked image attempt and normal turn/end');
  assert.equal(previousImage.task.status, 'blocked');
  assert.equal(previousImage.task.blockingAttention, null);
  await assistant(imageBlocked);
  await chat.submit(wiringRequest);
  const wiring = await task(wiringGoal);
  await assistant(wiringQuestion);
  const previousWiring = await detail(wiring.id);
  assert.equal(previousWiring.pendingQuestions.length, 1);
  assert.equal(previousWiring.runHeld, false);

  await chat.submit(ambiguous);
  const clarification = await assistant(clarify);
  assert.ok(!clarification.includes(image.id) && !clarification.includes(wiring.id) && !clarification.includes('#super-bot-task'));
  assert.deepEqual(runEvents(await detail(image.id)), [previousImage.run.id]);
  assert.deepEqual(runEvents(await detail(wiring.id)), [previousWiring.run.id]);

  // The exact same plain sentence from a non-owner must not enter the native chat or change either task.
  const strangerId = 'om_req005_stranger', ownerId = 'om_req005_owner_scope';
  await syntheticMessage(imageScope, strangerId, 'ou_fixtureOther');
  assert.equal((await exactIngress(strangerId)).length, 0);
  assert.deepEqual(runEvents(await detail(image.id)), [previousImage.run.id]);
  await syntheticMessage(imageScope, ownerId);
  await syntheticMessage(imageScope, ownerId);
  await assistant(imageResult);
  const finishedImage = await detail(image.id);
  assert.deepEqual(runEvents(finishedImage), [previousImage.run.id, finishedImage.run.id]);
  assert.notEqual(finishedImage.run.id, previousImage.run.id);
  assert.equal(finishedImage.binding.sessionId, previousImage.binding.sessionId);
  assert.equal(finishedImage.task.status, 'blocked');
  assert.equal(finishedImage.result, null);
  assert.ok(eventData(finishedImage, 'work.report').some(report => report.runId === finishedImage.run.id
    && report.summary === imageResult));
  const delivery = await wait(async () => {
    const replies = await sent(host, group, imageResult);
    return replies.length && replies;
  }, 'original reply bridged to the same group');
  assert.equal(delivery.length, 1);
  const imageWorker = await inspect(finishedImage.binding.sessionId);
  assert.deepEqual(imageWorker.executedTools.filter(name => name !== 'super_bot_report'), ['read', 'read']);
  const imageInputs = runInputs(imageWorker);
  assert.equal(imageInputs.length, 2);
  assert.ok(content(imageInputs[1]).includes(imageScope));
  assert.ok(content(imageInputs[1]).includes(imageBlocked), 'Worker must receive already observed business state');
  const [ingress] = await exactIngress(ownerId);
  assert.equal((await exactIngress(ownerId)).length, 1);
  assert.equal((await exactIngress(strangerId)).length, 0);
  assert.equal(content(ingress), imageScope);
  assert.deepEqual(await detail(wiring.id).then(state => state.pendingQuestions), previousWiring.pendingQuestions);
  assert.deepEqual(runEvents(await detail(wiring.id)), [previousWiring.run.id]);
  assert.equal((await page()).total, 2);

  await chat.submit(pauseWiring);
  await assistant(wiringPaused);
  const paused = await detail(wiring.id);
  assert.equal(paused.task.controlMode, 'paused');
  await chat.close();
  host = await restart();
  chat = await openChat(host, ownerBot, sessionId);
  await syntheticMessage(imageScope, ownerId);
  assert.equal((await exactIngress(ownerId)).length, 1);
  assert.deepEqual(runEvents(await detail(image.id)), runEvents(finishedImage));
  assert.equal((await detail(wiring.id)).task.controlMode, 'paused');
  await chat.submit(cancelWiring);
  await assistant(wiringCancelled);
  const cancelled = await detail(wiring.id);
  assert.equal(cancelled.task.lifecycle, 'cancelled');
  assert.deepEqual(runEvents(cancelled), [previousWiring.run.id]);

  // A fixture barrier ensures the very first native read fails before the file is repaired.
  await chat.submit(preflightRequest);
  const previousPreflight = await safeFile(preflightGoal, preflightFile, preflightValue);
  await assistant(preflightResult);
  const current = await detail(previousPreflight.task.id);
  assert.deepEqual(runEvents(current), [previousPreflight.run.id]);
  assert.equal(current.binding.sessionId, previousPreflight.binding.sessionId);
  assert.equal(current.run.state, 'failed', 'a successful check must preserve the historical failed run');
  assert.equal(current.result, null, 'a bounded read does not claim that the earlier task succeeded');
  assert.equal(openRecovery(current), false);
  const checks = eventData(current, 'run.recovery-confirmed');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].performed, true);
  assert.equal(checks[0].result.status, 'readable');
  assert.equal(runInputs(await inspect(current.binding.sessionId)).length, 1);
  const turns = (await inspect(sessionId)).events;
  const original = turns.find(event => event.type === 'user/message' && content(event) === preflightRequest);
  assert.ok(original);
  const userTexts = turns.filter(event => event.seq >= original.seq && event.type === 'user/message' && event.data.source.kind === 'user')
    .map(content);
  assert.deepEqual(userTexts, [preflightRequest], 'bounded read-only continuation cannot require a user reply');
  assert.equal((await page()).total, 3);

  // The first readback sees absence. The deterministic status service later observes the same resource at 0/1.
  await chat.submit(startupRequest);
  const previousStartup = await heldWorker(startupGoal);
  await writeFile(deploymentFlag, 'created-not-ready', { flag: 'wx' });
  await release(previousStartup);
  await assistant(startupResult);
  const count = (entries, name) => entries.filter(entry => entry === name).length;
  const reads = async () => (await readFile(readLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const observations = eventData(await detail(previousStartup.task.id), 'run.recovery-observed');
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].result.observed, { uid: 'fixture-deployment-uid', ready: false });
  assert.equal(observations[0].effectUncertain, true);
  await chat.submit(startupContinue);
  await wait(async () => {
    const native = await inspect(sessionId);
    return native.status === 'idle' && native.managerAttempts.some(attempt => attempt.action === 'continue'
      && attempt.taskId === previousStartup.task.id && attempt.userInstruction === startupContinue);
  }, 'explicit continue reaches the same unsafe-to-replay task');
  const startup = await detail(previousStartup.task.id);
  assert.deepEqual(runEvents(startup), [previousStartup.run.id]);
  assert.equal(startup.result, null);
  assert.equal(count((await inspect(startup.binding.sessionId)).executedTools, 'write'), 1);
  assert.equal(count(await reads(), 'get'), 2, 'exactly one original read and one bounded readback');
  assert.equal((await page()).total, 4);
  assert.deepEqual(runEvents(await detail(wiring.id)), [previousWiring.run.id]);

  // Save a general continue and then a narrower step while the original Worker still owns its Run.
  await chat.submit(pendingRequest);
  const pending = await heldWorker(pendingGoal);
  await writeFile(join(pending.binding.cwd, baselineFile), baselineValue + '\n', { flag: 'wx' });
  await writeFile(join(pending.binding.cwd, receiptFile), receiptValue + '\n', { flag: 'wx' });
  for (const instruction of [pendingContinue, pendingScope]) {
    await chat.submit(instruction);
    const saved = await wait(async () => {
      const snapshot = await detail(pending.task.id);
      return snapshot.recoveryInstruction?.source.text === instruction && snapshot;
    }, `persisted owner message before old Worker ended: ${instruction}`);
    assert.equal(saved.run.finishedAt, null);
    assert.equal(saved.runHeld, true);
    assert.deepEqual(runEvents(saved), [pending.run.id]);
  }
  await release(pending);
  await assistant(pendingResult);
  const pickedUp = await detail(pending.task.id);
  const pickedUpWorker = await inspect(pickedUp.binding.sessionId);
  const pickedUpInputs = runInputs(pickedUpWorker);
  assert.deepEqual(runEvents(pickedUp), [pending.run.id, pickedUp.run.id]);
  assert.notEqual(pickedUp.run.id, pending.run.id);
  assert.equal(pickedUp.binding.sessionId, pending.binding.sessionId);
  assert.equal(pickedUpInputs.length, 2);
  assert.ok(content(pickedUpInputs[1]).includes(pendingScope));
  assert.ok(content(pickedUpInputs[1]).includes(pendingInitial));
  const successfulReads = pickedUpWorker.toolResults
    .filter(item => item.meta?.path && item.message.isError === false);
  assert.deepEqual(successfulReads.map(item => item.meta.path), [join(pending.binding.cwd, baselineFile), join(pending.binding.cwd, receiptFile)],
    'the newer instruction must read the receipt without replaying the original baseline action');
  assert.match(successfulReads[1].message.content[0].text, new RegExp(receiptValue));
  const managerTimeline = (await inspect(sessionId)).events;
  const requested = managerTimeline.find(event => event.type === 'user/message' && content(event) === pendingRequest);
  assert.ok(requested);
  assert.deepEqual(managerTimeline.filter(event => event.seq >= requested.seq && event.type === 'user/message' && event.data.source.kind === 'user')
    .map(content), [pendingRequest, pendingContinue, pendingScope]);
  assert.equal((await page()).total, 5);
  await chat.close();

  const proof = { sessionId, entry: chat.entry, image: { taskId: image.id, runs: runEvents(finishedImage),
    priorEndSeq: previousImage.runTurn.endSeq, readback: imageResult, acceptedFeishuMessages: 1,
    foreignFeishuMessages: 0 }, wiring: { taskId: wiring.id, runs: runEvents(cancelled),
    clarification: clarify, pausedAcrossRestart: true, lifecycle: cancelled.task.lifecycle }, preflight: {
    taskId: current.task.id, runs: runEvents(current), boundedChecks: 1, observedReadback: preflightResult, ownerMessages: userTexts.length },
    startup: { taskId: startup.task.id, runs: runEvents(startup), observed: observations[0].result.observed, startupWrites: 1 }, waitingContinuation: {
      taskId: pending.task.id, runs: runEvents(pickedUp), savedWhileActive: [pendingContinue, pendingScope],
      receipt: receiptValue, automaticAfterOldRun: true,
    } };
  await writeFile(join(base, 'req005-proof.json'), JSON.stringify(proof, null, 2));
  console.log(`PASS REQ-005 original ${chat.entry}, named clarification, bound Feishu owner, duplicate delivery through restart, pause/cancel, bounded read-only recovery, no repeated startup and automatic pickup of latest instruction (${base})`);
}
