import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { promptHistory } from '../../webview/lib/prompt-history';
import type { TranscriptItem } from '../../protocol/messages';

const user = (text: string, extra: object = {}): TranscriptItem =>
  ({ id: text, ts: 0, role: 'user', text, ...extra }) as TranscriptItem;
const agent = (text: string): TranscriptItem =>
  ({ id: text, ts: 0, role: 'assistant', text }) as TranscriptItem;

suite('promptHistory', () => {
  test('newest first, user turns only', () => {
    assert.deepStrictEqual(
      promptHistory([user('one'), agent('a'), user('two')]),
      ['two', 'one'],
    );
  });

  test('skips blank, cross-session and consecutive duplicate prompts', () => {
    assert.deepStrictEqual(
      promptHistory([
        user('one'), user('one'), user('   '),
        user('from elsewhere', { from: { sessionId: 's2', name: 'x' } }),
        user('two'),
      ]),
      ['two', 'one'],
    );
  });

  test('strips resolved reference blocks appended to the prose', () => {
    const composed = 'look at @a\n\n--- file from a.ts ---\nbody\n--- end file from a.ts ---';
    assert.deepStrictEqual(
      promptHistory([user(composed, { fileRefs: [{ path: 'a.ts' }] })]),
      ['look at @a'],
    );
  });
});
