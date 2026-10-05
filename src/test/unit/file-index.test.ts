import * as assert from 'assert';
import { matchFiles } from '../../host/file-index';

suite('matchFiles', () => {
  test('matches by substring anywhere in the path, case-insensitively', () => {
    const rows = matchFiles(['src/webview/composer.tsx', 'src/host/session-manager.ts'], 'COMPOSER');
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0], { path: 'src/webview/composer.tsx', name: 'composer.tsx' });
  });

  test('matches by basename as well as full path', () => {
    const rows = matchFiles(['a/b/foo.ts', 'c/bar.ts'], 'foo');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].path, 'a/b/foo.ts');
  });

  test('empty query returns nothing — @ alone should not dump the whole tree', () => {
    assert.deepStrictEqual(matchFiles(['a.ts', 'b.ts'], ''), []);
  });

  test('ranks a basename match ahead of a path-only match', () => {
    const rows = matchFiles(['src/foo/other.ts', 'src/other/foo.ts'], 'foo');
    assert.strictEqual(rows[0].path, 'src/other/foo.ts');
  });

  test('caps results at the limit', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
    const rows = matchFiles(paths, 'file', 20);
    assert.strictEqual(rows.length, 20);
  });
});

suite('matchFiles fuzzy fallback', () => {
  test('a scattered subsequence still matches', () => {
    assert.deepStrictEqual(matchFiles(['src/webview/composer.tsx', 'src/host/x.ts'], 'cmpsr').map((r) => r.path), ['src/webview/composer.tsx']);
  });

  test('a contiguous match outranks a scattered one', () => {
    const rows = matchFiles(['src/c-o-m-p.ts', 'src/compose.ts'], 'comp');
    assert.strictEqual(rows[0].path, 'src/compose.ts');
  });

  test('a basename-start match outranks a mid-word one and a shorter path breaks ties', () => {
    const rows = matchFiles(['a/xfoo.ts', 'a/foo-long-name.ts', 'a/foo.ts'], 'foo');
    assert.deepStrictEqual(rows.map((r) => r.path), ['a/foo.ts', 'a/foo-long-name.ts', 'a/xfoo.ts']);
  });

  test('a path with no subsequence does not match', () => {
    assert.deepStrictEqual(matchFiles(['src/host/x.ts'], 'zzz'), []);
  });
});
