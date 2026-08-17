import * as vscode from 'vscode';
import type { AttachmentStore } from './attachment-store';
import { MessageRouter, type AttachmentHost, type EditorContextHost } from './message-router';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { HostToWebview, SessionId, WebviewToHost } from '../protocol/messages';

const NO_PICKER: AttachmentHost = { pick: async () => [] };

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hiiiid-code.panel';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
    private readonly attachments?: AttachmentStore,
    private readonly picker: AttachmentHost = NO_PICKER,
    private readonly onOpenReview: () => void = () => {},
  ) {}

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /**
   * Best-effort: the path comes from a provider's context report and can
   * name a file that has since moved or that this window cannot read. A
   * failed open is logged, never surfaced as an error dialog — the user
   * asked to peek at a memory file, not to run a command.
   *
   * The path is checked against the memory-file set the named session most
   * recently reported before anything is opened. `Uri.file` already pins
   * the scheme, so this is not about command escalation; it is that a path
   * arriving over `postMessage` has no relationship to anything the host
   * has seen, and a buggy or compromised provider must not be able to get
   * an arbitrary file on disk opened in an editor.
   */
  private async openFile(id: SessionId, path: string): Promise<void> {
    if (!this.manager.canOpenFile(id, path)) {
      console.error('[hiiiid-code] refusing to open a path this session never reported', path);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      console.error('[hiiiid-code] could not open', path, err);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // The attachment store joins `dist` as a root so a pasted screenshot can
      // be previewed from disk instead of having its bytes re-sent as a data
      // URL on every render. Still local-only: this widens the roots by one
      // directory the extension itself owns, and the CSP is untouched.
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        ...(this.attachments ? [vscode.Uri.file(this.attachments.baseDir)] : []),
      ],
    };
    view.webview.html = this.render(view.webview);

    const router = new MessageRouter(
      this.manager, (m) => this.post(m), this.defaultCwd, this.editor, this.attachments, this.picker,
    );
    view.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // `open-file` is the one message needing the `vscode` API, which
        // MessageRouter must not import (it is unit-tested outside the
        // extension host). Intercept it here rather than widening the
        // router's dependencies.
        if (raw?.t === 'open-file') {
          await this.openFile(raw.id, raw.path);
          return;
        }
        if (raw?.t === 'open-review') {
          this.onOpenReview();
          return;
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] message handling failed', err);
      }
    });

    view.onDidDispose(() => { this.view = undefined; });
  }

  render(webview: vscode.Webview): string {
    return renderWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
      ),
      styleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
      ),
      title: 'HiiiiD Code',
      attachmentBase: this.attachments
        ? webview.asWebviewUri(vscode.Uri.file(this.attachments.baseDir)).toString()
        : '',
    });
  }
}
