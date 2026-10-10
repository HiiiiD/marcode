import * as vscode from 'vscode';
import { requestAttachmentPath } from '../client-core/attachment-request';
import type { AgentsMdNudgeController } from './agents-md-nudge';
import { bindSurface, type SurfaceBinding } from './bind-surface';
import { trackLayout } from './layout-cache';
import type { SurfaceLink } from './surface-link';
import { renderWebviewHtml } from './webview-html';
import type { HostToWebview, PaneLayout, SessionId } from '../protocol/messages';

export interface SidebarActions {
  openReview(): void;
  openHistory(): void;
  openFleet(focus?: { sessionId: SessionId; itemId: string }): void;
}

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mar-code.panel';
  private view: vscode.WebviewView | undefined;
  private binding: SurfaceBinding | undefined;
  private layoutCache: ReturnType<typeof trackLayout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connect: () => Promise<SurfaceLink>,
    /** Pasted attachments are previewed from disk, so this joins `dist` as a resource root. */
    private readonly attachmentsBaseDir: string,
    private readonly actions: SidebarActions,
    private readonly agentsMdNudge?: AgentsMdNudgeController,
    /** A VS Code setting the daemon cannot see, so it is stamped onto `hydrate` here. Reload to change. */
    private readonly showCacheTimer: boolean = false,
  ) {}

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /** The editor chip tracks the active file; the daemon needs the same value for sends. */
  pushContext(ctx: unknown): void {
    this.post({ t: 'editor-context', ctx: ctx as never });
    this.binding?.link()?.pushContext(ctx);
  }

  layout(): PaneLayout | undefined {
    return this.layoutCache?.current();
  }

  private async openAttachment(link: SurfaceLink, ref: { id: string; attachmentId: string; itemId?: string }): Promise<void> {
    const path = await requestAttachmentPath(link.transport, ref);
    if (!path) { return; }
    try {
      // `vscode.open` picks the right editor: the image viewer for a screenshot, a text editor otherwise.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
    } catch (err) {
      console.error('[mar-code] could not open attachment', path, err);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.file(this.attachmentsBaseDir),
      ],
    };
    view.webview.html = this.render(view.webview);

    const binding = bindSurface(view.webview, this.connect, {
      intercept: async (raw, link) => {
        switch (raw?.t) {
          case 'open-attachment': await this.openAttachment(link, raw); return true;
          case 'open-review': this.actions.openReview(); return true;
          case 'open-history': this.actions.openHistory(); return true;
          case 'open-fleet': this.actions.openFleet(); return true;
          case 'open-fleet-subagent': this.actions.openFleet({ sessionId: raw.sessionId, itemId: raw.itemId }); return true;
          case 'agents-md-nudge-action': await this.agentsMdNudge?.handleAction(raw.action, raw.dirs); return true;
          case 'ready':
            // A lost link drops this ready, and the webview has no state to show why until told.
            if (link.status() !== 'connected') { this.post({ t: 'host-link', status: link.status() }); }
            return false;
          default: return false;
        }
      },
      onHostMessage: (m) => (m.t === 'hydrate' ? { ...m, showCacheTimer: this.showCacheTimer } : undefined),
      // hydrate resets the nudge card, so the hits go out again after every one (reloads and reconnects included).
      afterHostMessage: (m) => { if (m.t === 'hydrate') { void this.agentsMdNudge?.resend(); } },
      onLink: (link) => {
        const cache = trackLayout(link.transport.onMessage);
        this.layoutCache = cache;
        const offStatus = link.onStatus((status) => { this.post({ t: 'host-link', status }); });
        return () => { offStatus(); cache.dispose(); };
      },
    });
    this.binding = binding;

    // One scan per activate/reload, not a live watcher — see agents-md-nudge.ts.
    void this.agentsMdNudge?.scan();

    view.onDidDispose(() => {
      if (this.binding === binding) { this.binding = undefined; this.layoutCache = undefined; this.view = undefined; }
      binding.dispose();
    });
  }

  render(webview: vscode.Webview): string {
    return renderWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
      ),
      styleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
      ),
      title: 'Marcode',
      attachmentBase: webview.asWebviewUri(vscode.Uri.file(this.attachmentsBaseDir)).toString(),
    });
  }
}
