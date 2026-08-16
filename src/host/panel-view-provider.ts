import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AttachmentStore } from './attachment-store';
import { MessageRouter, type AttachmentHost, type EditorContextHost } from './message-router';
import type { SessionManager } from './session-manager';
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
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
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
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] message handling failed', err);
      }
    });

    view.onDidDispose(() => { this.view = undefined; });
  }

  render(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>HiiiiD Code</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64url');
}
