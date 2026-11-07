/** Rebuild and request DSH's native profile HMR, after Bot and Workers are idle. */
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<24||(major===24&&minor<9))throw Error('Use fnm exec --using=24.21.0 npm run dev:reload.');
const home=resolve(process.env.DSH_HOME??join(homedir(),'.dsh'));
const profile=process.env.SUPER_BOT_PROFILE??'web';
if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile))throw Error('Invalid profile name');
const directory=join(home,'profiles',profile);
const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
const env={...process.env,DSH_HOME:home};
async function run(args) {
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'});
  const stop=()=>child.kill('SIGINT');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
    if(code!==0)throw Error(`Development command failed (${code})`);
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
await run([join(root,'scripts/build.mjs')]);
if(manifest.dependencies?.['@zxdvd/super-bot']!==`link:${root}`) {
  await run([join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'plugin','--profile',profile,'add',`link:${root}`]);
}
// Web's config watcher recomposes linked modules even with source watching disabled.
// HMR compares configuration contents; touching an unchanged file is ignored.
const patch=join(directory,'cordis.patch.yml');
const content=await readFile(patch,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
await writeFile(patch,content.replace(/^# super-bot-dev-reload:.*\r?\n?/gm,'').trimEnd()+`\n# super-bot-dev-reload: ${Date.now()}\n`);
console.log(`Requested native HMR for ${profile}; no package version changed. Check Plugins for activation errors. The Host must already be running with HMR enabled.`);
