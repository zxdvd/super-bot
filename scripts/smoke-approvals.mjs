/** Verify durable facts after a human/UI trial of the three native approval paths. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostClient } from './host-client.mjs';
const botId=process.argv[2];assert.ok(botId,'Pass the synthetic approval trial Bot ID');
const client=await hostClient();
async function call(action,payload={}){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const page=await call('task.list',{botId,q:'APPROVAL_PROBE',limit:25});assert.equal(page.items.length,3);
const outcomes=[];
for(const task of page.items) {
  const detail=await call('task.detail',{id:task.id});
  const decision=detail.events.find(e=>e.kind==='approval.decided');assert.ok(decision);
  const outcome=JSON.parse(decision.data).outcome;outcomes.push(outcome);
  assert.equal(detail.attentions.filter(a=>a.kind==='approval'&&a.state==='open').length,0);
  assert.equal(detail.input.state,'entered');
  if(outcome==='allowed-once') {assert.equal(task.lifecycle,'review');assert.equal(detail.run.state,'settled');assert.equal(detail.result.evidence[0].bytes,132);assert.equal(detail.result.humanAcceptedAt,null);}
  else {assert.equal(detail.result,null);assert.equal(existsSync(join(detail.binding.cwd,'result.md')),false);assert.equal(detail.run.state,outcome==='rejected'?'failed':'cancelled');}
}
assert.deepEqual(outcomes.sort(),['allowed-once','cancelled','rejected']);
console.log(JSON.stringify({ok:true,botId,outcomes,checks:['native decisions persisted','no lingering approvals','rejected/stopped writes left no file','allowed-once produced an unaccepted candidate']},null,2));
