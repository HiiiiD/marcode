import * as assert from 'assert';
import { filterSubagents } from '../../fleet/filter-subagents';
import type { TranscriptItem } from '../../protocol/messages';

function subagent(id: string, ts: number, state: 'running' | 'ok' | 'error'): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: `Agent${id}` },
    state,
  };
}

function plainTool(id: string, ts: number): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'other', label: 'Read', raw: {} },
    state: 'ok',
  };
}

suite('filterSubagents', () => {
  test('excludes non-subagent tool items and every non-tool role', () => {
    const items: TranscriptItem[] = [
      plainTool('p1', 1),
      { id: 'u1', ts: 2, role: 'user', text: 'hi' },
      subagent('s1', 3, 'running'),
    ];
    const result = filterSubagents(items, { includeSettled: true });
    assert.deepStrictEqual(result.map((i) => i.id), ['s1']);
  });

  test('running-only by default, oldest first', () => {
    const items: TranscriptItem[] = [
      subagent('s1', 10, 'ok'),
      subagent('s2', 5, 'running'),
      subagent('s3', 20, 'running'),
    ];
    const result = filterSubagents(items, { includeSettled: false });
    assert.deepStrictEqual(result.map((i) => i.id), ['s2', 's3']);
  });

  test('includeSettled reveals ok and error subagents too, still oldest first', () => {
    const items: TranscriptItem[] = [
      subagent('s1', 10, 'ok'),
      subagent('s2', 5, 'running'),
      subagent('s3', 1, 'error'),
    ];
    const result = filterSubagents(items, { includeSettled: true });
    assert.deepStrictEqual(result.map((i) => i.id), ['s3', 's2', 's1']);
  });

  test('empty input yields an empty list', () => {
    assert.deepStrictEqual(filterSubagents([], { includeSettled: false }), []);
  });
});
