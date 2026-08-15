import * as assert from 'assert';
import {
  SUBAGENT_CHILD_WINDOW, formatElapsed, summarizeSubagent, windowChildren,
} from '../../webview/components/subagent-window';
import type { TranscriptItem } from '../../protocol/messages';

function child(id: string, state: 'running' | 'ok' | 'error' = 'ok'): TranscriptItem {
  return {
    id, ts: 1, role: 'tool', toolId: id,
    tool: { kind: 'file-read', label: 'Read', path: 'a.ts' }, state,
  };
}

function parent(children: TranscriptItem[], ts = 1000): TranscriptItem {
  return {
    id: 't1', ts, role: 'tool', toolId: 'task1',
    tool: { kind: 'subagent', label: 'Task', action: 'spawn' }, state: 'running', children,
  };
}

suite('subagent window', () => {
  test('the window is ten', () => {
    assert.strictEqual(SUBAGENT_CHILD_WINDOW, 10);
  });

  test('renders every child when there are fewer than the window', () => {
    assert.deepStrictEqual(
      windowChildren([child('a'), child('b')]).map((c) => c.id), ['a', 'b'],
    );
  });

  test('keeps the LAST N so the newest child is always rendered', () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`));
    const shown = windowChildren(children);
    assert.strictEqual(shown.length, 10);
    assert.strictEqual(shown[0].id, 'c15');
    assert.strictEqual(shown[9].id, 'c24');
  });

  test('summary counts tools, running children and elapsed time', () => {
    const summary = summarizeSubagent(
      parent([child('a'), child('b', 'running')]) as never, 4000,
    );
    assert.strictEqual(summary.toolCount, 2);
    assert.strictEqual(summary.running, 1);
    assert.strictEqual(summary.elapsedMs, 3000);
    assert.strictEqual(summary.blocked, false);
  });

  test('a pending permission child marks the subagent blocked', () => {
    const item = parent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'pending',
    }]);
    assert.strictEqual(summarizeSubagent(item as never, 2).blocked, true);
  });

  test('a settled permission child does not mark it blocked', () => {
    const item = parent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'allowed',
    }]);
    assert.strictEqual(summarizeSubagent(item as never, 2).blocked, false);
  });

  test('a settled subagent stops counting from its last child, not from now', () => {
    const settled = {
      ...parent([child('a')], 1000), state: 'ok' as const,
    } as TranscriptItem & { children: TranscriptItem[] };
    settled.children[0] = { ...settled.children[0], ts: 3000 };
    assert.strictEqual(summarizeSubagent(settled as never, 99999).elapsedMs, 2000);
  });

  test('elapsed reads as minutes and seconds past a minute', () => {
    assert.strictEqual(formatElapsed(34_000), '34s');
    assert.strictEqual(formatElapsed(252_000), '4m 12s');
    assert.strictEqual(formatElapsed(0), '0s');
  });
});
