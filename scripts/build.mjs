import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await build({ entryPoints: ['src/index.ts'], outdir: 'lib', bundle: true, format: 'esm',
  platform: 'node', target: 'es2022', packages: 'external', sourcemap: true });
// DSH loads lazy client factories, not native ESM script tags. React comes from the host.
await build({ entryPoints: ['src/client.tsx'], outdir: 'lib', bundle: true, format: 'cjs',
  platform: 'browser', target: 'es2022', packages: 'external', sourcemap: true, jsx: 'automatic',
  banner: { js: 'window.__ModuleLoader__.load({id:"@zxdvd/super-bot",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } });
