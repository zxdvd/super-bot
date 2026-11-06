import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const dir='.runtime/probe-plugin';
await mkdir(dir,{recursive:true});
await build({entryPoints:['test/host-probe.ts'],outfile:`${dir}/index.js`,bundle:true,format:'esm',platform:'node',packages:'external',sourcemap:true});
await writeFile(`${dir}/package.json`,JSON.stringify({name:'super-bot-contract-probe',version:'0.0.0',private:true,type:'module',main:'index.js',dsh:{manifestVersion:1,bundle:{patch:'./cordis.patch.yml'}}},null,2));
await writeFile(`${dir}/cordis.patch.yml`,"- insert:\n    - id: super-bot-contract-probe\n      name: 'super-bot-contract-probe'\n");
