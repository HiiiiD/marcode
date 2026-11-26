import * as assert from 'assert';
import { foldWorkerGroups, teamRowId } from '../../tui/view/worker-groups';
import { transcriptRows } from '../../tui/view/transcript-rows';
import { tool } from '../fixtures/protocol';
import type { TranscriptItem } from '../../protocol/messages';

const worker = (id: string, groupId?: string): TranscriptItem =>
  tool({ id, toolId: `t-${id}`, tool: { kind: 'subagent', label: 'Task', action: 'spawn', provider: 'codex', childSessionId: `s-${id}`, ...(groupId ? { groupId } : {}) } });

const fold = (items: TranscriptItem[], open = false) => foldWorkerGroups(transcriptRows(items, false), () => open);

suite('foldWorkerGroups', () => {
  test('consecutive workers of one call become one team row', () => {
    const rows = fold([worker('a', 'g1'), worker('b', 'g1'), worker('c', 'g1')]);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['workers']);
    assert.deepStrictEqual(rows[0]?.kind === 'workers' ? rows[0].items.map((i) => i.id) : [], ['a', 'b', 'c']);
  });

  test('a group of one stays a plain row', () => {
    assert.deepStrictEqual(fold([worker('a', 'g1')]).map((r) => r.kind), ['tool']);
  });

  test('different calls never merge, and ungrouped workers stay rows', () => {
    const rows = fold([worker('a', 'g1'), worker('b', 'g1'), worker('c', 'g2'), worker('d', 'g2'), worker('e')]);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['workers', 'workers', 'tool']);
  });

  test('an open team lists its workers under it, every id unique', () => {
    const rows = fold([worker('a', 'g1'), worker('b', 'g1')], true);
    assert.deepStrictEqual(rows.map((r) => r.id), [teamRowId('g1'), 'a', 'b']);
    assert.deepStrictEqual(rows.map((r) => r.kind === 'tool' && r.member === true), [false, true, true]);
  });
});
