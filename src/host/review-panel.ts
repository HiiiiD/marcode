import * as vscode from 'vscode';
import { MessageRouter, type EditorContextHost } from './message-router';
import { PostBus, REVIEW_WANTS } from './post-bus';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { WebviewToHost } from '../protocol/messages';

export const REVIEW_VIEW_TYPE = 'hiiiid-code.review';

/**
 * The fleet diff review tab.
 *
 * An editor tab rather than a slot in the sidebar because the surface is a
 * dense file list and the panel is typically 300-500px: at that width the
 * feature did not render at all. The editor area also means the panes are
 * never replaced, so a session going `awaiting-approval` while review is open
 * stays visible — which is the reason the sidebar placement was wrong twice.
 *
 * At most one. `open()` reveals a live panel instead of making a second, so
 * the command is idempotent and a keybinding cannot litter the editor.
 */
export class ReviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private unregister: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly bus: PostBus,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      REVIEW_VIEW_TYPE, 'Changes', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }

  /** The serializer's entry point: VS Code restored the tab, we re-attach. */
  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
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
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'review.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'review.css'),
      ),
      title: 'Changes',
    });

    this.unregister = this.bus.add({
      post: (msg) => { void panel.webview.postMessage(msg); },
      wants: REVIEW_WANTS,
    });

    const router = new MessageRouter(
      this.manager, (m) => { void panel.webview.postMessage(m); },
      this.defaultCwd, this.editor,
    );
    panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] review message handling failed', err);
      }
    });

    panel.onDidChangeViewState(() => {
      void panel.webview.postMessage({ t: 'review-visibility', visible: panel.visible });
    });
    // `onDidChangeViewState` only fires on a future transition, never
    // synthetically on registration. Without this, a `restore()`d panel that
    // VS Code drops straight into a background editor group would leave the
    // client's `visible` at its `true` default forever if the user never
    // switches to the tab — exactly the always-reading background tab this
    // task exists to stop.
    void panel.webview.postMessage({ t: 'review-visibility', visible: panel.visible });

    panel.onDidDispose(() => {
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.unregister?.();
    this.panel?.dispose();
  }
}
