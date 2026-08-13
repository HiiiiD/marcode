import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

suite('dark variant', () => {
  test('dark: utilities key off the VS Code body class, not prefers-color-scheme', () => {
    execFileSync('node', ['esbuild.js'], { cwd: root, stdio: 'pipe' });
    const css = readFileSync(path.join(root, 'dist/webview.css'), 'utf8');

    assert.ok(
      css.includes('vscode-dark'),
      'expected the built CSS to gate dark: utilities on body.vscode-dark',
    );
    assert.ok(
      !/@media[^{]*prefers-color-scheme\s*:\s*dark/.test(css),
      'expected no prefers-color-scheme media query — the OS theme is not the VS Code theme',
    );
  });

  test('every color token has a fallback', () => {
    const src = readFileSync(path.join(root, 'src/webview/index.css'), 'utf8');
    const block = src.slice(src.indexOf(':root'), src.indexOf('@theme'));
    const bare = [...block.matchAll(/^\s*(--[a-z-]+):\s*var\((--vscode-[a-z-]+)\);/gim)];
    assert.deepStrictEqual(
      bare.map((m) => m[1]),
      [],
      'every --vscode-* lookup needs a fallback: var(--vscode-x, var(--vscode-y))',
    );
  });
});
