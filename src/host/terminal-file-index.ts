import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { matchFiles } from './file-index';
import type { FileSearch } from './message-router';

const SCAN_CAP = 5000;
const TTL_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout.split('\0').filter(Boolean).slice(0, SCAN_CAP));
    });
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < SCAN_CAP) {
    const dir = queue.shift() as string;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { queue.push(rel); } } else if (e.isFile()) { out.push(rel); }
    }
  }
  return out.slice(0, SCAN_CAP);
}

/** `FileSearch` for hosts with no `vscode` workspace: git's own file list, else a capped walk. Re-read after a short TTL. */
export function createTerminalFileIndex(root: string): FileSearch {
  let cache: { at: number; paths: Promise<string[]> } | undefined;
  const paths = () => {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), paths: gitFiles(root).then((files) => files ?? walkFiles(root)) };
    }
    return cache.paths;
  };
  return { search: async (query) => matchFiles(await paths(), query) };
}
