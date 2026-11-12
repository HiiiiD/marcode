import * as assert from 'assert';
import { groupSubagents } from '../../webview/lib/subagent-groups';
import type { TranscriptItem } from '../../protocol/messages';

const sub = (id: string, groupId?: string): TranscriptItem => ({
  role: 'tool', id, ts: 1, state: 'running',
  tool: { kind: 'subagent', label: 'Subagent', action: 'spawn', groupId },
} as TranscriptItem);

suite('groupSubagents', () => {
  test('folds consecutive workers sharing a groupId', () => {
    const out = groupSubagents([sub('a', 'g'), sub('b', 'g'), sub('c', 'g')]);
    assert.deepStrictEqual(out.map((e) => e.kind), ['group']);
  });

  test('a lone nested spawn stays a plain item', () => {
    const out = groupSubagents([sub('a')]);
    assert.deepStrictEqual(out.map((e) => e.kind), ['item']);
  });

  test('different groups stay apart', () => {
    const out = groupSubagents([sub('a', 'g1'), sub('b', 'g1'), sub('c', 'g2'), sub('d', 'g2')]);
    assert.deepStrictEqual(out.map((e) => e.kind), ['group', 'group']);
  });

  test('a one-member group degrades to an item', () => {
    const out = groupSubagents([sub('a', 'g')]);
    assert.deepStrictEqual(out.map((e) => e.kind), ['item']);
  });
});
