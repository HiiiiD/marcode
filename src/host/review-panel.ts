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
  /** Every subscription `adopt()` makes on the current `panel` — tracked and
   * disposed together with it, the same discipline `extension.ts` applies to
   * every other subscription in the extension. */
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
    // Clears this instance's own bookkeeping *before* asking the old panel to
    // dispose, rather than relying on its `onDidDispose` handler (below) to
    // do it — that handler fires on whatever VS Code's own event loop
    // schedules, and if it ever fires asynchronously rather than
    // synchronously, it would run after `adopt(panel)` already set
    // `this.panel`/`this.unregister` to the *new* panel's values and null
    // them out from under it. Doing the clear here makes `restore()` correct
    // regardless of that ordering; the identity guard in the dispose handler
    // below is the second, independent safety net.
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
    const messageSub = panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // Answered here, off the client's own `ready` — not synthesized at
        // attach time. `onDidChangeViewState` only fires on a future
        // transition, never on registration, and a restored panel VS Code
        // drops straight into a background editor group has
        // `retainContextWhenHidden: false`, so its webview script has not
        // even loaded yet; a post made in `adopt()` before that happens is
        // simply dropped. `ready` is the one signal that cannot race the
        // script load, because the client sent it from inside that script.
        if (raw?.t === 'ready') {
          void panel.webview.postMessage({ t: 'review-visibility', visible: panel.visible });
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] review message handling failed', err);
      }
    });

    const viewStateSub = panel.onDidChangeViewState(() => {
      void panel.webview.postMessage({ t: 'review-visibility', visible: panel.visible });
    });

    const disposeSub = panel.onDidDispose(() => {
      // Guards against `onDidDispose` outliving the panel it was registered
      // for — `restore()` above already clears this instance's bookkeeping
      // before disposing the old panel, but this check makes the handler
      // correct on its own even if that ordering ever changes.
      if (this.panel !== panel) { return; }
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
      // The ordinary path — the user closes the tab — lands here, not in
      // `restore()`'s explicit clear above. Without this, these three
      // disposables sit in `this.subscriptions` until the next `open()`
      // overwrites the array at its assignment above, and we never dispose
      // them ourselves (VS Code tears down a disposed panel's own emitters
      // regardless, so this is belt-and-suspenders, not a leak fix — but it
      // is the same discipline every other exit path here already has).
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    });

    this.subscriptions = [messageSub, viewStateSub, disposeSub];
  }

  dispose(): void {
    this.unregister?.();
    for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    this.panel?.dispose();
  }
}
