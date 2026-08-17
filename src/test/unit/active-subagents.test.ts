import * as assert from 'assert';
import { activeSubagents } from '../../webview/components/active-subagents';
import type { TranscriptItem } from '../../protocol/messages';

function task(
  id: string,
  over: {
    ts?: number;
    state?: 'running' | 'ok' | 'error';
    agent?: string;
    children?: TranscriptItem[];
  } = {},
): TranscriptItem {
  return {
    id,
    ts: over.ts ?? 1000,
    role: 'tool',
    toolId: `tool-${id}`,
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: over.agent },
    state: over.state ?? 'running',
    children: over.children,
  };
}

function read(id: string, state: 'running' | 'ok' | 'error' = 'running'): TranscriptItem {
  return {
    id,
    ts: 1000,
    role: 'tool',
    toolId: `tool-${id}`,
    tool: { kind: 'file-read', label: 'Read', path: 'a.ts' },
    state,
  };
}

function assistant(id: string): TranscriptItem {
  return { id, ts: 1000, role: 'assistant', text: 'hi' };
}

suite('active subagents', () => {
  test('an empty transcript has nothing running', () => {
    assert.deepStrictEqual(activeSubagents([]), []);
  });

  test('a running subagent with no children yet is still active', () => {
    // The window that matters most: the Task has spawned and returned
    // nothing, so there is no child to infer it from.
    const found = activeSubagents([task('t1', { agent: 'Explore' })]);
    assert.deepStrictEqual(found.map((a) => a.itemId), ['t1']);
    assert.strictEqual(found[0].agent, 'Explore');
  });

  test('a settled subagent is not active', () => {
    assert.deepStrictEqual(activeSubagents([task('t1', { state: 'ok' })]), []);
  });

  test('a running plain tool is not a subagent', () => {
    assert.deepStrictEqual(activeSubagents([read('r1'), assistant('a1')]), []);
  });

  test('oldest first, so the header can quote the longest wait', () => {
    const found = activeSubagents([
      task('t1', { ts: 3000 }),
      task('t2', { ts: 1000 }),
      task('t3', { ts: 2000 }),
    ]);
    assert.deepStrictEqual(found.map((a) => a.itemId), ['t2', 't3', 't1']);
    assert.strictEqual(found[0].ts, 1000);
  });

  test('falls back to the tool label when the call names no agent', () => {
    assert.strictEqual(activeSubagents([task('t1')])[0].agent, 'Task');
  });

  test('a subagent running inside a subagent is found', () => {
    const found = activeSubagents([
      task('t1', {
        ts: 1000,
        children: [read('c1', 'ok'), task('c2', { ts: 2000, agent: 'Plan' })],
      }),
    ]);
    // One entry, not two: only top-level items are registered with the
    // scroller, so both running subagents share a single scroll target and
    // counting them twice would promise two destinations that are one.
    assert.deepStrictEqual(found.map((a) => a.itemId), ['t1']);
  });

  test('a nested running subagent keeps its settled parent active', () => {
    // The parent Task has returned, but the child it spawned has not. The
    // work is still in progress and the card is still the place to look.
    const found = activeSubagents([
      task('t1', {
        ts: 1000,
        state: 'ok',
        children: [task('c1', { ts: 2000, agent: 'Plan' })],
      }),
    ]);
    assert.deepStrictEqual(found.map((a) => a.itemId), ['t1']);
    assert.strictEqual(found[0].agent, 'Plan', 'the label names what is actually running');
    assert.strictEqual(found[0].ts, 2000, 'and elapsed counts from when that one started');
  });

  test('a non-tool item with no children is skipped without throwing', () => {
    assert.deepStrictEqual(
      activeSubagents([assistant('a1'), read('r1', 'ok'), task('t1')]).map((a) => a.itemId),
      ['t1'],
    );
  });
});
