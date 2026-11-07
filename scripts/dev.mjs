import { spawn } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = resolve(root, '.runtime/dsh-dev');
const cli = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const profile = 'super-bot-dev';
const env = { ...process.env, DSH_HOME: home };
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) throw new Error('DSH Web requires Node 24.9+. Run with fnm exec --using=24.21.0 npm run dev.');
await mkdir(home,{recursive:true});
async function run(args, quiet=false) {
  const child=spawn(process.execPath,[cli,...args],{cwd:root,env,stdio:quiet?['ignore','ignore','inherit']:'inherit'});
  const stop=()=>child.kill('SIGINT');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  if(code!==0)throw new Error(`DSH exited (${code})`);
}
try{await access(join(home,'profiles',profile,'package.json'));}
catch{await run(['--profile',profile,'--from-default-profile','web','--dump-config'],true);}
await run(['plugin','--profile',profile,'add',`link:${root}`],true);
const overlay=join(home,'hmr-dev.patch.yml');
await writeFile(overlay,JSON.stringify([{id:'hmr',disabled:false,config:{base:root,root:['lib/index.js'],awaitWriteFinish:{stabilityThreshold:250,pollInterval:50}}}],null,2));
const watcher=spawn(process.execPath,[join(root,'scripts/build.mjs'),'--watch'],{cwd:root,env,stdio:['ignore','inherit','inherit','ipc']});
const watcherExit=new Promise(done=>watcher.once('exit',done));
try {
  await new Promise((done,reject)=>{
    watcher.once('error',reject);
    watcher.once('exit',code=>reject(new Error(`Build watcher exited before ready (${code})`)));
    watcher.on('message',message=>{if(message?.type==='build-ready')done();});
  });
  await run(['--profile',profile,'--patch',overlay,'--no-open','--port',process.env.SUPER_BOT_PORT??'3081']);
} finally {
  watcher.kill('SIGTERM');await watcherExit;
}
