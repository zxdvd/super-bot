// The native smoke runner copies this file to the head of the isolated process PATH.
// It has no network implementation and accepts only the fixture's read-only argv.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const log = __READ_LOG__;
const ready = __DEPLOYMENT_READY__;
const config = {
  apiVersion: 'v1', kind: 'Config', 'current-context': 'synthetic',
  contexts: [{ name: 'synthetic', context: { cluster: 'fixture-cluster', user: 'fixture-user' } }],
  clusters: [{ name: 'fixture-cluster', cluster: { server: 'https://kubernetes.invalid' } }],
  users: [{ name: 'fixture-user', user: { token: 'fixture-bearer-token' } }],
};
const args = process.argv.slice(2);
const record = command => appendFileSync(log, `${JSON.stringify(command)}\n`);
if (args[0] === 'config') {
  assert.deepEqual(args, ['config', 'view', '--raw', '--flatten', '--minify', '--context', 'synthetic', '-o', 'json']);
  record('config');
  console.log(JSON.stringify(config));
} else {
  assert.deepEqual(args.slice(0, 7), ['--kubeconfig=/dev/stdin', '--context', 'synthetic', '--namespace', 'fixture',
    '--request-timeout=4s', '--cache-dir=/dev/null']);
  assert.deepEqual(JSON.parse(readFileSync(0, 'utf8')), config);
  const command = args.slice(7);
  if (command[0] === 'auth' && command[1] === 'whoami') {
    assert.deepEqual(command, ['auth', 'whoami', '-o', 'json']);
    record('whoami');
    console.log(JSON.stringify({ status: { userInfo: { username: 'fixture-shared', uid: 'fixture-shared-uid' } } }));
  } else if (command[0] === 'auth' && command[1] === 'can-i') {
    assert.deepEqual(command, ['auth', 'can-i', 'get', 'persistentvolumeclaims']);
    record('can-i');
    console.log('no - fixture role does not allow this read');
    process.exitCode = 1;
  } else {
    assert.deepEqual(command, ['get', 'deployments.apps', 'fixture-deployment', '-o', 'json', '--ignore-not-found=true']);
    record('get');
    if (existsSync(ready)) {
      const replicas = readFileSync(ready, 'utf8') === 'created-not-ready' ? 0 : 1;
      console.log(JSON.stringify({
        kind: 'Deployment', metadata: { name: 'fixture-deployment', namespace: 'fixture', uid: 'fixture-deployment-uid', generation: 4 },
        spec: { replicas: 1 }, status: { observedGeneration: 4, replicas: 1, updatedReplicas: 1, availableReplicas: replicas, readyReplicas: replicas },
      }));
    }
  }
}
