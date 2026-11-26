import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { MemoryPublisher } from '../../host/sync/memory-publisher';
import type { SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore, SessionRecord } from '../../memory/types';
import type { TranscriptItem } from '../../protocol/messages';
import { SyncState } from '../../sync/sync-state';

class Inner implements MemoryStore {
  digests = new Map<string, SessionDigest>();
  indexed: string[] = [];
  forgotten: string[] = [];
  async index(r: SessionRecord) { this.indexed.push(r.sessionId); if (r.digest) { this.digests.set(r.sessionId, r.digest); } }
  async search() { return []; }
  async fetch() { return { sessionId: '', items: [] }; }
  async forget(id: string) { this.forgotten.push(id); this.digests.delete(id); }
  async getDigest(id: string) { return this.digests.get(id); }
  async digestMeta() { return new Map<string, DigestMeta>([...this.digests].map(([id, d]) => [id, d])); }
  async setProject() {}
}

const digest = (source: 'extractive' | 'llm' = 'extractive'): SessionDigest =>
  ({ title: 'T', request: 'r', outcome: 'o', filesEdited: [], source, summarizerVersion: 1, forUpdatedAt: 5 });
const items: TranscriptItem[] = [{ id: 'u1', ts: 0, role: 'user', text: 'hello' }];
const rec = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ sessionId: 's1', providerId: 'claude', cwd: '/w/repo/src', closedAt: 9, items, projectId: 'github.com/a/b', digest: digest(), ...over });

async function rig(sessions: Array<{ id: string; providerId: string; cwd: string; projectId?: string; hidden: boolean }> = []) {
  const state = new SyncState(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-pub-')), 'state.sqlite'));
  const inner = new Inner();
  const pub = new MemoryPublisher({
    inner, state, excluded: ['github.com/secret/repo'], relCwd: async () => 'src', transcript: async () => items, sessions: () => sessions,
  });
  const payloads = () => state.peek(100).map((r) => r.payload as { type: string; relCwd?: string; digest?: SessionDigest });
  return { state, inner, pub, payloads };
}

suite('MemoryPublisher', () => {
  test('indexing a shareable session publishes it once per digest', async () => {
    const { pub, inner, payloads } = await rig();
    await pub.index(rec());
    await pub.index(rec());
    assert.deepStrictEqual(inner.indexed, ['s1', 's1']);
    assert.strictEqual(payloads().length, 1);
    assert.strictEqual(payloads()[0].type, 'memory');
    assert.strictEqual(payloads()[0].relCwd, 'src');
  });

  test('an llm digest with the same timestamp is published again', async () => {
    const { pub, payloads } = await rig();
    await pub.index(rec());
    await pub.index(rec({ digest: digest('llm') }));
    assert.deepStrictEqual(payloads().map((p) => p.digest?.source), ['extractive', 'llm']);
  });

  test('own and excluded projects stay local', async () => {
    const { pub, inner, payloads } = await rig();
    await pub.index(rec({ projectId: 'local:/w/repo' }));
    await pub.index(rec({ sessionId: 's2', projectId: 'github.com/secret/repo' }));
    await pub.index(rec({ sessionId: 's3', projectId: undefined }));
    assert.deepStrictEqual(inner.indexed, ['s1', 's2', 's3']);
    assert.strictEqual(payloads().length, 0);
  });

  test('forget withdraws, and a later index publishes again', async () => {
    const { pub, payloads } = await rig();
    await pub.index(rec());
    await pub.forget('s1');
    await pub.index(rec());
    assert.deepStrictEqual(payloads().map((p) => p.type), ['memory', 'memory-withdraw', 'memory']);
  });

  test('a failing outbox never stops the local index or forget', async () => {
    const { pub, inner, state } = await rig();
    state.close();
    await pub.index(rec());
    await pub.forget('s1');
    assert.deepStrictEqual(inner.indexed, ['s1']);
    assert.deepStrictEqual(inner.forgotten, ['s1']);
  });

  test('backfill publishes stored digests of hidden shareable sessions, once', async () => {
    const { pub, inner, payloads } = await rig([
      { id: 's1', providerId: 'claude', cwd: '/w/repo', projectId: 'github.com/a/b', hidden: true },
      { id: 's2', providerId: 'claude', cwd: '/w/repo', projectId: 'github.com/a/b', hidden: false },
      { id: 's3', providerId: 'claude', cwd: '/w/repo', projectId: 'local:/w', hidden: true },
    ]);
    for (const id of ['s1', 's2', 's3']) { inner.digests.set(id, digest()); }
    assert.strictEqual(await pub.backfill(), 1);
    assert.strictEqual(await pub.backfill(), 0);
    assert.strictEqual(payloads().length, 1);
  });

  test('a session reopened while its publish was in flight ends withdrawn, not published', async () => {
    const sessions = [{ id: 's1', providerId: 'claude', cwd: '/w/repo', projectId: 'github.com/a/b', hidden: true }];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const state = new SyncState(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-pub-')), 'state.sqlite'));
    const inner = new Inner();
    inner.digests.set('s1', digest());
    const pub = new MemoryPublisher({
      inner, state, excluded: [], relCwd: async () => { await gate; return '.'; }, transcript: async () => items, sessions: () => sessions,
    });
    const publishing = pub.setProject('s1', 'github.com/a/b');
    await new Promise((r) => setTimeout(r, 10));
    sessions[0].hidden = false;
    const forgetting = pub.forget('s1');
    release();
    await Promise.all([publishing, forgetting]);
    const types = state.peek(10).map((r) => (r.payload as { type: string }).type);
    assert.strictEqual(types.at(-1), 'memory-withdraw');
    assert.strictEqual(types.includes('memory'), false);
  });

  test('backfill does not read transcripts of sessions already published', async () => {
    let reads = 0;
    const state = new SyncState(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-pub-')), 'state.sqlite'));
    const inner = new Inner();
    inner.digests.set('s1', digest());
    const pub = new MemoryPublisher({
      inner, state, excluded: [], relCwd: async () => '.', transcript: async () => { reads++; return items; },
      sessions: () => [{ id: 's1', providerId: 'claude', cwd: '/w', projectId: 'github.com/a/b', hidden: true }],
    });
    await pub.backfill();
    await pub.backfill();
    assert.strictEqual(reads, 1);
  });
});
