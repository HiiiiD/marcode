// The left-hand side of every fleet diff.
//
// `vscode.diff` wants two URIs. The right-hand side is the file on disk; the
// left is that file at the branch point, which exists nowhere on disk. This
// provider supplies it from `git show`.
//
// Deliberately not delegating to the built-in git extension's `git:` scheme
// or its `git.openChange` command: both are another extension's internal
// surface, unversioned for our use, and a diff link that broke on a machine
// where they changed would be untraceable from here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export const DIFF_SCHEME = 'hiiiid-diff';

/**
 * `root` rides in the authority-free `query`, not the path: a Windows tree
 * root is `e:\repo`, and putting a drive letter in a URI path produces a URI
 * that round-trips to something else.
 */
export function diffUri(root: string, path: string, sha: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${path}`,
    query: JSON.stringify({ root, sha }),
  });
}

export function registerDiffContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      let root: string;
      let sha: string;
      try {
        ({ root, sha } = JSON.parse(uri.query) as { root: string; sha: string });
      } catch {
        return '';
      }
      // An untracked or newly created file has no content at the base, and
      // an empty left-hand side is exactly right: the diff reads as all-added.
      if (sha === '') { return ''; }

      const path = uri.path.replace(/^\//, '');
      try {
        const { stdout } = await execFileAsync(
          'git', ['-c', 'core.quotepath=false', 'show', `${sha}:${path}`],
          { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        );
        return stdout;
      } catch {
        // The file did not exist at the base — a create. Same answer, and
        // not an error worth a dialog: errors are state here too.
        return '';
      }
    },
  });
}
