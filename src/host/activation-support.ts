import * as vscode from 'vscode';
import { importOldStorage } from './migrate-storage';
import { PROFILE_GUARD_SNIPPET } from './profile-noise';

/**
 * `marcode.showCacheTimer` — off by default. The badge is a self-computed approximation
 * (anchored at receipt, not confirmed by a later server read); showing it unconditionally would
 * present that approximation as fact to users who never asked for it.
 */
export function showCacheTimer(): boolean {
  return vscode.workspace.getConfiguration('marcode').get<boolean>('showCacheTimer', false);
}

const LEGACY_KEYS = [
  'enabledProviders', 'providerInstances', 'systemPrompts', 'codex.path', 'opencode.path', 'usageMirrors',
  'memory.enabled', 'memory.summarizer', 'review.fileCap', 'review.pollIntervalMs', 'review.baseRefs', 'favoriteModels',
];

/** Explicit values a user set under the old VS Code setting ids, for the one-time `config.json` seed. */
export function legacySettings(): Record<string, unknown> {
  const cfg = vscode.workspace.getConfiguration('marcode');
  const out: Record<string, unknown> = {};
  for (const key of LEGACY_KEYS) {
    const info = cfg.inspect<unknown>(key);
    const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
    if (value !== undefined) { out[key] = value; }
  }
  return out;
}

/**
 * Awaited before the host exists, and without asking: the copy never touches the old directory,
 * and a consent toast awaited here would hold up the panel, while one answered after the host
 * started would merge into an `index.json` the host is already rewriting. Only the report is a toast.
 */
export async function importPreviousStorage(context: vscode.ExtensionContext, workspaceDir: string): Promise<void> {
  const oldDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const result = await importOldStorage(oldDir, workspaceDir);
  if (result.kind === 'failed') { void vscode.window.showWarningMessage(result.reason); }
  if (result.kind === 'imported') {
    void vscode.window.showInformationMessage(
      `Imported ${result.sessions} Marcode session${result.sessions === 1 ? '' : 's'} into ~/.marcode. The originals were copied, not moved.`,
    );
  }
}

/**
 * One warning per window, not per session. Deliberately not persisted: the condition is a live
 * property of the user's shell, so a flag on disk would silence the advice for a still-broken install.
 */
let profileWarned = false;

/**
 * Codex wraps commands as `pwsh.exe -Command "…"` with no `-NoProfile`, so a PowerShell profile
 * that fails to load pollutes every command's output; the profile is the only place a guard can go.
 */
export function warnAboutProfile(profile: string): void {
  if (profileWarned) { return; }
  profileWarned = true;
  const copy = 'Copy fix';
  void vscode.window.showWarningMessage(
    `Your PowerShell profile fails to load when Codex runs a command, and its errors `
      + `end up in the agent's output. Commands still succeed. Guard the console-only `
      + `parts of ${profile} to silence it.`,
    copy,
  ).then((choice) => {
    if (choice !== copy) { return; }
    void vscode.env.clipboard.writeText(PROFILE_GUARD_SNIPPET);
  });
}
