import * as assert from 'assert';
import { Profiler } from 'react';
import { TranscriptItemView } from '@/components/transcript-item';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderWithStore, sendFromHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

const ITEM: TranscriptItem = { id: 'a1', ts: 1, role: 'assistant', text: 'hello **world**' };

// The element is built once, so React skips the subtree on a parent re-render
// and only a context subscription inside the item can wake it.
function mount(onRender: () => void) {
  const element = (
    <Profiler id="item" onRender={onRender}>
      <TranscriptItemView item={ITEM} sessionId="a" />
    </Profiler>
  );
  return function Host() { return element; };
}

suite('transcript item re-render fan-out', () => {
  test('a state change elsewhere does not re-render an unchanged item', () => {
    let renders = 0;
    const Host = mount(() => { renders += 1; });
    renderWithStore(<Host />);
    const afterMount = renders;

    sendFromHost({
      t: 'hydrate',
      sessions: [summary('b')],
      layout: layoutOf(['b']),
      snapshots: [snapshot('b', { items: [{ id: 'x', ts: 1, role: 'user', text: 'hi' }] })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });
    sendFromHost({
      t: 'session-patch', id: 'b', patch: { op: 'delta', itemId: 'x', text: 'more' },
    } as never);

    assert.strictEqual(renders, afterMount);
  });
});
