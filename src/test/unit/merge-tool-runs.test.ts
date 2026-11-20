import * as assert from 'assert';
import { groupSubagents, mergeToolRuns } from '../../webview/lib/subagent-groups';
import { tool } from '../fixtures/protocol';

const edit = (id: string, path: string) =>
  tool({ id, tool: { kind: 'file-edit', label: 'Edit', files: [{ path, op: 'modify', edits: [{ before: 'a', after: 'b' }] }] } });

suite('mergeToolRuns', () => {
  test('folds consecutive identical calls into one entry with the rest in `more`', () => {
    const out = mergeToolRuns(groupSubagents([edit('1', '/a.ts'), edit('2', '/a.ts'), edit('3', '/a.ts')]));
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].kind === 'item' && out[0].more?.map((m) => m.id), ['2', '3']);
  });

  test('keeps different targets and non-adjacent repeats apart', () => {
    const out = mergeToolRuns(groupSubagents([
      edit('1', '/a.ts'), edit('2', '/b.ts'),
      { id: 'x', ts: 1, role: 'assistant', text: 'hi' },
      edit('3', '/b.ts'),
    ]));
    assert.deepStrictEqual(out.map((e) => (e.kind === 'item' ? e.item.id : e.id)), ['1', '2', 'x', '3']);
  });
});
