import { build, context } from 'esbuild';

const host = { entryPoints: ['src/index.ts'], outdir: 'lib', bundle: true, format: 'esm',
  platform: 'node', target: 'es2022', packages: 'external', sourcemap: true };
// DSH loads lazy client factories, not native ESM script tags. React comes from the host.
const client = { entryPoints: ['src/client.tsx'], outdir: 'lib', bundle: true, format: 'cjs',
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
} else {
  await Promise.all([host, client].map(options => build(options)));
}
