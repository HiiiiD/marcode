import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = /\b(?:expect|assert\w*)\(\s*[^)]*\b(?:renderer|renderable|getRenderable|\.root\b)/;

export function findViolations(source) {
  return source.split('\n').flatMap((line, i) => (BANNED.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'test', 'tui');
  const bad = walk(root).flatMap((f) => findViolations(readFileSync(f, 'utf8')).map((v) => `${f}:${v}`));
  if (bad.length > 0) {
    console.error('A renderer or renderable reached an assertion; compare a string/boolean/count instead:\n' + bad.join('\n'));
    process.exit(1);
  }
}
