import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = resolve(root, '.runtime/dsh');
const cli = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const profile = 'super-bot-test';
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
await run(['plugin','--profile',profile,'add',root],true);
await run(['--profile',profile,'--no-open','--port',process.env.SUPER_BOT_PORT??'3081']);
