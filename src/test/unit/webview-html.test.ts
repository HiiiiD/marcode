import * as assert from 'node:assert';
import { renderWebviewHtml, type HtmlWebview } from '../../host/webview-html';

const webview: HtmlWebview = { cspSource: 'vscode-webview://x' };

suite('renderWebviewHtml', () => {
  test('pins default-src none and a per-load nonce', () => {
    const a = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });
    const b = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });

    assert.strictEqual(a.includes("default-src 'none'"), true);
    assert.strictEqual(a.includes("script-src 'nonce-"), true);
    // Two loads, two nonces. A reused nonce is a nonce that is not one.
    const nonceOf = (html: string) => /nonce-([A-Za-z0-9_-]+)/.exec(html)?.[1];
    assert.strictEqual(nonceOf(a) === nonceOf(b), false);
  });

  test('loads no remote resources', () => {
    const html = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });
    assert.strictEqual(/https?:\/\//.test(html), false);
  });

  test('carries the attachment base only when given one', () => {
    const withBase = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'a.js' }, styleUri: { toString: () => 'a.css' },
      title: 'x', attachmentBase: 'wv:/store',
    });
    const without = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'a.js' }, styleUri: { toString: () => 'a.css' }, title: 'x',
    });
    assert.strictEqual(withBase.includes('data-attachment-base="wv:/store"'), true);
    assert.strictEqual(without.includes('data-attachment-base=""'), true);
  });

  const base = {
    scriptUri: { toString: () => 'dist/review.js' },
    styleUri: { toString: () => 'dist/review.css' },
    title: 'Changes',
  };

  test('no theme css means no style tag', () => {
    assert.strictEqual(renderWebviewHtml(webview, base).includes('<style'), false);
    assert.strictEqual(renderWebviewHtml(webview, { ...base, themeCss: '' }).includes('<style'), false);
  });

  test('theme css rides a nonce style tag after the stylesheet, under the same nonce as style-src', () => {
    const html = renderWebviewHtml(webview, { ...base, themeCss: ':root{--primary:#ffffff}' });
    const nonce = /style-src [^;]*'nonce-([A-Za-z0-9_-]+)'/.exec(html)?.[1];
    assert.notStrictEqual(nonce, undefined);
    assert.strictEqual(html.includes(`<style nonce="${nonce}">:root{--primary:#ffffff}</style>`), true);
    assert.strictEqual(html.indexOf('rel="stylesheet"') < html.indexOf('<style nonce'), true);
    assert.strictEqual(html.includes("style-src vscode-webview://x 'nonce-"), true);
  });
});
