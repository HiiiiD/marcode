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
  searches: { query: string; cwdWithin?: string; projectId?: string }[] = [];
  async search(query: string, opts: { cwdWithin?: string; projectId?: string } = {}): Promise<[]> {
    this.searches.push({ query, cwdWithin: opts.cwdWithin, projectId: opts.projectId });
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

suite('SessionManager projects', () => {
  const projects = (map: Record<string, string>) => ({
    resolve: async (cwd: string) => (map[cwd] ? { projectId: map[cwd], root: cwd } : undefined),
  });
  const make = (store: TranscriptStore, resolver?: ReturnType<typeof projects>, memory?: MemoryStore) => new SessionManager(
    store, new Map<string, AgentProvider>([['fake', new FakeProvider()]]), () => {},
    undefined, undefined, undefined, undefined, undefined, memory, undefined, undefined, undefined, resolver,
  );
  const until = async (done: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 2000;
    while (!(await done())) {
      if (Date.now() > deadline) { throw new Error('timed out'); }
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  const persisted = async (store: TranscriptStore, id: string) =>
    (await store.readIndex()).sessions.find((s) => s.id === id)?.projectId;

  test('a new session gets its project and it is persisted', async () => {
    const store = new TranscriptStore(await tempRoot());
    const manager = make(store, projects({ '/repo': 'p' }));
    const session = await manager.create('fake', '/repo');
    await until(() => session.state.projectId === 'p');
    await manager.persistNow();
    assert.strictEqual(await persisted(store, session.state.id), 'p');
    await manager.dispose();
  });

  test('a cwd change picks up the new project, and an unknown one keeps the old', async () => {
    const store = new TranscriptStore(await tempRoot());
    const manager = make(store, projects({ '/repo': 'p', '/wt': 'q' }));
    const session = await manager.create('fake', '/repo');
    await until(() => session.state.projectId === 'p');
    session.state.cwd = '/wt';
    manager.changed();
    await until(() => session.state.projectId === 'q');
    session.state.cwd = '/gone';
    manager.changed();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(session.state.projectId, 'q');
    await manager.dispose();
  });

  test('a session saved before projects existed gets one on load', async () => {
    const root = await tempRoot();
    const first = make(new TranscriptStore(root));
    const id = (await first.create('fake', '/repo')).state.id;
    await first.persistNow();
    await first.dispose();
    const store = new TranscriptStore(root);
    assert.strictEqual(await persisted(store, id), undefined);
    const second = make(store, projects({ '/repo': 'p' }));
    await second.init();
    await until(async () => { await second.persistNow(); return (await persisted(store, id)) === 'p'; });
    await second.dispose();
  });

  test('a hidden session whose project arrives late is tagged in memory', async () => {
    const memory = new RecordingMemoryStore();
    const tagged: Array<[string, string]> = [];
    (memory as MemoryStore).setProject = async (sid, pid) => { tagged.push([sid, pid]); };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { resolve: async (cwd: string) => { await gate; return cwd === '/repo' ? { projectId: 'p', root: cwd } : undefined; } };
    const manager = make(new TranscriptStore(await tempRoot()), slow, memory);
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    release();
    await until(() => tagged.length > 0);
    assert.deepStrictEqual(tagged, [[session.state.id, 'p']]);
    await manager.dispose();
  });

  test('priming also searches the caller cwd project', async () => {
    const memory = new RecordingMemoryStore();
    const manager = make(new TranscriptStore(await tempRoot()), projects({ '/w1/repo': 'p' }), memory);
    manager.setWorkspaceRoots(() => ['/w1/repo']);
    await manager.recall('investigate the flaky login test', '/w1/repo');
    assert.deepStrictEqual(memory.searches[0], { query: memory.searches[0].query, cwdWithin: '/w1/repo', projectId: 'p' });
    await manager.dispose();
  });

  test('a cwd with no project primes exactly as before', async () => {
    const memory = new RecordingMemoryStore();
    const manager = make(new TranscriptStore(await tempRoot()), projects({}), memory);
    manager.setWorkspaceRoots(() => ['/w1/repo']);
    await manager.recall('investigate the flaky login test', '/w1/repo');
    assert.strictEqual(memory.searches[0].projectId, undefined);
    assert.strictEqual(memory.searches[0].cwdWithin, '/w1/repo');
    await manager.dispose();
  });

  test('recallScopeOfSession carries the session project', async () => {
    const manager = make(new TranscriptStore(await tempRoot()), projects({ '/w1/repo': 'p' }));
    manager.setWorkspaceRoots(() => ['/w1']);
    const session = await manager.create('fake', '/w1/repo');
    assert.deepStrictEqual(await manager.recallScopeOfSession(session.state.id), { cwdWithin: '/w1', projectId: 'p' });
    await manager.dispose();
  });
});
