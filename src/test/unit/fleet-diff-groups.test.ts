// Turning the flat wire payload into the tree → session → files shape the
// user reads. Pure: no React, no DOM, no store.

import * as assert from 'assert';
import { groupTree, summarize } from '../../webview/components/fleet-diff-groups';
import type { FileChange, TreeDiff } from '../../protocol/messages';

function file(path: string, claimedBy: string[], ins = 1, del = 0): FileChange {
  return { path, op: 'modify', insertions: ins, deletions: del, claimedBy };
}

function tree(files: FileChange[], sessions = ['s1', 's2']): TreeDiff {
  return {
    root: '/repo', branch: 'main', sessions,
    base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc' },
    files, omitted: 0,
  };
}

suite('fleet diff grouping', () => {
  test('a file lands under the session that claimed it', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'])]));
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].sessionId, 's1');
    assert.strictEqual(groups[0].files.length, 1);
  });

  test('an unclaimed file lands in the unattributed group, which sorts last', () => {
    const groups = groupTree(tree([file('none.ts', []), file('a.ts', ['s1'])]));
    assert.strictEqual(groups[groups.length - 1].sessionId, null);
  });

  test('a file two sessions claim appears under both', () => {
    const groups = groupTree(tree([file('shared.ts', ['s1', 's2'])]));
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups.every((g) => g.files.length === 1), true);
  });

  test('churn totals per group', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'], 3, 2), file('b.ts', ['s1'], 4, 1)]));
    assert.strictEqual(groups[0].insertions, 7);
    assert.strictEqual(groups[0].deletions, 3);
  });

  test('a binary file contributes no churn but still lists', () => {
    const binary: FileChange = { path: 'logo.png', op: 'modify', claimedBy: ['s1'] };
    const groups = groupTree(tree([binary]));
    assert.strictEqual(groups[0].files.length, 1);
    assert.strictEqual(groups[0].insertions, 0);
  });

  test('a session that claimed nothing gets no empty group', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'])], ['s1', 's2']));
    assert.strictEqual(groups.some((g) => g.sessionId === 's2'), false);
  });

  test('groups follow roster order, not file order', () => {
    const groups = groupTree(tree([file('b.ts', ['s2']), file('a.ts', ['s1'])], ['s1', 's2']));
    assert.deepStrictEqual(groups.map((g) => g.sessionId), ['s1', 's2']);
  });

  test('an empty tree groups to nothing', () => {
    assert.deepStrictEqual(groupTree(tree([])), []);
  });
});

suite('fleet diff summary', () => {
  test('one file is counted once, in the singular', () => {
    assert.strictEqual(summarize([tree([file('a.ts', ['s1'])])]), '1 changed file');
  });

  test('several trees are named, because a count without them is ambiguous', () => {
    const two = [tree([file('a.ts', ['s1'])]), { ...tree([file('b.ts', ['s1'])]), root: '/other' }];
    assert.strictEqual(summarize(two), '2 changed files in 2 working trees');
  });

  test('a file two sessions claim is counted once and said to be listed twice', () => {
    // The row count is 2 and the file count is 1: without the second clause
    // the header would contradict what is on screen.
    const summary = summarize([tree([file('shared.ts', ['s1', 's2'])])]);
    assert.strictEqual(summary.startsWith('1 changed file,'), true);
    assert.strictEqual(/1 .*more than one session/.test(summary), true);
  });

  test('an unshared set says nothing about sharing', () => {
    const summary = summarize([tree([file('a.ts', ['s1']), file('b.ts', [])])]);
    assert.strictEqual(summary.includes('more than one session'), false);
  });
});
