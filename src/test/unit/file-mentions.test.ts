import * as assert from 'assert';
import { fileMentions, fileRefsOf, type FileMentionPayload } from '../../webview/lib/file-mentions';
import type { PendingMention } from '../../webview/lib/mention-menu';
import type { SessionMentionPayload } from '../../webview/lib/session-mentions';

suite('file mentions', () => {
  test('one row per file, grouped under Files', () => {
    const rows = fileMentions([{ path: 'src/a.ts', name: 'a.ts' }, { path: 'src/b.ts', name: 'b.ts' }]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.every((r) => r.group === 'Files'), true);
    assert.strictEqual(rows.every((r) => r.payload.kind === 'file-ref'), true);
  });

  test('the base token is the path, so the token typed in the box is the real path', () => {
    const rows = fileMentions([{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }]);
    assert.strictEqual(rows[0].baseToken, 'src/webview/composer.tsx');
  });

  test('the label is the basename, so the row reads like a filename in the list', () => {
    const rows = fileMentions([{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }]);
    assert.strictEqual(rows[0].label, 'composer.tsx');
  });

  test('the hint carries the containing directory', () => {
    const rows = fileMentions([{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }]);
    assert.strictEqual(rows[0].hint, 'src/webview');
  });

  test('a file at the workspace root has no directory hint', () => {
    const rows = fileMentions([{ path: 'README.md', name: 'README.md' }]);
    assert.strictEqual(rows[0].hint, '');
  });

  test('carries the ref for the composer to send on pick', () => {
    const rows = fileMentions([{ path: 'src/a.ts', name: 'a.ts' }]);
    const payload = rows[0].payload as FileMentionPayload;
    assert.deepStrictEqual(payload.ref, { path: 'src/a.ts', name: 'a.ts' });
  });

  test('fileRefsOf keeps only the file-ref payloads, in order', () => {
    const pending: PendingMention<SessionMentionPayload | FileMentionPayload>[] = [
      { token: '@src/a.ts', payload: { kind: 'file-ref', ref: { path: 'src/a.ts', name: 'a.ts' } } },
      { token: '@handoff', payload: { kind: 'action', action: 'handoff' } },
      { token: '@src/b.ts', payload: { kind: 'file-ref', ref: { path: 'src/b.ts', name: 'b.ts' } } },
    ];
    const refs = fileRefsOf(pending);
    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].path, 'src/a.ts');
    assert.strictEqual(refs[1].path, 'src/b.ts');
  });
});
