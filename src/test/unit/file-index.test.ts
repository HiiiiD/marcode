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
