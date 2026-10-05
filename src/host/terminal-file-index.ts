import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { indexPaths, searchIndex, type IndexedPath } from './file-index';
import type { FileSearch } from './message-router';

const GIT_CAP = 200_000;
const WALK_CAP = 50_000;
const STALE_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout.split('\0').filter(Boolean).slice(0, GIT_CAP));
    });
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < WALK_CAP) {
    const dir = queue.shift() as string;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { queue.push(rel); } } else if (e.isFile()) { out.push(rel); }
    }
  }
  return out.slice(0, WALK_CAP);
}

const scan = async (root: string): Promise<IndexedPath[]> => indexPaths((await gitFiles(root)) ?? (await walkFiles(root)));

/**
 * `FileSearch` for hosts with no `vscode` workspace. The scan starts at construction so the first `@` finds it
 * ready, and a stale index keeps answering while a fresh one builds, so no keystroke ever waits on a rescan.
 */
export function createTerminalFileIndex(root: string): FileSearch {
  let current: Promise<IndexedPath[]> = scan(root);
  let builtAt = Date.now();
  let rebuilding = false;

  const refreshIfStale = () => {
    if (rebuilding || Date.now() - builtAt < STALE_MS) { return; }
    rebuilding = true;
    void scan(root).then((next) => { current = Promise.resolve(next); builtAt = Date.now(); }).finally(() => { rebuilding = false; });
  };

  return {
    search: async (query) => {
      const index = await current;
      refreshIfStale();
      return searchIndex(index, query);
    },
  };
}
