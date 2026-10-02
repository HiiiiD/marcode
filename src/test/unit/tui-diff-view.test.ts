import * as assert from 'node:assert';
import { diffView, hunksAreWellFormed, SPLIT_MIN_WIDTH } from '../../tui/ui/transcript/diff-view';
import { filetypeOf } from '../../tui/ui/transcript/filetype';

suite('tui diff: view choice', () => {
  test('narrow and unmeasured panes are unified, wide ones are split', () => {
    assert.strictEqual(diffView(0), 'unified');
    assert.strictEqual(diffView(SPLIT_MIN_WIDTH - 1), 'unified');
    assert.strictEqual(diffView(SPLIT_MIN_WIDTH), 'split');
  });
});

suite('tui diff: hunksAreWellFormed', () => {
  test('a single hunk with matching counts is accepted, headers or not', () => {
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\n-old\n+new'), true);
    assert.strictEqual(hunksAreWellFormed('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n'), true);
  });

  test('two hunks and the no-newline marker are accepted', () => {
    const d = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10 @@\n-x\n+y\n\\ No newline at end of file';
    assert.strictEqual(hunksAreWellFormed(d), true);
  });

  test('a count mismatch is rejected', () => {
    assert.strictEqual(hunksAreWellFormed('@@ -1,3 +1,3 @@\n-old\n+new'), false);
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\n-old\n+new\n+extra'), false);
  });

  test('no hunk header, or a stray non-diff line inside a hunk, is rejected', () => {
    assert.strictEqual(hunksAreWellFormed('-old\n+new'), false);
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\nxyz'), false);
    assert.strictEqual(hunksAreWellFormed(''), false);
  });
});

suite('tui diff: filetypeOf', () => {
  test('maps extensions the bundled parsers understand', () => {
    assert.strictEqual(filetypeOf('/a/b.ts'), 'typescript');
    assert.strictEqual(filetypeOf('C:\\a\\B.TSX'), 'typescript');
    assert.strictEqual(filetypeOf('x.mjs'), 'javascript');
    assert.strictEqual(filetypeOf('README.md'), 'markdown');
  });

  test('unknown, extensionless and missing paths are undefined', () => {
    assert.strictEqual(filetypeOf('Makefile'), undefined);
    assert.strictEqual(filetypeOf('a.rs'), undefined);
    assert.strictEqual(filetypeOf(undefined), undefined);
  });
});
