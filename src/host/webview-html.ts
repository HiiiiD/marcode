import { randomBytes } from 'node:crypto';

/**
 * The one `vscode.Webview` member this needs, named structurally so the
 * renderer is unit-testable without the extension host. A real `Webview`
 * satisfies it. Callers resolve their script/style/attachment URIs to
 * strings (via `asWebviewUri`) before calling in, so that member has no
 * place on this interface.
 */
export interface HtmlWebview {
  readonly cspSource: string;
}

export interface WebviewHtmlOptions {
  scriptUri: { toString(): string };
  styleUri: { toString(): string };
  title: string;
  /** Empty when the surface has no attachment store — the review tab has none. */
  attachmentBase?: string;
}

/**
 * One CSP for every surface in this extension.
 *
 * Extracted the moment there was a second webview rather than copied: a
 * hand-copied CSP stays correct exactly until the day one of the two is
 * edited, and the failure is silent in the copy nobody looked at.
 */
export function renderWebviewHtml(webview: HtmlWebview, opts: WebviewHtmlOptions): string {
  const nonce = randomBytes(16).toString('base64url');
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
<link href="${opts.styleUri.toString()}" rel="stylesheet">
<title>${opts.title}</title>
</head>
<body>
<div id="root" data-attachment-base="${opts.attachmentBase ?? ''}"></div>
<script nonce="${nonce}" src="${opts.scriptUri.toString()}"></script>
</body>
</html>`;
}
