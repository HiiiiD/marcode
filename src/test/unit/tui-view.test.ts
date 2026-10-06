import * as assert from 'node:assert';
import { bottomSlot } from '../../tui/view/bottom-slot';
import { rosterRows } from '../../tui/view/roster-rows';
import { transcriptRows } from '../../tui/view/transcript-rows';
import { permission, question, relocation, summary, tool } from '../fixtures/protocol';
import type { PaneState } from '../../client-core/reducer';
import type { PermissionRequest, QuestionRequest } from '../../protocol/messages';

const pane = (over: Partial<PaneState> = {}): PaneState => ({
  summary: summary('s1'), items: [], hasMore: false, pending: [], mcpServers: [],
  attachments: [], pendingQuestions: [], ...over,
});
const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };
const ask = (blocking: boolean, id = 'q'): QuestionRequest => ({
  requestId: id, blocking, questions: [{ id: 'a', header: 'h', question: 'q?', multiSelect: false, allowOther: false, secret: false }],
});

suite('tui view: roster rows', () => {
  test('glyph follows status, foreign rows are dim and carry host and pid', () => {
    const rows = rosterRows([
      summary('a', { status: 'running' }),
      summary('b', { status: 'awaiting-approval' }),
      summary('c', { status: 'error' }),
      summary('d', { status: 'idle', owner: { host: 'vscode', pid: 4812 } }),
    ], 'b');
    assert.deepStrictEqual(rows.map((r) => r.glyph), ['●', '!', '✗', '○']);
    assert.deepStrictEqual(rows.map((r) => r.focused), [false, true, false, false]);
    assert.strictEqual(rows[3].dim, true);
    assert.strictEqual(rows[3].suffix, 'vscode·4812');
    assert.strictEqual(rows[0].suffix, undefined);
  });
  test('pinned rows sort first, stably, and carry the foreign flag', () => {
    const rows = rosterRows([
      summary('a', { name: 'alpha' }),
      summary('b', { name: 'beta', pinned: true }),
      summary('c', { name: 'gamma', pinned: true, owner: { host: 'vscode', pid: 1 } }),
      summary('d', { name: 'delta' }),
    ], null);
    assert.deepStrictEqual(rows.map((r) => r.id), ['b', 'c', 'a', 'd']);
    assert.deepStrictEqual(rows.map((r) => r.pinned), [true, true, false, false]);
    assert.deepStrictEqual(rows.map((r) => r.foreign), [false, true, false, false]);
  });
  test('the filter matches the title case-insensitively and keeps pinned-first order', () => {
    const rows = rosterRows([
      summary('a', { name: 'API fix' }),
      summary('b', { name: 'docs' }),
      summary('c', { name: 'api docs', pinned: true }),
    ], null, 'API');
    assert.deepStrictEqual(rows.map((r) => r.id), ['c', 'a']);
  });
  test('an empty filter keeps every row', () => {
    assert.strictEqual(rosterRows([summary('a'), summary('b')], null, '').length, 2);
  });
  test('roster rows mark sessions that have a pane', () => {
    const rows = rosterRows([summary('a'), summary('b')], 'a', '', new Set(['a']));
    assert.deepStrictEqual(rows.map((r) => r.leaf), [true, false]);
  });
});

suite('tui view: bottom slot', () => {
  test('composer by default', () => {
    assert.strictEqual(bottomSlot(summary('s1'), pane()).kind, 'composer');
  });
  test('a pending permission takes the slot; a question beats it', () => {
    assert.strictEqual(bottomSlot(summary('s1'), pane({ pending: [perm] })).kind, 'permission');
    assert.strictEqual(bottomSlot(summary('s1'), pane({ pending: [perm], pendingQuestions: [ask(true)] })).kind, 'question');
  });
  test('a blocking question is chosen before a non-blocking one', () => {
    const slot = bottomSlot(summary('s1'), pane({ pendingQuestions: [ask(false, 'n'), ask(true, 'b')] }));
    assert.strictEqual(slot.kind === 'question' && slot.request.requestId, 'b');
  });
  test('a foreign session is read-only even with a stale pending entry', () => {
    const foreign = summary('s1', { owner: { host: 'vscode', pid: 7 } });
    const slot = bottomSlot(foreign, pane({ pending: [perm], summary: foreign }));
    assert.strictEqual(slot.kind, 'foreign');
    assert.strictEqual(slot.kind === 'foreign' && slot.text.includes('vscode (pid 7)'), true);
  });
  test('no summary yet is a composer-less safe default', () => {
    assert.strictEqual(bottomSlot(undefined, undefined).kind, 'composer');
  });
});

suite('tui view: transcript rows', () => {
  test('only the last assistant row streams, and only while running', () => {
    const items = [
      { id: 'a1', ts: 1, role: 'assistant' as const, text: 'one' },
      { id: 'a2', ts: 2, role: 'assistant' as const, text: 'two' },
    ];
    const running = transcriptRows(items, true);
    assert.deepStrictEqual(running.map((r) => r.kind === 'assistant' && r.streaming), [false, true]);
    assert.deepStrictEqual(transcriptRows(items, false).map((r) => r.kind === 'assistant' && r.streaming), [false, false]);
  });
  test('an empty assistant item is skipped', () => {
    assert.strictEqual(transcriptRows([{ id: 'a', ts: 1, role: 'assistant', text: '' }], true).length, 0);
  });
  test('a tool row carries its item and its children are not rows', () => {
    const child = tool({ id: 'c', toolId: 'tc' });
    const parent = tool({ id: 'p', children: [child] });
    const rows = transcriptRows([parent], false);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.ok(row.kind === 'tool');
    assert.strictEqual(row.kind === 'tool' && row.item.children?.length, 1);
  });
  test('permission, error and switch items map to their row kinds', () => {
    const rows = transcriptRows([
      permission({ id: 'p1' }),
      { id: 'e1', ts: 1, role: 'error', message: 'boom' },
      { id: 's1', ts: 1, role: 'switch', kind: 'model', text: 'Model: a → b' },
    ], false);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['permission', 'notice', 'notice']);
  });
  test('a permission for the preceding tool call folds into that tool row', () => {
    const rows = transcriptRows([
      tool({ id: 't', toolId: 'tu1' }),
      permission({ id: 'p', requestId: 'tu1', state: 'denied', reason: 'no' }),
    ], false);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.ok(row.kind === 'tool');
    assert.deepStrictEqual(row.kind === 'tool' && row.permission, { state: 'denied', reason: 'no' });
  });
  test('a permission with no matching tool row stays its own row', () => {
    const rows = transcriptRows([
      tool({ id: 't', toolId: 'tu1' }),
      permission({ id: 'p', requestId: 'other' }),
    ], false);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['tool', 'permission']);
  });
  test('a question item keeps its state', () => {
    const rows = transcriptRows([question({ id: 'q1' })], false);
    assert.strictEqual(rows[0].kind === 'question' && rows[0].state, 'pending');
  });
  test('a relocation becomes a card row; only the newest unsettled offer is active', () => {
    const rows = transcriptRows([
      relocation({ id: 'r1', state: 'pending' }),
      relocation({ id: 'r2', state: 'moved' }),
      relocation({ id: 'r3', state: 'pending' }),
    ], false);
    assert.deepStrictEqual(rows.map((r) => (r.kind === 'relocation' ? [r.id, r.card.state, r.active] : null)), [
      ['r1', 'pending', false], ['r2', 'moved', false], ['r3', 'pending', true],
    ]);
  });
  test('a compaction becomes a card row carrying its headline and summary', () => {
    const rows = transcriptRows([
      { id: 'c1', ts: 1, role: 'compaction', state: 'done', trigger: 'auto', summary: 'kept' },
      { id: 'c2', ts: 1, role: 'compaction', state: 'failed', error: 'nope' },
    ], false);
    assert.deepStrictEqual(rows.map((r) => (r.kind === 'compaction' ? [r.id, r.state, r.headline, r.summary, r.error] : null)), [
      ['c1', 'done', 'Conversation compacted automatically', 'kept', undefined],
      ['c2', 'failed', 'Compaction failed', undefined, 'nope'],
    ]);
  });
});
