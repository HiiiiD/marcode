import * as assert from 'assert';
import { beatOf, gapAbove } from '../../webview/lib/rhythm';
import { tool } from '../fixtures/protocol';

suite('transcript rhythm', () => {
  test('machinery packs tight, prose is set off 16px from a run on both sides', () => {
    assert.strictEqual(gapAbove('machine', 'machine'), 'mt-0.5');
    assert.strictEqual(gapAbove('machine', 'prose'), 'mt-4');
    assert.strictEqual(gapAbove('prose', 'machine'), 'mt-4');
  });

  test('the first item has no gap above it and the user turn gets the most room', () => {
    assert.strictEqual(gapAbove(undefined, 'prose'), '');
    assert.strictEqual(gapAbove('prose', 'user'), 'mt-6');
  });

  test('classifies items by what they are to the eye', () => {
    assert.strictEqual(beatOf(tool()), 'machine');
    assert.strictEqual(beatOf({ id: 'a', ts: 1, role: 'assistant', text: 'x' }), 'prose');
    assert.strictEqual(beatOf({ id: 'u', ts: 1, role: 'user', text: 'x' }), 'user');
    assert.strictEqual(beatOf(undefined), undefined);
  });
});
