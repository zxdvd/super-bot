/** Prepare an unmounted, profile-specific local package. Print the link for DSH plugin add. */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePackage } from '../src/dev-reload-paths.ts';

const profile = process.argv[2];
if (process.argv.length !== 3 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) {
  throw Error('Usage: node scripts/dev-profile-package.mjs <existing-profile-name>');
}
const dir = realpathSync(
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile),
);
const source = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const target = profilePackage(source, dir);
const parent = dirname(target);
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (realpathSync(parent) !== parent) throw Error('Invalid build directory');
if (!existsSync(target)) {
  const temp = mkdtempSync(join(parent, '.prepare-'));
  try {
    for (const file of ['package.json', 'cordis.patch.yml', 'schema-version.json'])
      cpSync(join(source, file), join(temp, file));
    // Node resolves external packages from the source checkout above this directory.
    execFileSync(process.execPath, [join(source, 'scripts/build.mjs')], {
      cwd: source,
      stdio: ['ignore', 2, 2],
      env: {
        ...process.env,
        SUPER_BOT_BUILD_OUTDIR: join(temp, 'lib'),
        SUPER_BOT_RELOAD_BUILD_ID: '',
      },
    });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (realpathSync(target) !== target) throw Error('Invalid profile package');
console.log('link:' + target);
