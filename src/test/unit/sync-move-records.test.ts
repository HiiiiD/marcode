import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { MEMORY_PAYLOAD_CAP } from '../../sync/memory-records';
import { assemble, chunkFile, parseMovePayload, type MovePayload } from '../../sync/move-records';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const thread = { type: 'thread-chunk' as const, sessionId: 's1', providerId: 'claude', name: 's1.jsonl', generation: 1 };

suite('move payloads', () => {
  test('each type round-trips, and a newer version is flagged', () => {
    const all: MovePayload[] = [
      { type: 'move-request', v: 1, sessionId: 's1', requestId: 'q1', to: 'dev-b', cancelTurn: false },
      { type: 'move-reply', v: 1, sessionId: 's1', requestId: 'q1', ok: true, lastRev: 7, thread: { generation: 1, bytes: 10 } },
      { type: 'move-reply', v: 1, sessionId: 's1', requestId: 'q1', ok: false, reason: 'no' },
      ...chunkFile(thread, Buffer.from('hello'), 0),
      ...chunkFile({ type: 'attachment', sessionId: 's1', attachmentId: 'a1', name: 'x.png', mime: 'image/png', generation: 1 }, Buffer.from('png'), 0),
    ];
    for (const p of all) { assert.deepStrictEqual(parseMovePayload(JSON.parse(JSON.stringify(p))), p); }
    assert.deepStrictEqual(parseMovePayload({ type: 'move-request', v: 2, sessionId: 's1' }), { newerFormat: true });
    assert.strictEqual(parseMovePayload({ type: 'move-request', v: 1, sessionId: 's1' }), undefined);
    assert.strictEqual(parseMovePayload({ type: 'session-meta', v: 1, sessionId: 's1' }), undefined);
  });

  test('a 700 KiB file becomes three chunks that each fit the record cap', () => {
    const bytes = Buffer.alloc(700 * 1024, 7);
    const chunks = chunkFile(thread, bytes, 0);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks.every((c) => size(c) <= MEMORY_PAYLOAD_CAP), true);
    assert.deepStrictEqual(chunks.map((c) => c.total), [bytes.length, bytes.length, bytes.length]);
  });

  test('chunks from an offset carry only the new bytes', () => {
    const chunks = chunkFile(thread, Buffer.from('abcdef'), 4);
    assert.deepStrictEqual(chunks.map((c) => [c.offset, Buffer.from(c.data, 'base64').toString()]), [[4, 'ef']]);
  });

  test('assemble needs every byte of the newest generation', () => {
    const bytes = Buffer.alloc(700 * 1024, 3);
    const chunks = chunkFile(thread, bytes, 0);
    assert.strictEqual(assemble([chunks[0], chunks[2]]), undefined);
    assert.strictEqual(assemble([chunks[2], chunks[0], chunks[1]])?.equals(bytes), true);
    const newer = chunkFile({ ...thread, generation: 2 }, Buffer.from('new'), 0);
    assert.strictEqual(assemble([...chunks, ...newer])?.toString(), 'new');
    assert.strictEqual(assemble([...chunks, ...chunkFile({ ...thread, generation: 2 }, Buffer.alloc(300 * 1024), 0).slice(1)]), undefined);
  });
});
