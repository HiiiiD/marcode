import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { DigestMeta, MemoryStore, SessionRecord } from '../../memory/types';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'marcode-session-manager-'));
}

class RecordingMemoryStore implements MemoryStore {
  indexed: SessionRecord[] = [];
  forgotten: string[] = [];
  async index(record: SessionRecord): Promise<void> { this.indexed.push(record); }
  searches: { query: string; cwdWithin?: string }[] = [];
  async search(query: string, opts: { cwdWithin?: string } = {}): Promise<[]> {
    this.searches.push({ query, cwdWithin: opts.cwdWithin });
    return [];
  }
  async fetch(): Promise<{ sessionId: string; items: [] }> { return { sessionId: '', items: [] }; }
  async forget(sessionId: string): Promise<void> { this.forgotten.push(sessionId); }
  async getDigest(): Promise<undefined> { return undefined; }
  async digestMeta(): Promise<Map<string, DigestMeta>> { return new Map(); }
}

suite('SessionManager memory indexing', () => {
  test('closing a session with real content indexes it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    // AgentSession.send() appends the user item and stamps the title
    // synchronously (see `deliver()` in agent-session.ts) — no need to wait
    // for a turn to complete before closing.
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed.length, 1);
    assert.strictEqual(memory.indexed[0].sessionId, session.state.id);
  });

  test('closing indexes an extractive digest', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed[0].digest?.source, 'extractive');
  });

  test('showing a closed session in a pane removes it from the index', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    await manager.setVisible([session.state.id]);
    assert.deepStrictEqual(memory.forgotten, [session.state.id]);
  });

  test('priming searches only inside the workspace folder that holds the session cwd', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    manager.setWorkspaceRoots(() => ['/ws/app', '/ws/other']);
    await manager.recall('investigate the flaky login test', '/ws/app/packages/api');
    assert.strictEqual(memory.searches[0].cwdWithin, '/ws/app');
  });

  test('a cwd outside every workspace folder is scoped to itself', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    manager.setWorkspaceRoots(() => ['/ws/app']);
    await manager.recall('investigate the flaky login test', '/scratch/x');
    assert.strictEqual(memory.searches[0].cwdWithin, '/scratch/x');
  });

  test('the nested workspace folder wins over its parent', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const manager = new SessionManager(store, providers, () => {});
    manager.setWorkspaceRoots(() => ['/ws', '/ws/app']);
    assert.strictEqual(manager.recallRootOf('/ws/app/src'), '/ws/app');
  });

  test('closing an untitled, empty session does not index it', async () => {
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

  test('a rejecting MemoryStore does not stop close() from completing', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory: MemoryStore = {
      index: async () => { throw new Error('disk full'); },
      search: async () => [],
      fetch: async () => ({ sessionId: '', items: [] }),
      forget: async () => {},
      getDigest: async () => undefined,
      digestMeta: async () => new Map(),
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
    // hide() (called by remove()) indexes it first, same as a plain
    // close() — the point of this test is that remove() then erases it again.
    assert.strictEqual(memory.indexed.length, 1);
    assert.deepStrictEqual(memory.forgotten, [session.state.id]);
  });

  test('hiding a session (the pane X, or an unchecked roster row) indexes it, and revealing it again forgets it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.setVisible([session.state.id]); // reveal, as opening a pane does
    await manager.setVisible([]); // hide — set-layout/set-visible, never close-session
    assert.strictEqual(memory.indexed.length, 1);
    await manager.setVisible([session.state.id]);
    assert.strictEqual(memory.forgotten.at(-1), session.state.id);
  });

  test('dispose() does not index a session that is still shown in a pane', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.setVisible([session.state.id]);
    await manager.dispose();
    assert.strictEqual(memory.indexed.length, 0);
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

suite('SessionManager handoff summary', () => {
  test('a shown session yields a summary and is never written to the store', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.setVisible([session.state.id]);
    const before = manager.summaries().find((s) => s.id === session.state.id)?.updatedAt;
    const summary = await manager.handoffSummary(session.state.id);
    assert.strictEqual(summary?.text.includes('Investigate the flaky login test'), true);
    assert.strictEqual(memory.indexed.length, 0);
    assert.strictEqual(manager.summaries().find((s) => s.id === session.state.id)?.updatedAt, before);
  });

  test('with memory off it still falls back to the extractive digest', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const manager = new SessionManager(store, providers, () => {});
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    const summary = await manager.handoffSummary(session.state.id);
    assert.strictEqual(summary?.text.includes('Investigate the flaky login test'), true);
  });

  test('an unknown session has no summary', async () => {
    const manager = new SessionManager(new TranscriptStore(await tempRoot()), new Map(), () => {});
    assert.strictEqual(await manager.handoffSummary('nope'), undefined);
  });
});
