import * as assert from 'assert';
import { threadKey } from '../../shared/thread-key';

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
