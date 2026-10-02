import * as assert from 'node:assert';
import { activeRelocation, relocationCard, relocationMessage } from '../../tui/view/relocation-view';
import { folderName } from '../../client-core/folder-name';
import { relocation } from '../fixtures/protocol';

suite('relocation-view: activeRelocation', () => {
  test('the newest pending or queued item is addressable, settled ones never are', () => {
    const items = [
      relocation({ id: 'r1', state: 'pending' }),
      relocation({ id: 'r2', state: 'moved' }),
      relocation({ id: 'r3', state: 'queued' }),
      relocation({ id: 'r4', state: 'stayed' }),
    ];
    assert.strictEqual(activeRelocation(items)?.id, 'r3');
    assert.strictEqual(activeRelocation([relocation({ state: 'moved' }), relocation({ id: 'x', state: 'stayed' })]), undefined);
    assert.strictEqual(activeRelocation([]), undefined);
  });
  test('an older pending offer loses to a newer one', () => {
    assert.strictEqual(activeRelocation([relocation({ id: 'a' }), relocation({ id: 'b' })])?.id, 'b');
  });
});

suite('relocation-view: relocationMessage', () => {
  test('pending: move and stay answer the offer', () => {
    assert.deepStrictEqual(relocationMessage('s1', relocation({ id: 'r1' }), 'move'), { t: 'answer-relocation', id: 's1', itemId: 'r1', move: true });
    assert.deepStrictEqual(relocationMessage('s1', relocation({ id: 'r1' }), 'stay'), { t: 'answer-relocation', id: 's1', itemId: 'r1', move: false });
  });
  test('queued: stay cancels, move does nothing', () => {
    const q = relocation({ id: 'r1', state: 'queued' });
    assert.deepStrictEqual(relocationMessage('s1', q, 'stay'), { t: 'cancel-relocation', id: 's1', itemId: 'r1' });
    assert.strictEqual(relocationMessage('s1', q, 'move'), undefined);
  });
  test('settled items post nothing', () => {
    for (const state of ['moved', 'stayed'] as const) {
      assert.strictEqual(relocationMessage('s1', relocation({ state }), 'move'), undefined);
      assert.strictEqual(relocationMessage('s1', relocation({ state }), 'stay'), undefined);
    }
  });
});

suite('relocation-view: card name', () => {
  test('the folder name survives odd paths and never goes blank', () => {
    assert.strictEqual(relocationCard(relocation({ path: '/repo/trees/feat-x' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: '/repo/trees/feat-x/' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: 'C:\\repo\\trees\\feat-x' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: '' })).name, 'worktree');
    assert.strictEqual(relocationCard(relocation({ path: '/' })).name, '/');
  });
  test('folderName is the webview helper, moved', () => {
    assert.strictEqual(folderName('/a/b'), 'b');
  });
});
