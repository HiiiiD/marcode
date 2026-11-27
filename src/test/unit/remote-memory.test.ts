import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import type { SessionDigest } from '../../memory/digest';
import { FtsMemoryStore } from '../../memory/fts/fts-memory-store';
import { ProjectMemory } from '../../memory/project-memory';
import { RemoteMemory } from '../../memory/remote-memory';
import type { TranscriptItem } from '../../protocol/messages';
import type { MemoryPayload } from '../../sync/memory-records';

const dir = () => fs.mkdtemp(path.join(os.tmpdir(), 'marcode-remote-mem-'));
const digest = (forUpdatedAt = 5, title = 'Zebra migration'): SessionDigest =>
  ({ title, request: 'zebra plan', outcome: 'done', filesEdited: [], source: 'llm', summarizerVersion: 1, forUpdatedAt });
const items: TranscriptItem[] = [{ id: 'u1', ts: 0, role: 'user', text: 'zebra migration plan' }, { id: 'a1', ts: 0, role: 'assistant', text: 'ok' }];
const memory = (over: Partial<Extract<MemoryPayload, { type: 'memory' }>> = {}): MemoryPayload => ({
  type: 'memory', sessionId: 's1', projectId: 'github.com/a/b', relCwd: '.', providerId: 'claude', title: 'Zebra migration',
  closedAt: 9, digest: digest(), text: 'zebra migration plan', items, ...over,
});

suite('RemoteMemory', () => {
  test('an applied record is recalled by project only, with its digest and items', async () => {
    const r = new RemoteMemory(path.join(await dir(), 'remote.sqlite'));
    await r.apply('dev-a', memory());
    assert.deepStrictEqual((await r.search('zebra', { projectId: 'github.com/a/b' })).map((h) => h.sessionId), ['s1']);
    assert.deepStrictEqual(await r.search('zebra', { cwdWithin: '/' }), []);
    assert.strictEqual((await r.getDigest('s1'))?.title, 'Zebra migration');
    assert.deepStrictEqual((await r.fetch({ sessionId: 's1', itemId: 'u1' })).items.map((i) => i.id), ['u1', 'a1']);
    r.close();
  });

  test('a withdraw from another device leaves the publisher\'s row in place', async () => {
    const r = new RemoteMemory(path.join(await dir(), 'remote.sqlite'));
    await r.apply('dev-a', memory());
    await r.apply('dev-c', { type: 'memory-withdraw', sessionId: 's1' });
    assert.deepStrictEqual((await r.search('zebra', { projectId: 'github.com/a/b' })).map((h) => h.sessionId), ['s1']);
    r.close();
  });

  test('a withdraw removes it everywhere', async () => {
    const r = new RemoteMemory(path.join(await dir(), 'remote.sqlite'));
    await r.apply('dev-a', memory());
    await r.apply('dev-a', { type: 'memory-withdraw', sessionId: 's1' });
    assert.deepStrictEqual(await r.search('zebra', { projectId: 'github.com/a/b' }), []);
    assert.strictEqual(await r.getDigest('s1'), undefined);
    assert.deepStrictEqual((await r.fetch({ sessionId: 's1', itemId: 'u1' })).items, []);
    r.close();
  });

  test('a newer digest for the same session replaces the row', async () => {
    const r = new RemoteMemory(path.join(await dir(), 'remote.sqlite'));
    await r.apply('dev-a', memory());
    await r.apply('dev-a', memory({ digest: digest(7, 'Zebra migration, finished') }));
    const hits = await r.search('zebra', { projectId: 'github.com/a/b' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual((await r.getDigest('s1'))?.forUpdatedAt, 7);
    r.close();
  });

  test('a read-only instance finds what the writer applied and changes nothing itself', async () => {
    const file = path.join(await dir(), 'remote.sqlite');
    const reader = new RemoteMemory(file, { readOnly: true });
    assert.deepStrictEqual(await reader.search('zebra', { projectId: 'github.com/a/b' }), []);
    const writer = new RemoteMemory(file);
    await writer.apply('dev-a', memory());
    assert.deepStrictEqual((await reader.search('zebra', { projectId: 'github.com/a/b' })).map((h) => h.sessionId), ['s1']);
    await reader.apply('dev-a', { type: 'memory-withdraw', sessionId: 's1' });
    assert.deepStrictEqual((await writer.search('zebra', { projectId: 'github.com/a/b' })).map((h) => h.sessionId), ['s1']);
    reader.close();
    writer.close();
  });
});

suite('ProjectMemory with remote memory', () => {
  test('a project scope includes remote hits; a folder scope does not', async () => {
    const ws = path.join(await dir(), 'workspaces', 'w1');
    await fs.mkdir(ws, { recursive: true });
    const local = new FtsMemoryStore(path.join(ws, 'memory.sqlite'), { tail: async () => ({ items: [], hasMore: false }) });
    await local.index({ sessionId: 'mine', providerId: 'claude', cwd: '/w/repo', closedAt: 1, items: [items[0]], projectId: 'github.com/a/b' });
    const remote = new RemoteMemory(path.join(await dir(), 'remote.sqlite'));
    await remote.apply('dev-a', memory({ sessionId: 'theirs' }));
    const pm = new ProjectMemory(local, ws, { remote });
    assert.deepStrictEqual((await pm.search('zebra', { projectId: 'github.com/a/b' })).map((h) => h.sessionId).sort(), ['mine', 'theirs']);
    assert.deepStrictEqual((await pm.search('zebra', { cwdWithin: '/w/repo' })).map((h) => h.sessionId), ['mine']);
    assert.strictEqual((await pm.getDigest('theirs'))?.title, 'Zebra migration');
    assert.deepStrictEqual((await pm.fetch({ sessionId: 'theirs', itemId: 'u1' })).items.map((i) => i.id), ['u1', 'a1']);
    pm.close();
  });
});
