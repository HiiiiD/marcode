/**
 * Which directory a session runs in when the user did not choose one.
 *
 * This was `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()`.
 * The fallback is the bug: `process.cwd()` in an extension host is **VS Code's
 * own install directory** (`…/Programs/Microsoft VS Code` on Windows), so a
 * session started with no folder open did not merely *display* the wrong path
 * — it really ran there, reading and writing inside the editor's installation.
 *
 * The home directory is not a good working directory either; it is simply an
 * honest one. Nothing here can invent a project, so the contract is: pick the
 * workspace when there is one, otherwise say out loud that there is not
 * (`fallback: true`, which `activate()` surfaces as a warning) rather than
 * landing somewhere the user would never have chosen and never be told about.
 *
 * No `vscode` import — same reason `message-router.ts` has none.
 */
export interface DefaultCwd {
  cwd: string;
  /** True when no workspace folder was open and `cwd` is a stand-in. */
  fallback: boolean;
}

export function defaultCwdOf(folders: readonly string[] | undefined, home: string): DefaultCwd {
  const first = (folders ?? []).find((f) => typeof f === 'string' && f.length > 0);
  return first ? { cwd: first, fallback: false } : { cwd: home, fallback: true };
}
