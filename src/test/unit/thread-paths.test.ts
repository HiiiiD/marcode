import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { rewriteThreadPaths } from '../../host/sync/thread-paths';

const win = { root: 'C:\\Users\\m\\repo', sep: '\\' as const };
const mac = { root: '/Users/m/repo', sep: '/' as const };
const linux = { root: '/home/m/repo', sep: '/' as const };
const winD = { root: 'D:\\work\\repo', sep: '\\' as const };

suite('rewriteThreadPaths', () => {
  test('Windows to POSIX, JSON-escaped, with the tail\'s separators converted', () => {
    const line = JSON.stringify({ file_path: 'C:\\Users\\m\\repo\\src\\a.ts' });
    assert.strictEqual(rewriteThreadPaths(line, win, mac), JSON.stringify({ file_path: '/Users/m/repo/src/a.ts' }));
  });

  test('POSIX to Windows, JSON-escaped', () => {
    const line = JSON.stringify({ cwd: '/home/m/repo/x/y.ts' });
    assert.strictEqual(rewriteThreadPaths(line, linux, winD), JSON.stringify({ cwd: 'D:\\work\\repo\\x\\y.ts' }));
  });

  test('a sibling folder that only shares the prefix, and a path outside the root, stay as they are', () => {
    const line = JSON.stringify({ a: '/home/m/repo2/z.ts', b: '/etc/hosts', c: 'see /home/m/repo-old' });
    assert.strictEqual(rewriteThreadPaths(line, linux, mac), line);
  });

  test('a drive letter in another case still matches, and so does a forward-slash spelling', () => {
    const line = JSON.stringify({ a: 'c:\\users\\m\\repo\\b.ts', b: 'C:/Users/m/repo/c.ts' });
    assert.strictEqual(rewriteThreadPaths(line, win, mac), JSON.stringify({ a: '/Users/m/repo/b.ts', b: '/Users/m/repo/c.ts' }));
  });

  test('the bare root is rewritten, and an escape after a path is kept', () => {
    const line = JSON.stringify({ cwd: 'C:\\Users\\m\\repo', text: 'edited C:\\Users\\m\\repo\\a.ts\nthen more' });
    assert.strictEqual(rewriteThreadPaths(line, win, mac), JSON.stringify({ cwd: '/Users/m/repo', text: 'edited /Users/m/repo/a.ts\nthen more' }));
  });

  test('text without the root comes back identical', () => {
    const line = JSON.stringify({ text: 'nothing to see', n: 3 });
    assert.strictEqual(rewriteThreadPaths(line, win, mac), line);
  });

  test('a path ends at a JSON escape or a comma, so the next path in the same string is judged on its own', () => {
    const toWin = { root: 'C:\\code\\repo', sep: '\\' as const };
    const line = JSON.stringify({ out: '/Users/m/repo/a.ts\n/Users/m/other/b.ts', list: '/Users/m/repo/a.ts,/etc/hosts' });
    assert.strictEqual(rewriteThreadPaths(line, mac, toWin), JSON.stringify({ out: 'C:\\code\\repo\\a.ts\n/Users/m/other/b.ts', list: 'C:\\code\\repo\\a.ts,/etc/hosts' }));
    const back = JSON.stringify({ out: 'C:\\Users\\m\\repo\\a.ts\nC:\\other\\b.ts' });
    assert.strictEqual(rewriteThreadPaths(back, win, mac), JSON.stringify({ out: '/Users/m/repo/a.ts\nC:\\other\\b.ts' }));
  });
});
