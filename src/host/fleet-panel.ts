import * as vscode from 'vscode';
import { bindSurface } from './bind-surface';
import type { SurfaceLink } from './surface-link';
import { renderWebviewHtml } from './webview-html';
import type { SessionId } from '../protocol/messages';

export const FLEET_VIEW_TYPE = 'mar-code.fleet';

/**
 * The fleet-wide view: every roster session's live status and activity, in
 * an editor tab, mirroring `ReviewPanel`'s architecture exactly — its own
 * `WebviewPanel`, its own `PostBus` registration, its own `MessageRouter`.
 * At most one; `open()` reveals a live panel rather than making a second.
 */
export class FleetPanel {
  private panel: vscode.WebviewPanel | undefined;
  /** Every subscription `adopt()` makes on the current `panel` — tracked and
   * disposed together with it, the same discipline `ReviewPanel` applies. */
  private subscriptions: vscode.Disposable[] = [];
  /**
   * A drill-in requested before the panel existed (or before its `ready`
   * handshake completed) — held until `adopt()`'s message handler sees this
   * panel's own `ready` produce a `hydrate` the target session is guaranteed
   * to be inside, then sent and cleared. Never sent early: a client asked to
   * select a subagent it has no items for yet would just fail to find it.
   */
  private pendingFocus: { sessionId: SessionId; itemId: string } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connect: () => Promise<SurfaceLink>,
  ) {}

  open(focus?: { sessionId: SessionId; itemId: string }): void {
    if (this.panel) {
      // No viewColumn argument — `reveal(viewColumn)` MOVES the panel to
      // that column even when it's already showing (it isn't a no-op
      // "bring to front"). Passing `Beside` here computed a column relative
      // to whatever was currently active, which after the first reveal is
      // the panel itself: every subsequent open() call kept "revealing
      // beside itself," churning editor groups and leaving a blank one
      // behind. `Beside` belongs only on first creation, below, where there
      // is no existing panel yet to move.
      this.panel.reveal();
      if (focus) {
        // `retainContextWhenHidden: false` means a backgrounded Fleet tab has
        // had its webview torn down; `reveal()` triggers an async reload of
        // it, so the post below can land on a dead webview and be silently
        // dropped. Set `pendingFocus` too — not instead — so the reloaded
        // client's `ready` handler (below) flushes it once the webview is
        // actually back, covering the torn-down case the immediate post
        // can't. If the webview was genuinely still live, this post already
        // delivered and `pendingFocus` is a harmless no-op unless a `ready`
        // also fires for it, which does not happen in normal operation.
        void this.panel.webview.postMessage({ t: 'fleet-focus-subagent', ...focus });
        this.pendingFocus = focus;
      }
      return;
    }
    this.pendingFocus = focus;
    const panel = vscode.window.createWebviewPanel(
      FLEET_VIEW_TYPE, 'Fleet', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }

  /** The serializer's entry point: VS Code restored the tab, we re-attach. */
  restore(panel: vscode.WebviewPanel): void {
    // Clears this instance's own bookkeeping *before* asking the old panel to
    // dispose, rather than relying on its `onDidDispose` handler (below) to
    // do it — see `ReviewPanel.restore()` for why that ordering matters.
    const old = this.panel;
    if (old !== undefined) {
      this.panel = undefined;
      this.pendingFocus = undefined;
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
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.css'),
      ),
      title: 'Fleet',
    });

    const binding = bindSurface(panel.webview, this.connect, {
      // The router places the session; revealing the sidebar needs the vscode API.
      intercept: async (raw, link) => {
        if (raw?.t !== 'focus-session') { return false; }
        link.transport.post(raw);
        await vscode.commands.executeCommand('workbench.view.extension.mar-code');
        return true;
      },
      // Held until this panel's own hydrate arrives, which the target session is guaranteed to be inside.
      onHostMessage: (m) => {
        if (m.t === 'hydrate' && this.pendingFocus) {
          void panel.webview.postMessage({ t: 'fleet-focus-subagent', ...this.pendingFocus });
          this.pendingFocus = undefined;
        }
      },
    });

    const disposeSub = panel.onDidDispose(() => {
      // Guards against `onDidDispose` outliving the panel it was registered
      // for — see `ReviewPanel`'s identical guard.
      if (this.panel !== panel) { return; }
      this.panel = undefined;
      this.pendingFocus = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    });

    this.subscriptions = [binding, disposeSub];
  }

  dispose(): void {
    for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    this.panel?.dispose();
  }
}
