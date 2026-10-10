import * as vscode from 'vscode';
import { bindSurface } from './bind-surface';
import type { SurfaceLink } from './surface-link';
import { renderWebviewHtml } from './webview-html';

export const HISTORY_VIEW_TYPE = 'mar-code.history';

/**
 * The session history browser. An editor tab for the same reason as review and
 * fleet: a table of dates, models and summaries does not fit a 300-500px
 * sidebar. At most one; `open()` reveals a live panel instead of making a second.
 */
export class HistoryPanel {
  private panel: vscode.WebviewPanel | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connect: () => Promise<SurfaceLink>,
  ) {}

  open(): void {
    if (this.panel) {
      // No viewColumn: `reveal(column)` moves an already-showing panel.
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      HISTORY_VIEW_TYPE, 'Session history', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }

  restore(panel: vscode.WebviewPanel): void {
    // Cleared before disposing the old panel so a late `onDidDispose` cannot
    // null out the new panel's bookkeeping.
    const old = this.panel;
    if (old !== undefined) {
      this.panel = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
      old.dispose();
    }
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, {
      scriptUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'history.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'history.css'),
      ),
      title: 'Session history',
    });

    const binding = bindSurface(panel.webview, this.connect, {
      // The router places the session; revealing the sidebar needs the vscode API.
      intercept: async (raw, link) => {
        if (raw?.t !== 'focus-session') { return false; }
        link.transport.post(raw);
        await vscode.commands.executeCommand('workbench.view.extension.mar-code');
        return true;
      },
    });

    const disposeSub = panel.onDidDispose(() => {
      if (this.panel !== panel) { return; }
      this.panel = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    });

    this.subscriptions = [binding, disposeSub];
  }

  dispose(): void {
    for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    this.panel?.dispose();
  }
}
