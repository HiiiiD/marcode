import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import { MEMORY_PAYLOAD_CAP } from '../../sync/memory-records';
import { opsPayloads, parseSessionPayload, publishedState, type TranscriptOp } from '../../sync/session-records';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const item = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });

const state = (): SessionState => ({
  id: 's1', providerId: 'claude', model: 'm', title: 'Fix login', name: 'fix', cwd: '/r', status: 'running',
  permissionMode: 'default', includeEditorContext: false, resumeTokens: { t: 'abc' }, createdAt: 1, updatedAt: 2, parentId: 'p0',
  owner: { host: 'vscode', pid: 1 }, children: [], subagents: { running: 1, awaitingApproval: 0 }, backgroundTasks: 1,
  backgroundCommands: 1, queued: [], waitingOn: 'permission', pinned: true, summary: { text: 'x', forUpdatedAt: 2 },
  open: true, draft: 'secret draft',
});

suite('session payloads', () => {
  test('publishedState drops host-derived and per-device keys and keeps the conversation fields', () => {
    const p = publishedState(state()) as unknown as Record<string, unknown>;
    for (const key of ['owner', 'children', 'subagents', 'backgroundTasks', 'backgroundCommands', 'queued', 'waitingOn', 'pinned', 'summary', 'open', 'draft']) {
      assert.strictEqual(key in p, false, key);
    }
    assert.deepStrictEqual(p.resumeTokens, { t: 'abc' });
    assert.strictEqual(p.title, 'Fix login');
    assert.strictEqual(p.status, 'running');
    assert.strictEqual(p.parentId, 'p0');
  });

  test('many ops split into capped records with consecutive revs, in order', () => {
    const ops: TranscriptOp[] = Array.from({ length: 300 }, (_, i) => ({ op: 'append', item: item(`a${i}`, 'z'.repeat(10 * 1024)) }));
    const records = opsPayloads('s1', 7, ops);
    assert.strictEqual(records.length > 1, true);
    assert.strictEqual(records.every((r) => size(r) <= MEMORY_PAYLOAD_CAP), true);
    assert.deepStrictEqual(records.map((r) => r.rev), records.map((_, i) => 7 + i));
    assert.deepStrictEqual(records.flatMap((r) => r.ops.map((o) => o.item.id)), ops.map((o) => o.item.id));
  });

  test('a single huge item is trimmed into one record under the cap', () => {
    const records = opsPayloads('s1', 1, [{ op: 'replace', item: item('big', 'q'.repeat(2 * 1024 * 1024)) }]);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(size(records[0]) <= MEMORY_PAYLOAD_CAP, true);
    assert.strictEqual(records[0].ops[0].op, 'replace');
  });

  test('parse round-trips each type, flags a newer format and rejects the rest', () => {
    const meta = { type: 'session-meta', v: 1, sessionId: 's1', projectId: 'github.com/a/b', relCwd: '.', branch: 'main', state: publishedState(state()) };
    const ops = opsPayloads('s1', 1, [{ op: 'append', item: item('a', 'hi') }])[0];
    const del = { type: 'session-delete', v: 1, sessionId: 's1' };
    assert.deepStrictEqual(parseSessionPayload(JSON.parse(JSON.stringify(meta))), meta);
    assert.deepStrictEqual(parseSessionPayload(JSON.parse(JSON.stringify(ops))), ops);
    assert.deepStrictEqual(parseSessionPayload(del), del);
    assert.deepStrictEqual(parseSessionPayload({ ...del, v: 2 }), { newerFormat: true });
    assert.strictEqual(parseSessionPayload({ type: 'memory', sessionId: 's1' }), undefined);
    assert.strictEqual(parseSessionPayload({ type: 'session-delete', v: 1 }), undefined);
    assert.strictEqual(parseSessionPayload('nope'), undefined);
    assert.strictEqual(parseSessionPayload({ type: 'session-ops', v: 1, sessionId: 's1', rev: 1, ops: [{ op: 'drop', item: {} }] }), undefined);
  });
});
