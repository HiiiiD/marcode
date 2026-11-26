import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import type { SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';
import {
  isShareableProject, MEMORY_PAYLOAD_CAP, MEMORY_TEXT_CAP, memoryPayload, parseMemoryPayload,
} from '../../sync/memory-records';

const digest: SessionDigest = { title: 'Fix login', request: 'r', outcome: 'o', filesEdited: [], source: 'llm', summarizerVersion: 1, forUpdatedAt: 5 };
const item = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const record = (items: TranscriptItem[]) => ({ sessionId: 's1', providerId: 'claude', cwd: '/r', closedAt: 9, items, projectId: 'github.com/a/b' });
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

suite('memory payloads', () => {
  test('the searchable text is capped', () => {
    const p = memoryPayload({ record: record([item('u1', 'x'.repeat(300 * 1024))]), projectId: 'github.com/a/b', relCwd: '.', digest });
    assert.strictEqual(p?.type === 'memory' && p.text.length <= MEMORY_TEXT_CAP, true);
  });

  test('only the first forty items travel', () => {
    const items = Array.from({ length: 100 }, (_, i) => item(`u${i}`, `line ${i}`));
    const p = memoryPayload({ record: record(items), projectId: 'github.com/a/b', relCwd: 'src', digest });
    assert.strictEqual(p?.type === 'memory' && p.items.length, 40);
    assert.strictEqual(p?.type === 'memory' && p.items[0].id, 'u0');
    assert.strictEqual(p?.type === 'memory' && p.relCwd, 'src');
    assert.strictEqual(p?.type === 'memory' && p.title, 'Fix login');
  });

  test('huge items are trimmed before any is dropped, and the whole payload fits the cap', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`u${i}`, 'y'.repeat(50 * 1024)));
    const p = memoryPayload({ record: record(items), projectId: 'github.com/a/b', relCwd: '.', digest });
    assert.strictEqual(p !== undefined && size(p) <= MEMORY_PAYLOAD_CAP, true);
    assert.strictEqual(p?.type === 'memory' && p.items.length, 40);
  });

  test('a payload that cannot fit is not built', () => {
    const fat = { ...digest, outcome: 'z'.repeat(MEMORY_PAYLOAD_CAP) };
    assert.strictEqual(memoryPayload({ record: record([item('u1', 'hi')]), projectId: 'github.com/a/b', relCwd: '.', digest: fat }), undefined);
  });

  test('parse round-trips both kinds and rejects anything else', () => {
    const p = memoryPayload({ record: record([item('u1', 'hi')]), projectId: 'github.com/a/b', relCwd: '.', digest })!;
    assert.deepStrictEqual(parseMemoryPayload(JSON.parse(JSON.stringify(p))), p);
    assert.deepStrictEqual(parseMemoryPayload({ type: 'memory-withdraw', sessionId: 's1' }), { type: 'memory-withdraw', sessionId: 's1' });
    assert.strictEqual(parseMemoryPayload({ type: 'future', sessionId: 's1' }), undefined);
    assert.strictEqual(parseMemoryPayload({ type: 'memory-withdraw' }), undefined);
    assert.strictEqual(parseMemoryPayload('nope'), undefined);
    assert.strictEqual(parseMemoryPayload({ ...p, digest: { title: 't' } }), undefined);
  });

  test('only remote project ids that are not excluded are shareable', () => {
    assert.strictEqual(isShareableProject('github.com/a/b', []), true);
    assert.strictEqual(isShareableProject('local:/x', []), false);
    assert.strictEqual(isShareableProject('github.com/a/b', ['github.com/a/b']), false);
    assert.strictEqual(isShareableProject(undefined, []), false);
  });
});
