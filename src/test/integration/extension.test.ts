import * as assert from 'assert';
import * as vscode from 'vscode';
import { PanelViewProvider } from '../../host/panel-view-provider';
import type { EditorContextHost } from '../../host/message-router';
import type { SessionManager } from '../../host/session-manager';

suite('extension', () => {
  test('activates and registers the panel view', async () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.mar-code');
    assert.ok(ext, 'extension should be found');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('view container is contributed to the activity bar', () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.mar-code');
    const containers = ext!.packageJSON.contributes.viewsContainers.activitybar;
    assert.strictEqual(containers.length, 1);
    assert.strictEqual(containers[0].id, 'mar-code');
  });
});

suite('PanelViewProvider CSP', () => {
  // Minimal stub covering only what render() reads from vscode.Webview.
  function makeWebviewStub(): vscode.Webview {
    return {
      cspSource: 'vscode-webview://test-source',
      asWebviewUri: (uri: vscode.Uri) => uri,
    } as unknown as vscode.Webview;
  }

  const extensionUri = vscode.Uri.file(__dirname);
  // render() never touches the manager; these tests exercise only HTML
  // generation, so an untyped stub is sufficient.
  const managerStub = {} as unknown as SessionManager;
  const editorStub: EditorContextHost = {
    current: () => null, reveal: () => {}, openDiff: () => {}, openSettings: () => {},
    openExternal: () => {},
    exportCsv: () => {},
  };

  test('CSP contains default-src none', () => {
    const provider = new PanelViewProvider(
      extensionUri, managerStub, '/tmp', editorStub, undefined, undefined, () => {},
    );
    const html = provider.render(makeWebviewStub());
    assert.match(html, /default-src 'none'/);
  });

  test('CSP does not contain unsafe-inline or unsafe-eval', () => {
    const provider = new PanelViewProvider(
      extensionUri, managerStub, '/tmp', editorStub, undefined, undefined, () => {},
    );
    const html = provider.render(makeWebviewStub());
    assert.ok(!html.includes('unsafe-inline'), 'CSP should not contain unsafe-inline');
    assert.ok(!html.includes('unsafe-eval'), 'CSP should not contain unsafe-eval');
  });

  test('nonce in the CSP meta tag matches the nonce on the script tag', () => {
    const provider = new PanelViewProvider(
      extensionUri, managerStub, '/tmp', editorStub, undefined, undefined, () => {},
    );
    const html = provider.render(makeWebviewStub());

    const cspMatch = html.match(/Content-Security-Policy" content="[^"]*script-src 'nonce-([^']+)'/);
    const scriptMatch = html.match(/<script nonce="([^"]+)"/);

    assert.ok(cspMatch, 'CSP meta tag should contain a script-src nonce');
    assert.ok(scriptMatch, 'script tag should contain a nonce attribute');
    assert.strictEqual(cspMatch![1], scriptMatch![1]);
  });

  test('two separate renders produce different nonces', () => {
    const provider = new PanelViewProvider(
      extensionUri, managerStub, '/tmp', editorStub, undefined, undefined, () => {},
    );
    const first = provider.render(makeWebviewStub());
    const second = provider.render(makeWebviewStub());

    const firstNonce = first.match(/<script nonce="([^"]+)"/)![1];
    const secondNonce = second.match(/<script nonce="([^"]+)"/)![1];

    assert.notStrictEqual(firstNonce, secondNonce);
  });
});
