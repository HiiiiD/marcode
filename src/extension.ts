import * as vscode from 'vscode';
import { PanelViewProvider } from './host/panel-view-provider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new PanelViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
  );
}

export function deactivate() {}
