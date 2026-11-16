/** Fresh home/profile/ledger and deterministic host, with cleanup of only our child. */
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {hostClient} from './host-client.mjs';
const root=resolve('.');await mkdir(join(root,'.runtime'),{recursive:true});
const base=await mkdtemp(join(root,'.runtime/reliability-notify-'));
const home=join(base,'super-bot/.runtime/dsh'),osHome=join(base,'os-home'),log=join(base,'host.log');
await mkdir(home,{recursive:true});await mkdir(osHome,{recursive:true});
// Deliberately do not inherit provider secrets, production dataDir, home, or profile.
const env={PATH:process.env.PATH,HOME:osHome,DSH_HOME:home,LANG:'en_US.UTF-8',TMPDIR:process.env.TMPDIR??'/tmp'};
const cli=join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js');
async function run(args,options={}) {
  const child=spawn(process.execPath,args,{cwd:root,env,...options});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,`command failed: ${args[0]}`);
}
await run(['scripts/build.mjs'],{stdio:'inherit'});await run(['scripts/build-probe.mjs'],{stdio:'inherit'});
const init=await open(join(base,'bootstrap.log'),'w');
try {await run([cli,'--profile','reliability','--from-default-profile','web','--dump-config'],{stdio:['ignore',init.fd,init.fd]});}
finally {await init.close();}
const patch=join(base,'host.patch.json');
await writeFile(patch,JSON.stringify([{id:'hmr',disabled:true},{insert:[
  {id:'super-bot-notification-probe',name:join(root,'.runtime/notification-probe/index.js'),config:{fullAccess:process.env.SUPER_BOT_TEST_FULL_ACCESS==='true'}},
]}]));
let active;
async function launch() {
  const out=await open(log,'w');
  const host=spawn(process.execPath,[cli,'--profile','reliability','--patch',patch,'--no-open','--port','0'],{cwd:root,env,stdio:['ignore',out.fd,out.fd]});
  const state={host,out,exited:false};state.exit=new Promise(resolve=>host.once('exit',()=>{state.exited=true;resolve();}));
  active=state;
  for(let i=0;i<300;i++) {
    assert.equal(state.exited,false,`isolated host exited; see ${log} (contains local launch token, do not share raw)`);
    if((await readFile(log,'utf8')).includes('dsh web:'))return;
    await delay(50);
  }
  throw Error('isolated host startup timed out');
}
async function stop(signal='SIGTERM') {
  const state=active;if(!state)return;
  if(!state.exited)state.host.kill(signal);
  const timer=setTimeout(()=>{if(!state.exited)state.host.kill('SIGKILL');},5000);
  await state.exit;clearTimeout(timer);await state.out.close();active=undefined;
}

const api=async(action,data={})=>{const client=await hostClient(log),r=await(await client.post('/api/super-bot-notification-probe',{action,...data})).json();assert.equal(r.ok,true,JSON.stringify(r));return r;};
async function until(fn,label){let last;for(let i=0;i<250;i++){last=await fn();if(last.ok)return last.value;await delay(40);}assert.fail(`${label}: ${JSON.stringify(last)}`);}
const status=bot=>api('status',bot);
const done=async(bot,n)=>until(async()=>{const s=await status(bot);return {ok:s.notices.filter(v=>v.state==='done').length===n,value:s};},`done ${n}`);
const created=async()=>{const r=await api('create');return {botId:r.botId,eventId:r.eventId};};
const restart=async label=>{await stop('SIGKILL');await rename(log,join(base,`host-${label}.log`));await launch();};
const say=(label,s)=>console.log(JSON.stringify({label,states:s.notices.map(n=>n.state),attempts:s.notices.map(n=>n.attempts),reconcile:s.notices.map(n=>n.reconcileAttempts??0),inputs:s.inputs.length,calls:s.calls,reads:s.reads,tasks:s.tasks}));
try {
  await launch();
  const waiting=await created();let s=await api('pump',waiting);assert.equal(s.notices[0].state,'pending');assert.equal(s.notices[0].attempts,0);
  await restart('not-enabled');s=await api('pump',waiting);assert.equal(s.calls,0);assert.equal(s.notices[0].state,'pending');
  const prepared=await api('prepare',waiting);waiting.sessionId=prepared.sessionId;
  s=await api('pump',waiting);assert.equal(s.notices[0].attempts,0);assert.equal(s.calls,0);say('not-ready preserved across restart',s);
  await api('select',waiting);await api('advance',waiting);s=await done(waiting,1);assert.equal(s.calls,1);assert.equal(s.inputs.length,1);assert.equal(s.tasks,0);say('ready: one input, one model wake',s);
  await api('enqueue',waiting);s=await api('pump',waiting);assert.equal(s.notices.filter(n=>n.state==='pending').length,1);assert.equal(s.calls,1);
  assert.ok(s.notices.some(n=>n.nextAttemptAt>Date.now()));say('wake cap deferred without consumption',s);
  await api('expire-cap',waiting);s=await done(waiting,2);assert.equal(s.calls,2);assert.equal(s.inputs.length,2);say('cap reset: exactly one additional wake',s);
  const disabled=await created();await api('prepare',disabled);await api('disable',disabled);s=await api('pump',disabled);assert.equal(s.notices[0].state,'pending');assert.equal(s.notices[0].attempts,0);assert.equal(s.calls,0);say('disabled Manager respected',s);
  const durable=await created();durable.sessionId=(await api('prepare',durable)).sessionId;
  await api('arm',{...durable,window:'end-durable'});await api('select',durable);await api('pump',durable);
  s=await until(async()=>{const s=await status(durable);return {ok:s.held&&s.completed,value:s};},'durable final before ledger receipt');
  assert.equal(s.calls,1);assert.equal(s.inputs.length,1);assert.notEqual(s.notices[0].state,'done');const messageId=s.notices[0].messageId;say('crash: durable completed reply, receipt blocked',s);
  for(let i=0;i<2;i++){await restart(`durable-${i}`);await api('pump',durable);s=await done(durable,1);assert.equal(s.calls,0);assert.equal(s.inputs.length,1);assert.equal(s.notices[0].messageId,messageId);assert.equal(s.notices[0].attempts,1);say(`durable restart ${i}: no resend`,s);}
  const unknown=await created();unknown.sessionId=(await api('prepare',unknown)).sessionId;
  await api('arm',{...unknown,window:'accepted-before-entry'});await api('select',unknown);await api('pump',unknown);
  s=await until(async()=>{const s=await status(unknown);return {ok:s.notices[0].state==='unknown',value:s};},'accepted input without receipt');
  const lostId=s.notices[0].messageId;await api('checkpoint',unknown);assert.equal((await api('inspect-agent',unknown)).pending,2);say('crash: accepted pending input, no entry evidence',s);
  for(let i=0;i<2;i++) {
    await restart(`unknown-${i}`);await api('pump',unknown);s=await status(unknown);assert.equal(s.notices[0].state,'unknown');assert.equal(s.notices[0].messageId,lostId);assert.equal(s.calls,0);assert.equal(s.inputs.length,0);
    const agent=await api('inspect-agent',unknown);assert.equal(agent.pending,1,'quarantine only automatic input; human retained');assert.equal(agent.calls,0);await api('checkpoint',unknown);
    say(`unknown restart ${i}: no model wake, human input retained`,s);
  }
  for(let i=0;i<4;i++)await api('advance',unknown);s=await status(unknown);assert.equal(s.notices[0].reconcileAttempts,3);assert.equal(s.notices[0].state,'unknown');assert.equal(s.calls,0);assert.equal(s.notices[0].attempts,1);say('unknown: persistent reconciliation budget exhausted, manual resolution required',s);
  await restart('exhausted');await api('pump',unknown);s=await status(unknown);assert.equal(s.reads,0);assert.equal(s.calls,0);assert.equal(s.notices[0].reconcileAttempts,3);assert.equal(s.tasks,0);
  console.log(`PASS isolated notification delivery; fullAccess=${process.env.SUPER_BOT_TEST_FULL_ACCESS==='true'}; evidence: ${base}`);
}finally{await stop();}
