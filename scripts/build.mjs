import { build, context } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const destination = process.env.SUPER_BOT_BUILD_OUTDIR ?? 'lib';
const reloadBuild = process.env.SUPER_BOT_RELOAD_BUILD_ID ?? '';
// Resolve source maps against their final location even when a reload stages the artifacts.
const outdir = reloadBuild ? 'lib' : destination;
const host = { entryPoints: ['src/index.ts'], outdir, bundle: true, format: 'esm',
  platform: 'node', target: 'es2022', packages: 'external', sourcemap: true,
  define: { __SUPER_BOT_RELOAD_BUILD__: JSON.stringify(reloadBuild) } };
// DSH loads lazy client factories, not native ESM script tags. React comes from the host.
const client = { entryPoints: ['src/client.tsx'], outdir, bundle: true, format: 'cjs',
  platform: 'browser', target: 'es2022', packages: 'external', sourcemap: true, jsx: 'automatic',
  banner: { js: 'window.__ModuleLoader__.load({id:"@zxdvd/super-bot",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } };

if (process.argv.includes('--watch')) {
  const builders = await Promise.all([host, client].map(options => context(options)));
  await Promise.all(builders.map(builder => builder.rebuild()));
  await Promise.all(builders.map(builder => builder.watch()));
  process.send?.({type:'build-ready'});
  console.log('Watching Super Bot source; DSH reloads rebuilt lib/index.js and lib/client.js.');
  let closing;
  const stop = () => closing ??= Promise.all(builders.map(builder => builder.dispose())).then(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else if (reloadBuild) {
  const results = await Promise.all([host, client].map(options => build({ ...options, write: false })));
  const files = results.flatMap(result => result.outputFiles);
  await Promise.all(files.map(file => writeFile(join(destination, basename(file.path)), file.contents, { flag: 'wx' })));
} else {
  await Promise.all([host, client].map(options => build(options)));
}
