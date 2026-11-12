import * as assert from 'assert';
import { splitNestedMessages } from '../../webview/lib/nested-messages';
import type { TranscriptItem } from '../../protocol/messages';

const card = (child: string, text?: string): TranscriptItem => ({
  role: 'tool', id: `c-${child}`, ts: 1, toolId: 't', state: text ? 'ok' : 'running',
  output: text ? { kind: 'text', text } : undefined,
  tool: { kind: 'subagent', label: 'Subagent', action: 'spawn', childSessionId: child },
} as TranscriptItem);

const msg = (id: string, from?: string): TranscriptItem => ({
  role: 'user', id, ts: 2, text: 'hi', from: from ? { sessionId: from, name: from } : undefined,
} as TranscriptItem);

suite('splitNestedMessages', () => {
  test('a nested worker\'s message leaves the main chat and lands under its id', () => {
    const { main, byChild } = splitNestedMessages([card('w1'), msg('m1', 'w1'), msg('m2')]);
    assert.deepStrictEqual(main.map((i) => i.id), ['c-w1', 'm2']);
    assert.deepStrictEqual(byChild.get('w1')?.map((i) => i.id), ['m1']);
  });

  test('a message from a session with no card stays', () => {
    const { main } = splitNestedMessages([card('w1'), msg('m1', 'other')]);
    assert.strictEqual(main.length, 2);
  });

  test('a promoted worker keeps its messages in the chat', () => {
    const { main } = splitNestedMessages([card('w1', 'Opened as its own session "w1". It keeps running'), msg('m1', 'w1')]);
    assert.strictEqual(main.length, 2);
  });
});
