import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AttachmentStore } from './host/attachment-store';
import { defaultCwdOf } from './host/default-cwd';
import { diffUri, registerDiffContentProvider } from './host/diff-content-provider';
import { EditorContextTracker } from './host/editor-context-tracker';
import { PanelViewProvider } from './host/panel-view-provider';
import type { AttachmentHost } from './host/message-router';
import { PROFILE_GUARD_SNIPPET } from './host/profile-noise';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
import { createVscodeEditorSource } from './host/vscode-editor-source';
import { ClaudeProvider } from './providers/claude/claude-provider';
import { CodexProvider } from './providers/codex/codex-provider';
import { FakeProvider } from './providers/fake/fake-provider';
import type { DiffBase } from './protocol/messages';
import type { AgentProvider } from './providers/types';

/**
 * `hiiiidCode.codex.path` defaults to `""` (see package.json) so the
 * settings UI shows an empty field, but CodexProvider's own default only
 * kicks in for `undefined` — passing through `""` would spawn `''` and
 * make Codex unavailable out of the box. Empty (or unset) means "use codex
 * from PATH", so it is normalized to `undefined` here at the boundary.
 */
function codexBinPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('hiiiidCode').get<string>('codex.path');
  return configured ? configured : undefined;
}

/**
 * One warning per window, not per session and not per command.
 *
 * Deliberately not persisted: the condition is a live property of the user's
 * shell, so a flag on disk would silence the advice for an install that is
 * still broken. A window is the smallest scope that does not nag.
 */
let profileWarned = false;

/**
 * Tells the user their PowerShell profile is being loaded — and failing — for
 * every command Codex runs, and hands them the fix.
 *
 * Nothing here can repair it: Codex wraps commands as `pwsh.exe -Command "…"`
 * with no `-NoProfile` and that invocation is not ours to change, so the
 * profile is the only place the guard can go. See `host/profile-noise.ts`.
 */
function warnAboutProfile(profile: string): void {
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

export async function activate(context: vscode.ExtensionContext) {
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);
  const attachments = new AttachmentStore(rootDir);

  // Order matters: SessionPicker uses state.catalog[0] for the New button,
  // so Claude — the real provider — is registered first.
  const providers = new Map<string, AgentProvider>();
  providers.set('claude', new ClaudeProvider());
  const codexProvider = new CodexProvider({ binPath: codexBinPath() });
  providers.set('codex', codexProvider);
  providers.set('fake', new FakeProvider(
    (text) => (text.includes('rm')
      ? [{
          kind: 'permission', id: `p-${Date.now()}`,
          tool: { kind: 'command', label: 'Bash', command: text },
        }]
      : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]),
    // Scripted so both the context ring and the usage strip have something
    // to render in the dev host. Obviously synthetic, and deliberately
    // scripted *here* rather than defaulted inside FakeProvider — the unit
    // tests depend on an unscripted fake genuinely omitting `contextBreakdown`.
    // The two memory files share a basename on purpose: that is the case
    // the popover's rows have to stay distinguishable in.
    {
      context: {
        systemPercent: 12,
        memoryPercent: 5,
        conversationPercent: 26,
        freePercent: 57,
        memoryFiles: [
          { path: '/fake/workspace/CLAUDE.md', percent: 4 },
          { path: '/fake/home/.claude/CLAUDE.md', percent: 1 },
        ],
      },
      windows: [
        { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() + 2 * 3_600_000 },
        { id: 'seven-day', label: 'Week', usedPercent: 18, resetsAt: Date.now() + 3 * 86_400_000 },
      ],
    },
  ));

  let provider: PanelViewProvider;
  const manager = new SessionManager(
    store, providers, (msg) => provider.post(msg), undefined, warnAboutProfile, attachments,
  );

  // Never `process.cwd()` — for an extension host that is VS Code's own
  // install directory, and a session inherits it silently. See
  // `host/default-cwd.ts`.
  const resolvedCwd = defaultCwdOf(
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath),
    os.homedir(),
  );
  const defaultCwd = resolvedCwd.cwd;
  if (resolvedCwd.fallback) {
    // Visible, not silent: the alternative is an agent quietly reading and
    // writing somewhere the user never chose.
    void vscode.window.showWarningMessage(
      `No folder is open, so agent sessions will run in ${defaultCwd}. `
        + 'Open a folder to run them in your project.',
    );
  }

  const editorSource = createVscodeEditorSource();
  const tracker = new EditorContextTracker(editorSource);

  const editorHost = {
    current: () => tracker.current,
    reveal: (target: string, startLine?: number) => {
      void revealFile(target, startLine);
    },
    openDiff: (root: string, target: string, base: DiffBase) => {
      void openFileDiff(root, target, base);
    },
  };

  const picker: AttachmentHost = {
    pick: async () => {
      const chosen = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
      });
      return chosen?.map((uri) => uri.fsPath) ?? [];
    },
  };

  provider = new PanelViewProvider(
    context.extensionUri, manager, defaultCwd, editorHost, attachments, picker,
  );

  // Push every change to the webview so the composer chip tracks the editor.
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    registerDiffContentProvider(),
    { dispose: () => { void manager.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
    vscode.commands.registerCommand('hiiiidCode.codex.login', () => {
      // `codex login` opens a browser flow and needs a real TTY, so this
      // hands the user a terminal rather than trying to drive it.
      const terminal = vscode.window.createTerminal('Codex login');
      terminal.show();
      terminal.sendText('codex login');
    }),
    // A changed path is a different install: point the provider at it, then
    // re-probe — which is also how the provider recovers from 'unavailable'.
    // refreshModels already IS the availability probe — see session-manager.
    // setBinPath must run first: it is what makes the re-probe actually use
    // the new path, rather than retrying the stale one connect() already
    // cached. It also kills the process running against the old binary,
    // which ends any Codex session currently in flight — a user who
    // changes the binary has declared the running one wrong, so those
    // sessions land in 'error' with a transcript item (CodexRun's onClose
    // handling), not silently on the old process.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hiiiidCode.codex.path')) {
        codexProvider.setBinPath(codexBinPath());
        void manager.refreshModels(defaultCwd);
      }
    }),
  );

  try {
    await manager.init();
  } catch (err) {
    // A corrupt index.json (or any other restore failure) must not take the
    // whole extension down with it: the view provider is already registered
    // above, so the panel still comes up — with an empty roster — instead
    // of the extension failing to activate and there being no UI at all.
    console.error('[hiiiid-code] failed to restore session index; starting with an empty roster', err);
  }
}

export function deactivate() {}

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
async function revealFile(target: string, startLine?: number): Promise<void> {
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
    console.error('[hiiiid-code] could not reveal', target, err);
  }
}

/**
 * Opens one file's change in VS Code's own diff editor.
 *
 * The panel lists; VS Code renders. A side-by-side, syntax-highlit,
 * navigable diff already exists in this window, and reimplementing a worse
 * one inside a 300px sidebar would be the wrong half of the job.
 */
async function openFileDiff(root: string, target: string, base: DiffBase): Promise<void> {
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
    console.error('[hiiiid-code] could not open diff for', target, err);
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
