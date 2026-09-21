import * as vscode from 'vscode';
import { focusSession } from './focus-session';
import { MessageRouter, type EditorContextHost } from './message-router';
import { PostBus, HISTORY_WANTS } from './post-bus';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { WebviewToHost } from '../protocol/messages';

export const HISTORY_VIEW_TYPE = 'mar-code.history';

/**
 * The session history browser. An editor tab for the same reason as review and
 * fleet: a table of dates, models and summaries does not fit a 300-500px
 * sidebar. At most one; `open()` reveals a live panel instead of making a second.
 */
export class HistoryPanel {
  private panel: vscode.WebviewPanel | undefined;
  private unregister: (() => void) | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly bus: PostBus,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
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
      this.unregister?.();
      this.unregister = undefined;
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

    this.unregister = this.bus.add({
      post: (msg) => { void panel.webview.postMessage(msg); },
      wants: HISTORY_WANTS,
    });

    const router = new MessageRouter(
      this.manager, (m) => { void panel.webview.postMessage(m); },
      this.defaultCwd, this.editor,
    );
    const messageSub = panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // Needs the vscode API, which MessageRouter must not import.
        if (raw?.t === 'focus-session') {
          await focusSession(this.manager, raw.id);
          return;
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[mar-code] history message handling failed', err);
      }
    });

    const disposeSub = panel.onDidDispose(() => {
      if (this.panel !== panel) { return; }
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    });

    this.subscriptions = [messageSub, disposeSub];
  }

  dispose(): void {
    this.unregister?.();
    for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    this.panel?.dispose();
  }
}
