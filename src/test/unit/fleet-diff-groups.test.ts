// Turning the flat wire payload into the tree → session → files shape the
// user reads. Pure: no React, no DOM, no store.

import * as assert from 'assert';
import {
  commonPrefix, countFiles, filterTree, groupTree, stripPrefix, summarize,
} from '../../review/fleet-diff-groups';
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

suite('filterTree', () => {
  const tree = {
    root: '/repo', branch: 'main', sessions: ['s1', 's2'],
    base: { kind: 'head' as const }, omitted: 0,
    files: [
      { path: 'src/webview/app.tsx', op: 'modify' as const, insertions: 1, deletions: 0, claimedBy: ['s1'] },
      { path: 'README.md', op: 'modify' as const, insertions: 2, deletions: 0, claimedBy: ['s1', 's2'] },
    ],
  };

  test('an empty query keeps everything', () => {
    assert.strictEqual(filterTree(tree, '', false).files.length, 2);
  });

  test('matches anywhere in the path, case-insensitively', () => {
    assert.strictEqual(filterTree(tree, 'WEBVIEW', false).files.length, 1);
    assert.strictEqual(filterTree(tree, 'readme', false).files.length, 1);
  });

  test('contested-only keeps files more than one session claimed', () => {
    const only = filterTree(tree, '', true);
    assert.strictEqual(only.files.length, 1);
    assert.strictEqual(only.files[0].path, 'README.md');
  });

  test('the two compose', () => {
    assert.strictEqual(filterTree(tree, 'src', true).files.length, 0);
  });

  test('countFiles counts files, not rows', () => {
    // README.md is claimed twice and will render under two groups. The count
    // answers "what changed", which is a question about files.
    assert.strictEqual(countFiles([tree]), 2);
  });
});

suite('commonPrefix', () => {
  test('finds the deepest shared directory', () => {
    assert.strictEqual(
      commonPrefix(['src/webview/a.tsx', 'src/webview/b.tsx']), 'src/webview/',
    );
  });

  test('stops at a directory boundary, never mid-segment', () => {
    // 'src/we' is a shared string but not a shared directory. Eliding it would
    // render paths that do not exist.
    assert.strictEqual(commonPrefix(['src/webview/a.tsx', 'src/west/b.tsx']), 'src/');
  });

  test('is empty when nothing is shared', () => {
    assert.strictEqual(commonPrefix(['src/a.ts', 'docs/b.md']), '');
  });

  test('a single file elides its own directory, not its name', () => {
    assert.strictEqual(commonPrefix(['src/webview/a.tsx']), 'src/webview/');
  });

  test('a root-level file has no prefix', () => {
    assert.strictEqual(commonPrefix(['README.md']), '');
  });

  test('stripPrefix leaves the remainder', () => {
    assert.strictEqual(stripPrefix('src/webview/a.tsx', 'src/webview/'), 'a.tsx');
    assert.strictEqual(stripPrefix('README.md', ''), 'README.md');
  });
});
