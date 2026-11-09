// Keeps UI source reviewable: no line in the client view layer may exceed MAX characters.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 140;
const roots = ['src/ui', 'src/client.tsx'];
const files = roots.flatMap(function walk(path) {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap(name => walk(join(path, name))) : /\.tsx?$/.test(path) ? [path] : [];
});
const problems = files.flatMap(file => readFileSync(file, 'utf8').split('\n')
  .map((line, index) => ({ file, line: index + 1, length: [...line].length }))
  .filter(entry => entry.length > MAX));
for (const { file, line, length } of problems) console.error(`${file}:${line} has ${length} characters (max ${MAX})`);
if (problems.length) process.exit(1);
console.log(`lint:lines ok (${files.length} files, max ${MAX})`);
