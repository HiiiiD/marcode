import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager', () => {
  let dir: string;
  let store: TranscriptStore;
  let sent: HostToWebview[];
  let providers: Map<string, AgentProvider>;
  let manager: SessionManager;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-manager-'));
    store = new TranscriptStore(dir);
    sent = [];
    providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    manager = new SessionManager(store, providers, (m) => sent.push(m));
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('create adds a session and announces the roster', async () => {
    const session = await manager.create('fake', '/tmp');
    assert.strictEqual(manager.summaries().length, 1);
    assert.strictEqual(manager.get(session.state.id), session);
    assert.ok(sent.some((m) => m.t === 'sessions-changed'));
  });

  test('patches reach visible sessions only', async () => {
    const a = await manager.create('fake', '/tmp');
    const b = await manager.create('fake', '/tmp');
    await manager.setVisible([a.state.id]);
    sent.length = 0;

    a.send('hello');
    b.send('hello');
    await settle();

    const patched = sent.filter((m) => m.t === 'session-patch') as
      Extract<HostToWebview, { t: 'session-patch' }>[];
    assert.ok(patched.length > 0);
    assert.ok(patched.every((m) => m.id === a.state.id),
      'no patch should be emitted for the hidden session');
  });

  test('status is announced for hidden sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    await manager.setVisible([]);
    sent.length = 0;

    a.send('hello');
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-status' && m.id === a.state.id));
  });

  test('setVisible emits a snapshot for newly visible sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    a.send('hello');
    await settle();
    sent.length = 0;

    await manager.setVisible([a.state.id]);
    const snaps = sent.filter((m) => m.t === 'session-snapshot');
    assert.strictEqual(snaps.length, 1);
  });

  test('a patch arriving while a snapshot fetch is in flight is buffered and replayed after the snapshot, not lost', async () => {
    const a = await manager.create('fake', '/tmp');
    sent.length = 0;

    // Pause session.snapshot()'s underlying store.tail() call so we can
    // deterministically fire a patch (via a.send()) while setVisible() is
    // still awaiting the snapshot for this id, then release it.
    const realTail = store.tail.bind(store);
    let releaseTail: (() => void) | undefined;
    let tailStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { tailStarted = resolve; });
    (store as unknown as { tail: typeof store.tail }).tail = async (
      ...args: Parameters<typeof store.tail>
    ) => {
      tailStarted?.();
      await new Promise<void>((resolve) => { releaseTail = resolve; });
      return realTail(...args);
    };

    try {
      const visiblePromise = manager.setVisible([a.state.id]);
      await started; // setVisible() is now mid session.snapshot() -> store.tail().
      a.send('hello'); // appends a user item, emitting a patch synchronously.
      await settle();
      releaseTail?.();
      await visiblePromise;
    } finally {
      (store as unknown as { tail: typeof store.tail }).tail = realTail;
    }

    const snapIdx = sent.findIndex((m) => m.t === 'session-snapshot');
    const patchIdx = sent.findIndex((m) => m.t === 'session-patch');
    assert.ok(snapIdx >= 0, 'the snapshot must be emitted');
    assert.ok(patchIdx >= 0, 'the patch must not be lost');
    assert.ok(patchIdx > snapIdx, 'the patch must arrive after the snapshot, not before');
  });

  test('a re-entrant setVisible() does not let a stale snapshot clobber the newer one\'s patches', async () => {
    // Unchecking then re-checking a streaming session in the roster picker:
    // setVisible([a]) is still awaiting its snapshot when setVisible([]) and
    // a second setVisible([a]) run. The first call's now-stale snapshot must
    // not be emitted after the newer call has replayed its buffered patches.
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    sent.length = 0;

    const realTail = store.tail.bind(store);
    const releases: (() => void)[] = [];
    const startSignals: (() => void)[] = [];
    const started = [
      new Promise<void>((r) => startSignals.push(r)),
      new Promise<void>((r) => startSignals.push(r)),
    ];
    let call = 0;
    (store as unknown as { tail: typeof store.tail }).tail = async (
      ...args: Parameters<typeof store.tail>
    ) => {
      startSignals[Math.min(call++, startSignals.length - 1)]?.();
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return realTail(...args);
    };

    try {
      const first = manager.setVisible([id]);
      await started[0]; // first snapshot fetch is in flight

      await manager.setVisible([]); // id leaves the visible set
      const third = manager.setVisible([id]); // id comes back: buffer replaced
      await started[1];

      a.send('hello'); // patch buffered by the newest invocation
      await settle();

      releases[0]?.(); // the stale first call resumes and emits its snapshot
      await first;
      await settle();

      releases[1]?.();
      await third;
      await settle();
    } finally {
      (store as unknown as { tail: typeof store.tail }).tail = realTail;
    }

    const lastSnapshot = sent.map((m) => m.t).lastIndexOf('session-snapshot');
    const firstPatch = sent.findIndex((m) => m.t === 'session-patch' && m.id === id);
    assert.ok(firstPatch >= 0, 'the patch must not be lost');
    assert.ok(lastSnapshot >= 0, 'a snapshot must be emitted');
    assert.ok(
      firstPatch > lastSnapshot,
      'no snapshot may be emitted after a patch it predates — it wholesale replaces the pane',
    );
  });

  test('sink calls after dispose() do not arm a persist timer', async () => {
    const a = await manager.create('fake', '/tmp');
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });

    // Simulate a sink call landing after dispose() has resolved (e.g. from
    // a provider event still draining during an earlier session.dispose()).
    // This must not arm a new persist timer that later recreates the
    // directory the caller already tore down.
    manager.changed();
    manager.status(a.state.id, 'idle');

    await new Promise((r) => setTimeout(r, 600));
    const exists = await fs.access(dir).then(() => true, () => false);
    assert.strictEqual(exists, false, 'a stray persist timer recreated the removed root directory');
  });

  test('close archives and keeps the transcript; remove deletes it', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    a.send('hello');
    await settle();

    await manager.close(id);
    assert.strictEqual(manager.get(id), undefined, 'closed session is not live');
    const summary = manager.summaries().find((s) => s.id === id);
    assert.strictEqual(summary?.archived, true);
    const kept = await store.tail(id);
    assert.ok(kept.items.length > 0, 'transcript survives close');

    await manager.remove(id);
    assert.strictEqual(manager.summaries().find((s) => s.id === id), undefined);
    const gone = await store.tail(id);
    assert.strictEqual(gone.items.length, 0);
  });

  test('init restores sessions and layout from the index', async () => {
    const a = await manager.create('fake', '/tmp');
    manager.setLayout({
      orientation: 'horizontal',
      panes: [{ sessionId: a.state.id, size: 100 }],
    });
    await manager.dispose();

    const fresh = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await fresh.init();
    assert.strictEqual(fresh.summaries().length, 1);
    assert.strictEqual(fresh.layout().orientation, 'horizontal');
    assert.strictEqual(fresh.get(a.state.id), undefined,
      'restored sessions are not live until opened');
    await fresh.dispose();
  });

  test('open revives an archived session as live', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    await manager.close(id);

    const revived = await manager.open(id);
    assert.strictEqual(revived.state.archived, false);
    assert.strictEqual(manager.get(id), revived);
  });
});
