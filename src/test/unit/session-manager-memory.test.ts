import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { MemoryStore, SessionRecord } from '../../memory/types';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'marcode-session-manager-'));
}

class RecordingMemoryStore implements MemoryStore {
  indexed: SessionRecord[] = [];
  forgotten: string[] = [];
  async index(record: SessionRecord): Promise<void> { this.indexed.push(record); }
  async search(): Promise<[]> { return []; }
  async fetch(): Promise<{ sessionId: string; items: [] }> { return { sessionId: '', items: [] }; }
  async forget(sessionId: string): Promise<void> { this.forgotten.push(sessionId); }
}

suite('SessionManager memory indexing', () => {
  test('archiving a session with real content indexes it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    // AgentSession.send() appends the user item and stamps the title
    // synchronously (see `deliver()` in agent-session.ts) — no need to wait
    // for a turn to complete before archiving.
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed.length, 1);
    assert.strictEqual(memory.indexed[0].sessionId, session.state.id);
  });

  test('archiving an untitled, empty session does not index it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed.length, 0);
  });

  test('a rejecting MemoryStore does not stop archive() from completing', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory: MemoryStore = {
      index: async () => { throw new Error('disk full'); },
      search: async () => [],
      fetch: async () => ({ sessionId: '', items: [] }),
      forget: async () => {},
    };
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await assert.doesNotReject(manager.close(session.state.id));
  });

  test('deleting a session with real content forgets it from memory', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.remove(session.state.id);
    // archive() (called by remove()) indexes it first, same as a plain
    // close() — the point of this test is that remove() then erases it again.
    assert.strictEqual(memory.indexed.length, 1);
    assert.deepStrictEqual(memory.forgotten, [session.state.id]);
  });

  test('dispose() indexes still-open sessions instead of losing them on reload', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    // Never closed — this is the reload/quit path, not `close()`.
    await manager.dispose();
    assert.strictEqual(memory.indexed.length, 1);
    assert.strictEqual(memory.indexed[0].sessionId, session.state.id);
  });

  test('dispose() does not index an untitled, empty session', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    await manager.create('fake', '/repo');
    await manager.dispose();
    assert.strictEqual(memory.indexed.length, 0);
  });
});
