import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  approveFixtureDeployment,
  approveRelease,
  confirmReleaseChoice,
  prepareRelease,
  publishOrdinal,
  releaseFixtureGoal,
  releaseLocalNote,
  releaseProject,
  releaseSha,
  releaseStatusQuestion,
  restoreReleasePermission,
  showReleaseChoices,
} from '../test/gitlab-release-fixture.ts';

export async function smokeGitLabRelease({
  base,
  configure,
  launch,
  stop,
  call,
  makeBot,
  probe,
  wait,
  ledgerPath,
}) {
  const cert = join(base, 'gitlab-ca.pem'),
    key = join(base, 'gitlab-ca.key'),
    conf = join(base, 'gitlab-ca.conf');
  await writeFile(
    conf,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Local GitLab Dispatch Test',
      '-config',
      conf,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const fixtures = new Map([
    [11, { mr: 'opened', job: 'manual', outcome: 'success' }],
    [12, { mr: 'merged', job: 'manual', outcome: 'ambiguous-response' }],
    [13, { mr: 'merged', job: 'success', outcome: 'must-not-post' }],
    [14, { mr: 'merged', job: 'manual', outcome: 'must-not-post' }],
    [15, { mr: 'merged', job: 'manual', outcome: 'deny' }],
    [16, { mr: 'merged', job: 'manual', outcome: 'success' }],
    [17, { mr: 'merged', job: 'manual', outcome: 'success', readFailures: 1 }],
    [18, { mr: 'merged', job: 'manual', outcome: 'success' }],
    [19, { mr: 'merged', job: 'manual', outcome: 'success' }],
  ]);
  const seen = [],
    token = 'glpat-isolated-fixture-token';
  let origin;
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (req, res) => {
      const url = new URL(req.url, origin);
      const iid = Number(
        url.pathname.match(/\/(\d+)(?:\/play|\/jobs|\/pipelines|\/ci\/lint)?$/)?.[1],
      );
      const id = iid % 100;
      const fixture = fixtures.get(id);
      seen.push({
        method: req.method,
        path: url.pathname,
        id,
        token: req.headers['private-token'],
      });
      const json = (code, body) =>
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (!fixture || req.headers['private-token'] !== token) return json(401, {});
      const mr = {
        iid: id,
        state: fixture.mr,
        web_url: `${origin}/${releaseProject}/-/merge_requests/${id}`,
        project_id: 900 + id,
        target_project_id: 900 + id,
        target_branch: 'main',
        merge_commit_sha: releaseSha,
        merged_at: '2026-11-25T09:00:00.000Z',
      };
      const pipeline = {
        id: 100 + id,
        project_id: 900 + id,
        source: 'push',
        sha: releaseSha,
        ref: 'main',
        web_url: `${origin}/${releaseProject}/-/pipelines/${100 + id}`,
        created_at: '2026-11-25T09:00:01.000Z',
      };
      const jobId = fixture.jobId ?? 200 + id;
      const job = () => ({
        id: jobId,
        name: 'publish-release',
        stage: 'deploy',
        status: fixture.job,
        pipeline,
        web_url: `${origin}/${releaseProject}/-/jobs/${jobId}`,
        created_at: '2026-11-25T09:00:02.000Z',
      });
      if (
        req.method === 'GET' &&
        url.pathname === `/api/v4/projects/fixture%2Frelease/merge_requests/${id}`
      )
        return json(200, mr);
      if (req.method === 'GET' && url.pathname === `/api/v4/projects/${900 + id}/pipelines`)
        return json(200, [pipeline]);
      if (req.method === 'GET' && url.pathname === `/api/v4/projects/${900 + id}/ci/lint`) {
        assert.equal(url.searchParams.get('content_ref'), releaseSha);
        return json(200, {
          valid: true,
          includes: [],
          merged_yaml: 'publish-release:\n  environment:\n    name: fixture\n    action: start\n',
        });
      }
      if (
        req.method === 'GET' &&
        url.pathname === `/api/v4/projects/${900 + id}/pipelines/${100 + id}/jobs`
      )
        return json(200, [job()]);
      if (req.method === 'GET' && url.pathname === `/api/v4/projects/${900 + id}/jobs/${jobId}`) {
        if (fixture.readFailures > 0) {
          fixture.readFailures--;
          return json(503, {});
        }
        return json(200, job());
      }
      if (
        req.method === 'POST' &&
        url.pathname === `/api/v4/projects/${900 + id}/jobs/${jobId}/play`
      ) {
        if (fixture.outcome === 'ambiguous-response') return json(503, {});
        if (fixture.outcome === 'deny') return json(403, {});
        if (fixture.outcome !== 'success') return json(500, {});
        fixture.job = 'success';
        const { pipeline: _pipeline, ...playResponse } = job();
        return json(200, playResponse);
      }
      return json(404, {});
    },
  );
  // Pipeline listing uses the numeric project ID, whose final digits match the fixture IID.
  const fixtureGlab = join(base, 'fixture-bin');
  await mkdir(fixtureGlab);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = '127.0.0.1:' + server.address().port;
  origin = 'https://' + address;
  const glab = join(fixtureGlab, 'glab');
  await writeFile(
    glab,
    `#!/bin/sh\n[ "$*" = 'config get token --host ${address}' ] || exit 2\nprintf '%s\\n' '${token}'\n`,
  );
  await chmod(glab, 0o700);
  const options = { path: fixtureGlab + delimiter + process.env.PATH, testCa: cert };
  let host;
  const posts = (id) => seen.filter((item) => item.method === 'POST' && item.id === id);
  const taskDetail = (task) => call(host, 'task.detail', { id: task.id });
  async function fresh(id) {
    const mr = `${origin}/${releaseProject}/-/merge_requests/${id}`;
    const bot = await makeBot(host, '合成发布 ' + id);
    await probe(host, 'select-test-model', bot.managerId);
    await probe(host, 'native-prompt', bot.managerId, prepareRelease + mr);
    const task = await wait(
      async () =>
        (await call(host, 'task.list', { botId: bot.id })).items.find(
          (item) => item.goal === releaseFixtureGoal + ' ' + mr,
        ),
      'release task exists',
    );
    const stage = await wait(
      async () => (await taskDetail(task)).stage,
      'Worker checked the exact MR and settled',
    );
    assert.equal(stage.evidenceRef, mr);
    const inspect = () => probe(host, 'inspect-session', bot.managerId);
    await wait(async () => (await inspect()).status === 'idle', 'initial MR notice processed');
    assert.equal(posts(id).length, 0, 'MR preparation did not authorize publication');
    if (id === 16) {
      await probe(host, 'native-prompt', bot.managerId, releaseStatusQuestion);
      assert.equal((await taskDetail(task)).stage.state, 'awaiting-decision');
      assert.equal(
        posts(id).length,
        0,
        'a status question and explicit read-only direction did not authorize release',
      );
    }
    await probe(
      host,
      'native-prompt',
      bot.managerId,
      [16, 18, 19].includes(id) ? approveFixtureDeployment : approveRelease,
    );
    return { task, bot, inspect };
  }
  async function reported(test, state, attempts = 400) {
    const detail = await wait(
      async () => {
        const data = await taskDetail(test.task);
        return data.gitLabRelease?.state === state && !data.runHeld && data;
      },
      'GitLab job state ' + state,
      attempts,
    );
    const { url, detail: summary } = detail.gitLabRelease;
    await wait(
      async () =>
        (await test.inspect()).assistantTexts.some(
          (text) => text.includes(url) && text.includes(summary),
        ),
      'exact observed job link and state in original chat',
      attempts,
    );
    const inputs = (await probe(host, 'inspect-session', detail.binding.sessionId)).events.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === 'super-bot',
    );
    assert.ok(inputs.every((event) => event.data.source.taskId === test.task.id));
    assert.equal((await call(host, 'task.list', { botId: test.bot.id })).total, 1);
    return detail;
  }
  try {
    await configure('web', { hmr: false, fullAccess: true });
    host = await launch('web', 'gitlab-release', options);
    const causal = await fresh(11);
    await wait(
      async () => (await taskDetail(causal.task)).stage?.observation?.stateLabel === 'opened',
      'trusted open MR state recorded after old Shell work',
    );
    fixtures.get(11).mr = 'merged';
    const one = await reported(causal, 'success', 550);
    assert.equal(posts(11).length, 1);
    assert.equal(one.gitLabRelease.target.jobId, 211);
    assert.equal(
      one.stages.find((stage) => stage.dispatchedRunId)?.observation.releaseJob.newAfterMerge,
      true,
    );
    const uncertain = await fresh(12);
    const lost = await reported(uncertain, 'unknown');
    assert.equal(posts(12).length, 1);
    assert.equal(lost.gitLabRelease.status, 'manual');
    await probe(host, 'native-prompt', uncertain.bot.managerId, releaseLocalNote);
    const local = await wait(async () => {
      const state = await taskDetail(uncertain.task);
      return (
        state.directionStatus === 'entered' &&
        !state.runHeld &&
        state.result?.runId === state.run.id &&
        state
      );
    }, 'independent local work completes while the job receipt is unknown');
    assert.equal(await readFile(join(local.binding.cwd, 'handoff.md'), 'utf8'), '合成交接说明');
    const worker = await probe(host, 'inspect-session', local.binding.sessionId);
    const localInput = worker.events.filter(
      (e) => e.type === 'user/message' && e.data.source?.runId === local.run.id,
    );
    assert.equal(localInput.length, 1);
    assert.ok(
      localInput[0].data.content.some((part) => part.text?.includes(lost.gitLabRelease.url)),
    );
    assert.equal(posts(12).length, 1);
    await stop('web', true);
    host = await launch('web', 'gitlab-release-restarted', options);
    assert.equal(
      (await taskDetail(uncertain.task)).gitLabRelease.stageRunId,
      lost.gitLabRelease.stageRunId,
    );
    fixtures.get(12).job = 'success';
    await reported(uncertain, 'success', 550);
    assert.equal(
      posts(12).length,
      1,
      'lost write receipt followed by manual and restart did not submit again',
    );
    await reported(await fresh(13), 'success');
    assert.equal(posts(13).length, 0, 'already-started release is tracked directly');
    const unclear = await reported(await fresh(14), 'unknown');
    assert.equal(unclear.gitLabRelease.status, 'manual');
    assert.equal(
      posts(14).length,
      0,
      'old ambiguous Shell work is readback-only without distinct object evidence',
    );
    const denied = await fresh(15);
    await reported(denied, 'needs-permission');
    assert.equal(posts(15).length, 1);
    fixtures.get(15).outcome = 'success';
    await probe(host, 'native-prompt', denied.bot.managerId, restoreReleasePermission);
    await reported(denied, 'success');
    assert.equal(
      posts(15).length,
      2,
      'affirmative same-chat recovery follows a definitive provider denial',
    );
    const choice = await fresh(16);
    await wait(async () => {
      const state = await choice.inspect();
      return (
        state.status === 'idle' &&
        state.assistantTexts.some((text) => text.includes('作业选项 · publish-release'))
      );
    }, 'original chat distinguishes a proposed deployment scope and requests one business choice');
    assert.equal(posts(16).length, 0);
    await probe(host, 'native-prompt', choice.bot.managerId, confirmReleaseChoice);
    await reported(choice, 'success');
    assert.equal(posts(16).length, 1, 'one natural reply confirms the exact approved job');
    const recovered = await fresh(17);
    const beforeClaim = await reported(recovered, 'unsubmitted');
    assert.equal(posts(17).length, 0, '503 before the claim left the same job unsubmitted');
    const released = await reported(recovered, 'success', 550);
    assert.equal(
      posts(17).length,
      1,
      'trusted read recovery reclaimed the retained job authorization once',
    );
    assert.equal(beforeClaim.gitLabRelease.deadlineAt, released.gitLabRelease.deadlineAt);
    const hiddenChoice = await fresh(18);
    await wait(async () => {
      const chat = await hiddenChoice.inspect();
      return chat.status === 'idle' && chat.assistantTexts.includes('已核对该流水线。');
    }, 'provider option is recorded but has not appeared to the owner');
    await probe(host, 'native-prompt', hiddenChoice.bot.managerId, publishOrdinal);
    const misdirected = await hiddenChoice.inspect();
    assert.ok(
      misdirected.toolResults.some(
        (result) =>
          result.message.isError &&
          result.message.content.some(
            (block) => block.type === 'text' && block.text.includes('展示当前 GitLab 作业选项'),
          ),
      ),
    );
    assert.equal((await taskDetail(hiddenChoice.task)).gitLabRelease, null);
    await probe(host, 'native-prompt', hiddenChoice.bot.managerId, confirmReleaseChoice);
    const rejected = await hiddenChoice.inspect();
    assert.ok(
      rejected.toolResults.some(
        (result) =>
          result.message.isError &&
          result.message.content.some(
            (block) => block.type === 'text' && block.text.includes('请在原聊天展示当前作业选项'),
          ),
      ),
    );
    assert.equal(posts(18).length, 0);
    await probe(host, 'native-prompt', hiddenChoice.bot.managerId, showReleaseChoices);
    await wait(
      async () =>
        (await hiddenChoice.inspect()).assistantTexts.some((text) =>
          text.includes('作业选项 · publish-release'),
        ),
      'explicit question shows the compact choice in the same chat',
    );
    await probe(host, 'native-prompt', hiddenChoice.bot.managerId, confirmReleaseChoice);
    await reported(hiddenChoice, 'success');
    assert.equal(posts(18).length, 1);

    const legacy = await fresh(19);
    const oldStage = await wait(async () => {
      const { stage } = await taskDetail(legacy.task);
      return stage?.state === 'blocked' && stage;
    }, 'release approval awaits a choice');
    await stop('web');
    const db = new DatabaseSync(ledgerPath);
    db.prepare(
      "UPDATE work_stages SET details=json_set(details,'$.observation.releaseChoices',json(?),'$.observation.detail',?) WHERE runId=?",
    ).run(
      JSON.stringify(['former-blue', 'former-green']),
      'Former choices: former-blue, former-green.',
      oldStage.runId,
    );
    db.close();
    fixtures.get(19).jobId = 319;
    host = await launch('web', 'gitlab-legacy-choices-reopened', options);
    await wait(async () => {
      const { stage } = await taskDetail(legacy.task);
      return stage?.state === 'blocked' && stage.observation?.releaseChoices?.[0]?.jobId === 319;
    }, 'reopened old choices trigger trusted read-only discovery of the replacement job');
    await probe(host, 'native-prompt', legacy.bot.managerId, confirmReleaseChoice);
    assert.equal((await taskDetail(legacy.task)).gitLabRelease, null);
    assert.equal(posts(19).length, 0, 'an ordinal reply cannot choose the undisplayed replacement');
    await probe(host, 'native-prompt', legacy.bot.managerId, showReleaseChoices);
    await wait(
      async () =>
        (await legacy.inspect()).assistantTexts.some((text) =>
          text.includes('作业选项 · publish-release'),
        ),
      'actual replacement option appears in the restored chat',
    );
    await probe(host, 'native-prompt', legacy.bot.managerId, confirmReleaseChoice);
    const replacement = await reported(legacy, 'success');
    assert.equal(replacement.gitLabRelease.target.jobId, 319);
    assert.deepEqual(
      posts(19).map((item) => item.path),
      ['/api/v4/projects/919/jobs/319/play'],
    );

    assert.ok(seen.every((item) => item.token === token));
    console.log(
      'PASS original DSH chat, hidden and reopened choices, counted formal jobs, restart readback, prior effects, and permission recovery',
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
