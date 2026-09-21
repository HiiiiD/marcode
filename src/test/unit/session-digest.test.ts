import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { digestSession } from '../../memory/session-digest';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'user', text });
const reply = (id: string, text: string): TranscriptItem => ({ id, ts: 2, role: 'assistant', text });
const edit = (id: string, ...paths: string[]): TranscriptItem => ({
  id, ts: 3, role: 'tool', toolId: id, state: 'ok',
  tool: { kind: 'file-edit', label: 'Edit', files: paths.map((path) => ({ path, op: 'modify' as const })) },
});

suite('digestSession', () => {
  test('goal, last reply and distinct files edited', () => {
    const out = digestSession([
      user('1', 'Fix the flaky   login test'),
      reply('2', 'Looking into it'),
      edit('3', '/r/a.ts', '/r/b.ts'),
      edit('4', '/r/a.ts'),
      reply('5', 'Fixed by awaiting the redirect.'),
    ]);
    assert.strictEqual(out, 'Fix the flaky login test → Fixed by awaiting the redirect. · 2 files edited');
  });

  test('no reply and no edits is just the goal', () => {
    assert.strictEqual(digestSession([user('1', 'Hello')]), 'Hello');
  });

  test('one file uses the singular', () => {
    assert.strictEqual(digestSession([user('1', 'x'), edit('2', '/r/a.ts')]), 'x · 1 file edited');
  });

  test('long goal and reply are truncated', () => {
    const out = digestSession([user('1', 'g'.repeat(500)), reply('2', 'r'.repeat(500))]);
    assert.strictEqual(out.includes('…'), true);
    assert.strictEqual(out.length < 400, true);
  });

  test('empty transcript digests to an empty string', () => {
    assert.strictEqual(digestSession([]), '');
  });
});
