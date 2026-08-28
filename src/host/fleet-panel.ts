import * as vscode from 'vscode';
import { MessageRouter, type EditorContextHost } from './message-router';
import { PostBus, FLEET_WANTS } from './post-bus';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { WebviewToHost } from '../protocol/messages';
// Cross-import from the webview tree into the host bundle: verified safe.
// `pane-layout.ts` has zero imports of its own (no `vscode`, no DOM, no
// React — see its own header comment, which keeps it dependency-free on
// purpose so the mocha unit-test harness can require it directly), so it
// carries nothing the CJS/node `hostCtx` esbuild target can't resolve.
// `PaneLayout`'s `sessionId: SessionId` is a plain `string` alias, so the
// structural `LayoutLike` this returns is assignable to it without a cast.
import { evenlySizedPanes } from '../webview/components/pane-layout';

export const FLEET_VIEW_TYPE = 'mar-code.fleet';

/**
 * The fleet-wide view: every roster session's live status and activity, in
 * an editor tab, mirroring `ReviewPanel`'s architecture exactly — its own
 * `WebviewPanel`, its own `PostBus` registration, its own `MessageRouter`.
 * At most one; `open()` reveals a live panel rather than making a second.
 */
export class FleetPanel {
  private panel: vscode.WebviewPanel | undefined;
  private unregister: (() => void) | undefined;
  /** Every subscription `adopt()` makes on the current `panel` — tracked and
   * disposed together with it, the same discipline `ReviewPanel` applies. */
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
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.css'),
      ),
      title: 'Fleet',
    });

    this.unregister = this.bus.add({
      post: (msg) => { void panel.webview.postMessage(msg); },
      wants: FLEET_WANTS,
    });

    const router = new MessageRouter(
      this.manager, (m) => { void panel.webview.postMessage(m); },
      this.defaultCwd, this.editor,
    );
    const messageSub = panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // Same precedent as PanelViewProvider's open-file/open-review
        // intercepts: this needs the vscode API MessageRouter must not
        // import.
        if (raw?.t === 'focus-session') {
          const ids = this.manager.layout().panes.map((p) => p.sessionId);
          if (!ids.includes(raw.id)) {
            await this.manager.setVisible([...ids, raw.id]);
            this.manager.setLayout(
              evenlySizedPanes([...ids, raw.id], this.manager.layout().orientation),
            );
          }
          await vscode.commands.executeCommand('workbench.view.extension.mar-code');
          return;
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[mar-code] fleet message handling failed', err);
      }
    });

    const disposeSub = panel.onDidDispose(() => {
      // Guards against `onDidDispose` outliving the panel it was registered
      // for — see `ReviewPanel`'s identical guard.
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
