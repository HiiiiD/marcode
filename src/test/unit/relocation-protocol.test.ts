import * as assert from 'assert';
import type { TranscriptItem, WebviewToHost } from '../../protocol/messages';

suite('relocation protocol', () => {
  test('a relocation item carries a path and a state', () => {
    const item: TranscriptItem = {
      id: 'r1', ts: 1, role: 'relocation',
      path: '/repo/../trees/feat-x', state: 'pending',
    };
    assert.strictEqual(item.role === 'relocation' && item.state, 'pending');
  });

  test('answering carries the session, the item and the choice', () => {
    const msg: WebviewToHost = {
      t: 'answer-relocation', id: 's-1', itemId: 'r1', move: true,
    };
    assert.strictEqual(msg.t === 'answer-relocation' && msg.move, true);
  });
});
