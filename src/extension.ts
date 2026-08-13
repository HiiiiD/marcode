import * as vscode from 'vscode';
import { PanelViewProvider } from './host/panel-view-provider';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
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
  providers.set('fake', new FakeProvider((text) => (text.includes('rm')
    ? [{ kind: 'permission', id: `p-${Date.now()}`, name: 'Bash', input: { command: text } }]
    : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])));

  let provider: PanelViewProvider;
  const manager = new SessionManager(store, providers, (msg) => provider.post(msg));

  const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  provider = new PanelViewProvider(context.extensionUri, manager, defaultCwd);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    { dispose: () => { void manager.dispose(); } },
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
