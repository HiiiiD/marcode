import * as path from 'node:path';
import * as vscode from 'vscode';
import { EditorContextTracker } from './host/editor-context-tracker';
import { PanelViewProvider } from './host/panel-view-provider';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
import { createVscodeEditorSource } from './host/vscode-editor-source';
import { ClaudeProvider } from './providers/claude/claude-provider';
import { FakeProvider } from './providers/fake/fake-provider';
import type { AgentProvider } from './providers/types';

export async function activate(context: vscode.ExtensionContext) {
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);

  // Order matters: SessionPicker uses state.catalog[0] for the New button,
  // so Claude — the real provider — is registered first.
  const providers = new Map<string, AgentProvider>();
  providers.set('claude', new ClaudeProvider());
  providers.set('fake', new FakeProvider(
    (text) => (text.includes('rm')
      ? [{ kind: 'permission', id: `p-${Date.now()}`, name: 'Bash', input: { command: text } }]
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
  const manager = new SessionManager(store, providers, (msg) => provider.post(msg));

  const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const editorSource = createVscodeEditorSource();
  const tracker = new EditorContextTracker(editorSource);

  const editorHost = {
    current: () => tracker.current,
    reveal: (target: string, startLine?: number) => {
      void revealFile(target, startLine);
    },
  };

  provider = new PanelViewProvider(context.extensionUri, manager, defaultCwd, editorHost);

  // Push every change to the webview so the composer chip tracks the editor.
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    { dispose: () => { void manager.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
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
