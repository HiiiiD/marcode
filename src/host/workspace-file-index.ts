import * as path from 'path';
import * as vscode from 'vscode';
import { matchFiles } from './file-index';
import type { FileSearch } from './message-router';
import type { FileRef } from '../protocol/messages';

const EXCLUDE_GLOB = '**/{node_modules,.git,out,dist}/**';
const SCAN_CAP = 5000;

/**
 * The real `FileSearch`. Backed by `vscode.workspace.findFiles`, cached
 * until a create or delete invalidates it — a rename fires both, so it needs
 * no case of its own. Listing everything up front rather than re-globbing
 * per keystroke is what keeps `search` cheap enough to call on every
 * debounced query; `matchFiles` (in `file-index.ts`, which imports no
 * `vscode` and so unit-tests) does the actual filtering, in-process.
 *
 * Split from `file-index.ts` for the same reason `vscode-editor-source.ts`
 * is split from `editor-context-tracker.ts`: a module that imports `vscode`
 * cannot load under the unit test runner at all, so the pure matcher has to
 * live somewhere that import never reaches.
 */
export function createWorkspaceFileIndex(root: string): FileSearch & { dispose(): void } {
  let cache: string[] | undefined;

  const invalidate = () => { cache = undefined; };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const subs = [watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)];

  async function paths(): Promise<string[]> {
    if (cache) { return cache; }
    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, SCAN_CAP);
    cache = uris.map((uri) => path.relative(root, uri.fsPath).split(path.sep).join('/'));
    return cache;
  }

  return {
    async search(query: string): Promise<FileRef[]> {
      return matchFiles(await paths(), query);
    },
    dispose(): void {
      watcher.dispose();
      for (const sub of subs) { sub.dispose(); }
    },
  };
}
