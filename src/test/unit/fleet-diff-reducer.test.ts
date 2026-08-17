// The client's fleet-diff slices. `fleetDiffDirty` is the whole freshness
// mechanism: the reducer counts the events that could have changed a diff,
// and the surface debounces a re-request off the count.

import * as assert from 'assert';
import { initialState, reduce } from '../../webview/reducer';
import type { TreeDiff } from '../../protocol/messages';

const TREE: TreeDiff = {
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc' },
  files: [{ path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
  omitted: 0,
};

suite('fleet diff reducer', () => {
  test('undefined until something answers', () => {
    assert.strictEqual(initialState.fleetDiff, undefined);
  });

  test('an answer replaces wholesale', () => {
    const once = reduce(initialState, { t: 'fleet-diff', trees: [TREE] });
    const twice = reduce(once, { t: 'fleet-diff', trees: [] });
    assert.deepStrictEqual(twice.fleetDiff, []);
  });

  test('an empty answer is not the same as no answer', () => {
    const state = reduce(initialState, { t: 'fleet-diff', trees: [] });
    assert.strictEqual(state.fleetDiff === undefined, false);
    assert.strictEqual(state.fleetDiff?.length, 0);
  });

  test('a settled file-edit tool marks the diff dirty', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 's1',
      patch: {
        op: 'replace',
        item: {
          id: 'i1', ts: 0, role: 'tool', toolId: 't1', state: 'ok',
          tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'a.ts', op: 'modify' }] },
        },
      },
    });
    assert.strictEqual(state.fleetDiffDirty, 1);
  });

  test('a command tool does not mark it dirty', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 's1',
      patch: {
        op: 'replace',
        item: {
          id: 'i1', ts: 0, role: 'tool', toolId: 't1', state: 'ok',
          tool: { kind: 'command', label: 'Bash', command: 'ls' },
        },
      },
    });
    assert.strictEqual(state.fleetDiffDirty, 0);
  });

  test('a session going idle marks it dirty, even with no pane', () => {
    const state = reduce(initialState, { t: 'session-status', id: 's1', status: 'idle' });
    assert.strictEqual(state.fleetDiffDirty, 1);
  });

  test('a session going busy does not', () => {
    const state = reduce(initialState, { t: 'session-status', id: 's1', status: 'running' });
    assert.strictEqual(state.fleetDiffDirty, 0);
  });

  test('a failed read is state, not an empty answer', () => {
    const state = reduce(initialState, {
      t: 'fleet-diff', trees: [], reason: 'Could not read the working trees: boom',
    });
    assert.strictEqual(state.fleetDiffReason, 'Could not read the working trees: boom');
  });

  test('a later good answer clears the failure', () => {
    const failed = reduce(initialState, { t: 'fleet-diff', trees: [], reason: 'boom' });
    const ok = reduce(failed, { t: 'fleet-diff', trees: [TREE] });
    assert.strictEqual(ok.fleetDiffReason, undefined);
  });

  test('hydrate clears the answer and the counter', () => {
    const dirty = reduce(
      reduce(initialState, { t: 'fleet-diff', trees: [TREE] }),
      { t: 'session-status', id: 's1', status: 'idle' },
    );
    const fresh = reduce(dirty, {
      t: 'hydrate', sessions: [], layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [], unavailable: [], usage: {},
    });
    assert.strictEqual(fresh.fleetDiff, undefined);
    assert.strictEqual(fresh.fleetDiffDirty, 0);
  });
});
