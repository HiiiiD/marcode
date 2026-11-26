import * as assert from 'assert';
import { beatOf, gapAbove } from '../../webview/lib/rhythm';
import { tool } from '../fixtures/protocol';

suite('transcript rhythm', () => {
  test('machinery packs tight, prose is set off 16px from a run on both sides', () => {
    assert.strictEqual(gapAbove('machine', 'machine'), 'mt-0.5');
    assert.strictEqual(gapAbove('machine', 'prose'), 'mt-2');
    assert.strictEqual(gapAbove('prose', 'machine'), 'mt-1.5');
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

suite('rhythm of an assistant item that opens with reasoning', () => {
  const withThinking = { id: 'a', ts: 1, role: 'assistant' as const, text: 'Done.', thinking: 'hm' };

  test('its first beat is machinery and its last is prose, so reasoning packs with the tool rows above it', () => {
    assert.strictEqual(beatOf(withThinking, 'first'), 'machine');
    assert.strictEqual(beatOf(withThinking, 'last'), 'prose');
    assert.strictEqual(gapAbove('machine', beatOf(withThinking, 'first')!), 'mt-0.5');
  });

  test('reasoning with no text yet is machinery at both ends', () => {
    assert.strictEqual(beatOf({ ...withThinking, text: '' }, 'last'), 'machine');
  });
});
