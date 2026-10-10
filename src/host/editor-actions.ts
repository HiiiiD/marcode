import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffUri } from './diff-content-provider';
import type { DiffBase } from '../protocol/messages';

/**
 * Opens the file behind a transcript chip. `target` is whatever the chip
 * carried: workspace-relative for files inside an open folder, absolute
 * otherwise. An absolute path is opened directly. A relative path does not
 * record which workspace root it came from, so it is resolved by trying
 * each root in turn and opening the first one where the file actually
 * exists (checked cheaply with `vscode.workspace.fs.stat`) — this avoids
 * silently opening a same-named file under the wrong root in a multi-root
 * workspace. Falls back to the first root if the file exists under none of
 * them, so the error path below still gets a sensible URI to report.
 */
export async function revealFile(target: string, startLine?: number): Promise<void> {
  try {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const uri = path.isAbsolute(target)
      ? vscode.Uri.file(target)
      : await resolveRelativeTarget(target, roots);
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, (startLine ?? 1) - 1);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  } catch (err) {
    // A chip can outlive the file it points at (renamed, deleted, or from a
    // transcript restored in a different workspace). Failing to open one is
    // not worth a user-facing error.
    console.error('[mar-code] could not reveal', target, err);
  }
}

/**
 * Opens one file's change in VS Code's own diff editor.
 *
 * The panel lists; VS Code renders. A side-by-side, syntax-highlit,
 * navigable diff already exists in this window, and reimplementing a worse
 * one inside a 300px sidebar would be the wrong half of the job.
 */
export async function openFileDiff(root: string, target: string, base: DiffBase): Promise<void> {
  try {
    const right = vscode.Uri.file(path.join(root, target));
    const left = diffUri(root, target, base.kind === 'merge-base' ? base.sha : 'HEAD');
    const label = base.kind === 'merge-base' ? base.ref : 'HEAD';
    await vscode.commands.executeCommand(
      'vscode.diff', left, right, `${target} (${label} → working tree)`,
    );
  } catch (err) {
    // A row can outlive the file it names — reverted, deleted, or swept with
    // its worktree. Failing to open one is not worth a user-facing error, the
    // same call this file already makes for a dead transcript chip.
    console.error('[mar-code] could not open diff for', target, err);
  }
}

/**
 * `claude auth login` / `codex login` (or their instance-scoped variants)
 * each open a browser flow and need a real TTY, so this hands the user a
 * terminal rather than trying to drive it. Re-probing afterward is the
 * existing "Check again" retry — nothing here waits for the terminal to
 * close or the login to succeed. `env`, when given, is what scopes the
 * session to a custom instance's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` rather
 * than the default one.
 */
export function openLoginTerminal(terminalName: string, command: string, env?: NodeJS.ProcessEnv): void {
  const terminal = vscode.window.createTerminal({ name: terminalName, ...(env ? { env } : {}) });
  terminal.show();
  terminal.sendText(command);
}

/**
 * Hands a URL from agent output to the OS.
 *
 * `Uri.parse` is strict so a malformed href fails here, in a `catch` that
 * logs, rather than reaching `openExternal` as a half-parsed URI. VS Code
 * owns the decision after that — an unfamiliar host gets its own
 * trusted-domain prompt, which is a gate this panel should not duplicate.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  } catch (err) {
    // Errors are state, never exceptions, and a link that will not open is
    // not worth a modal — the same call the reveal path already makes.
    console.error('[mar-code] could not open', url, err);
  }
}

/**
 * Saves a markdown table's CSV text to a file the user picks. A cancelled
 * dialog resolves `undefined`, which is not an error — it's the user
 * changing their mind, so it takes no action rather than a swallowed catch.
 */
export async function exportCsv(csv: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    filters: { 'CSV': ['csv'] },
    defaultUri: vscode.Uri.file('table.csv'),
  });
  if (!target) { return; }
  try {
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csv));
  } catch (err) {
    // Errors are state, never exceptions — same posture as openExternal.
    console.error('[mar-code] could not save', target.fsPath, err);
    void vscode.window.showErrorMessage(`Could not save ${target.fsPath}.`);
  }
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Saves a tool-output image's `data:` URI to a file the user picks. Same
 * shape as `exportCsv`, decoding base64 instead of encoding text, and
 * picking the save dialog's default extension off the URI's own mime type
 * rather than assuming PNG.
 */
export async function exportImage(dataUri: string): Promise<void> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  if (!match) {
    console.error('[mar-code] malformed image data URI');
    return;
  }
  const [, mime, base64] = match;
  const ext = IMAGE_EXT[mime] ?? 'png';
  const target = await vscode.window.showSaveDialog({
    filters: { 'Image': [ext] },
    defaultUri: vscode.Uri.file(`image.${ext}`),
  });
  if (!target) { return; }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
  } catch (err) {
    // Errors are state, never exceptions — same posture as exportCsv.
    console.error('[mar-code] could not save', target.fsPath, err);
    void vscode.window.showErrorMessage(`Could not save ${target.fsPath}.`);
  }
}

async function resolveRelativeTarget(
  target: string, roots: readonly vscode.WorkspaceFolder[],
): Promise<vscode.Uri> {
  if (roots.length === 0) { return vscode.Uri.file(target); }
  for (const root of roots) {
    const candidate = vscode.Uri.joinPath(root.uri, target);
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Not under this root — try the next one.
    }
  }
  // None of the roots have this file (renamed, deleted, or a transcript
  // restored in a different workspace); fall back to the first root so
  // openTextDocument fails with a normal "file not found" that the caller
  // logs, rather than this function throwing early.
  return vscode.Uri.joinPath(roots[0].uri, target);
}
