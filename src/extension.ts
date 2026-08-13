import * as vscode from 'vscode';
import { PanelViewProvider } from './host/panel-view-provider';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
import { FakeProvider } from './providers/fake/fake-provider';
import type { AgentProvider } from './providers/types';

export async function activate(context: vscode.ExtensionContext) {
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);

  const providers = new Map<string, AgentProvider>();
  providers.set('fake', new FakeProvider(() => [
    { kind: 'text', delta: 'This is the fake provider. ' },
    { kind: 'turn-end', reason: 'done' },
  ]));

  let provider: PanelViewProvider;
  const manager = new SessionManager(store, providers, (msg) => provider.post(msg));
  await manager.init();

  provider = new PanelViewProvider(context.extensionUri, manager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    { dispose: () => { void manager.dispose(); } },
  );
}

export function deactivate() {}
