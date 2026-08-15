import * as assert from 'assert';
import { threadKey, threadKeyCwd } from '../../shared/thread-key';

suite('threadKey', () => {
  test('qualifies by directory under cwd scope', () => {
    assert.strictEqual(threadKey('claude', 'cwd', '/repo'), 'claude:/repo');
    assert.notStrictEqual(threadKey('claude', 'cwd', '/repo'), threadKey('claude', 'cwd', '/tree'));
  });

  test('ignores directory under global scope', () => {
    assert.strictEqual(threadKey('codex', 'global', '/repo'), 'codex');
    assert.strictEqual(threadKey('codex', 'global', '/repo'), threadKey('codex', 'global', '/tree'));
  });

  test('separates providers under both scopes', () => {
    assert.notStrictEqual(threadKey('claude', 'cwd', '/r'), threadKey('codex', 'cwd', '/r'));
    assert.notStrictEqual(threadKey('claude', 'global', '/r'), threadKey('codex', 'global', '/r'));
  });
});

suite('threadKeyCwd', () => {
  const providers = ['claude', 'codex'];

  test('reads back the directory a cwd-scoped key qualifies', () => {
    assert.strictEqual(threadKeyCwd(threadKey('claude', 'cwd', '/repo'), providers), '/repo');
  });

  test('a Windows path keeps its drive letter, colons and all', () => {
    const key = threadKey('codex', 'cwd', 'C:\\Users\\me\\repo');
    assert.strictEqual(threadKeyCwd(key, providers), 'C:\\Users\\me\\repo');
  });

  // The whole reason this function exists rather than a `split(':')` at each
  // call site: a global-scope key IS a bare provider id, and a sweep that
  // treated it as a path would offer to delete a directory called `codex`.
  test('a global-scope key names no directory at all', () => {
    assert.strictEqual(threadKeyCwd(threadKey('codex', 'global', '/repo'), providers), undefined);
  });

  test('a key for a provider this install does not have names no directory', () => {
    assert.strictEqual(threadKeyCwd('gemini:/repo', providers), undefined);
  });
});
