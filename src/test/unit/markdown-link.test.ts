import * as assert from 'assert';
import { classifyHref } from '../../webview/components/markdown-link';

suite('classifyHref', () => {
  test('an http(s) href is external', () => {
    assert.deepStrictEqual(
      classifyHref('https://example.test/a?b=1#c'),
      { kind: 'external', url: 'https://example.test/a?b=1#c' },
    );
    assert.deepStrictEqual(
      classifyHref('http://example.test'),
      { kind: 'external', url: 'http://example.test' },
    );
  });

  test('a non-http scheme is still external', () => {
    assert.deepStrictEqual(
      classifyHref('mailto:a@b.test'),
      { kind: 'external', url: 'mailto:a@b.test' },
    );
  });

  // We never set an href, so this cannot navigate the webview — but it would
  // otherwise be handed to `vscode.env.openExternal`, which resolves it
  // outside our process. A script URL is not a destination.
  test('a script-bearing scheme is not a link at all', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
      assert.deepStrictEqual(classifyHref(href), { kind: 'none' }, href);
    }
  });

  test('a relative path is a file', () => {
    assert.deepStrictEqual(
      classifyHref('src/host/agent-session.ts'),
      { kind: 'file', path: 'src/host/agent-session.ts', startLine: undefined },
    );
  });

  test('a posix absolute path is a file', () => {
    assert.deepStrictEqual(
      classifyHref('/repo/src/a.ts'),
      { kind: 'file', path: '/repo/src/a.ts', startLine: undefined },
    );
  });

  // `e:` parses as a one-letter URI scheme, so a naive scheme test sends every
  // Windows absolute path to the browser.
  test('a windows drive path is a file, not a one-letter scheme', () => {
    assert.deepStrictEqual(
      classifyHref('e:\\Efebia\\hiiiid-code\\src\\a.ts'),
      { kind: 'file', path: 'e:\\Efebia\\hiiiid-code\\src\\a.ts', startLine: undefined },
    );
    assert.deepStrictEqual(
      classifyHref('C:/repo/a.ts'),
      { kind: 'file', path: 'C:/repo/a.ts', startLine: undefined },
    );
  });

  test('a #L suffix is a start line', () => {
    assert.deepStrictEqual(
      classifyHref('src/a.ts#L42'),
      { kind: 'file', path: 'src/a.ts', startLine: 42 },
    );
  });

  test('a trailing :line suffix is a start line', () => {
    assert.deepStrictEqual(
      classifyHref('src/a.ts:601'),
      { kind: 'file', path: 'src/a.ts', startLine: 601 },
    );
  });

  test('a drive path keeps its colon and still takes a line suffix', () => {
    assert.deepStrictEqual(
      classifyHref('e:\\repo\\a.ts:12'),
      { kind: 'file', path: 'e:\\repo\\a.ts', startLine: 12 },
    );
  });

  test('percent-encoded spaces are decoded before the path reaches the host', () => {
    assert.deepStrictEqual(
      classifyHref('src/my%20file.ts'),
      { kind: 'file', path: 'src/my file.ts', startLine: undefined },
    );
  });

  test('a malformed escape is left as authored rather than throwing', () => {
    assert.deepStrictEqual(
      classifyHref('src/100%.ts'),
      { kind: 'file', path: 'src/100%.ts', startLine: undefined },
    );
  });

  test('an in-document anchor is not a link this panel can service', () => {
    assert.deepStrictEqual(classifyHref('#section'), { kind: 'none' });
  });

  test('an absent or empty href is not a link', () => {
    assert.deepStrictEqual(classifyHref(undefined), { kind: 'none' });
    assert.deepStrictEqual(classifyHref(''), { kind: 'none' });
    assert.deepStrictEqual(classifyHref('   '), { kind: 'none' });
  });
});
