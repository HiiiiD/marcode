import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SessionState } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, ModelInfo } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager', () => {
  let dir: string;
  let store: TranscriptStore;
  let sent: HostToWebview[];
  let providers: Map<string, AgentProvider>;
  let manager: SessionManager;
  let extra: { manager: SessionManager; dir: string }[];

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
    extra = [];
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    for (const e of extra) {
      await e.manager.dispose();
      await fs.rm(e.dir, { recursive: true, force: true });
    }
  });

  /**
   * A standalone manager + FakeProvider pair, isolated in its own temp dir,
   * for tests that need the concrete FakeProvider (invocables script,
   * listInvocablesCalls) rather than the AgentProvider-typed `providers` map
   * from setup(). Cleaned up in teardown alongside the suite-level manager.
   */
  async function makeManager() {
    const mdir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-manager-'));
    const mstore = new TranscriptStore(mdir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const mproviders = new Map<string, AgentProvider>([['fake', provider]]);
    const emitted: HostToWebview[] = [];
    const mmanager = new SessionManager(mstore, mproviders, (m) => emitted.push(m));
    await mmanager.init();
    extra.push({ manager: mmanager, dir: mdir });
    return { manager: mmanager, provider, emitted, store: mstore };
  }

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

  test('a snapshot sequence number is never reused, so a long-stalled fetch cannot claim a later one\'s turn (ABA)', async () => {
    // The sequence counter must be global and monotonic. A per-id counter
    // reset whenever its entry is deleted makes numbers reusable: with fetch
    // #1 still in flight, a second reveal that completes and drains resets the
    // counter, so a third reveal reissues the same number fetch #1 is holding.
    // Fetch #1 would then pass the staleness check, emit its long-stale
    // snapshot and drain fetch #3's buffer — the clobber, via ABA.
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    sent.length = 0;

    const realTail = store.tail.bind(store);
    const releases: (() => void)[] = [];
    const startSignals: (() => void)[] = [];
    const started = [0, 1, 2].map(
      () => new Promise<void>((r) => startSignals.push(r)),
    );
    let call = 0;
    (store as unknown as { tail: typeof store.tail }).tail = async (
      ...args: Parameters<typeof store.tail>
    ) => {
      // Tag each fetch's result so a stale snapshot is identifiable by
      // content — the ABA failure emits fetch #1's items, not fetch #3's,
      // and every fetch here otherwise returns an identical transcript.
      const which = call;
      startSignals[Math.min(call++, startSignals.length - 1)]?.();
      await new Promise<void>((resolve) => { releases.push(resolve); });
      const real = await realTail(...args);
      return {
        ...real,
        items: [
          ...real.items,
          { id: `fetch-${which}`, ts: 0, role: 'error' as const, message: 'tag' },
        ],
      };
    };

    try {
      const first = manager.setVisible([id]); // fetch #1: stalls for the whole test
      await started[0];

      await manager.setVisible([]);
      const second = manager.setVisible([id]); // fetch #2
      await started[1];
      releases[1]?.();
      await second;                            // completes and drains: counter reset
      await settle();

      await manager.setVisible([]);
      const third = manager.setVisible([id]);  // fetch #3: reissues the reused number
      await started[2];

      a.send('hello');                         // patch buffered by fetch #3
      await settle();

      releases[0]?.();                         // fetch #1 resumes — must emit nothing
      await first;
      await settle();

      releases[2]?.();
      await third;
      await settle();
    } finally {
      (store as unknown as { tail: typeof store.tail }).tail = realTail;
    }

    const snapshots = sent.filter((m) => m.t === 'session-snapshot');
    const tags = snapshots.flatMap(
      (m) => m.session.items.filter((i) => i.id.startsWith('fetch-')).map((i) => i.id),
    );
    assert.ok(
      !tags.includes('fetch-0'),
      `fetch #1's long-stale snapshot must never be emitted, but was: ${tags.join(', ')}`,
    );
    assert.ok(
      sent.some((m) => m.t === 'session-patch' && m.id === id),
      'the patch buffered by the newest fetch must not be lost',
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

  test('contextBreakdown answers ok for a live session with a reporting run', async () => {
    const provider = new FakeProvider(() => [], {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
      },
    });
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    const session = await local.create('fake', '/tmp');

    const result = await local.contextBreakdown(session.state.id);

    // `assert.fail` returns `never`, which narrows the union for the line
    // below; `assert.ok(result.ok)` would not.
    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.breakdown.freePercent, 57);
    await local.dispose();
  });

  test('contextBreakdown answers not-ok for an unknown session', async () => {
    const result = await manager.contextBreakdown('nope');
    assert.strictEqual(result.ok, false);
  });

  test('canOpenFile vouches only for paths the session itself reported', async () => {
    const provider = new FakeProvider(() => [], {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
      },
    });
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    const id = (await local.create('fake', '/tmp')).state.id;

    assert.strictEqual(
      local.canOpenFile(id, '/repo/CLAUDE.md'), false,
      'a session that has reported nothing vouches for nothing',
    );

    await local.contextBreakdown(id);

    assert.strictEqual(local.canOpenFile(id, '/repo/CLAUDE.md'), true);
    assert.strictEqual(local.canOpenFile(id, '/etc/passwd'), false);
    assert.strictEqual(local.canOpenFile('nope', '/repo/CLAUDE.md'), false);
    await local.dispose();
  });

  test('usageWindows resolves a provider through any one live session', async () => {
    // FakeReports.windows now arrives as pushed usage-window events (see
    // fake-provider.test.ts), not through this pull method, so the pull path
    // is exercised here by stubbing the session directly — same as the
    // 'tries the next live session' test below does for its refusing session.
    const provider = new FakeProvider();
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    const session = await local.create('fake', '/tmp');
    Object.defineProperty(session, 'usageWindows', {
      value: async () => [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });

    const result = await local.usageWindows('fake');

    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.windows[0].usedPercent, 62);
    await local.dispose();
  });

  test('usageWindows tries the next live session when the first cannot answer', async () => {
    // A Claude session that has never been sent a message rejects with
    // 'This session has not started yet'. If it happens to be first in
    // `live`, the account is not unknown — the next live session of the same
    // provider can still speak for it.
    const provider = new FakeProvider();
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    const first = await local.create('fake', '/tmp');
    const second = await local.create('fake', '/tmp');
    // Only the first session refuses; everything else about it is untouched.
    Object.defineProperty(first, 'usageWindows', {
      value: async () => { throw new Error('This session has not started yet'); },
    });
    Object.defineProperty(second, 'usageWindows', {
      value: async () => [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });

    const result = await local.usageWindows('fake');

    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.windows[0].usedPercent, 62);
    await local.dispose();
  });

  test('usageWindows reports the last failure when every live session refuses', async () => {
    const provider = new FakeProvider(() => []);
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    await local.create('fake', '/tmp');

    const result = await local.usageWindows('fake');

    if (result.ok) { assert.fail('an unscripted fake reports no windows'); }
    assert.match(result.reason, /does not report plan usage/);
    await local.dispose();
  });

  test('usageWindows answers not-ok when no session of that provider is live', async () => {
    const result = await manager.usageWindows('claude');
    if (result.ok) { assert.fail('expected no live session for this provider'); }
    assert.match(result.reason, /No active session/);
  });

  test('session-mcp reaches a visible session and is withheld from a hidden one', async () => {
    const a = await manager.create('fake', '/tmp');
    const b = await manager.create('fake', '/tmp');
    await manager.setVisible([a.state.id]);
    sent.length = 0;

    manager.mcp(a.state.id, [{ name: 'github', state: 'connected', toolCount: 12 }]);
    manager.mcp(b.state.id, [{ name: 'github', state: 'connected', toolCount: 12 }]);

    const emitted = sent.filter((m) => m.t === 'session-mcp');
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual((emitted[0] as { id: string }).id, a.state.id);
  });

  test('an archived session snapshot reports no mcp servers', async () => {
    const a = await manager.create('fake', '/tmp');
    a.send('hello');
    await settle();
    const id = a.state.id;
    await manager.close(id);
    sent.length = 0;

    await manager.setVisible([id]);
    const snapshot = sent.find((m) => m.t === 'session-snapshot');
    assert.ok(snapshot);
    assert.deepStrictEqual(
      (snapshot as { session: { mcpServers: unknown[] } }).session.mcpServers, [],
    );
  });

  test('creating a session probes its cwd and emits the catalog to a visible pane', async () => {
    const { manager, provider, emitted } = await makeManager();
    provider.invocables = [{ name: 'init' }];

    const session = await manager.create('fake', '/repo');
    await manager.setVisible([session.state.id]);
    await settle();

    assert.deepStrictEqual(
      emitted.filter((m) => m.t === 'session-invocables'),
      [{ t: 'session-invocables', id: session.state.id, entries: [{ name: 'init' }] }],
    );
  });

  test('a second session on the same cwd reuses the cached catalog', async () => {
    const { manager, provider } = await makeManager();
    provider.invocables = [{ name: 'init' }];

    const first = await manager.create('fake', '/repo');
    await settle();
    const second = await manager.create('fake', '/repo');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
    assert.deepStrictEqual((await first.snapshot()).invocables, [{ name: 'init' }]);
    assert.deepStrictEqual((await second.snapshot()).invocables, [{ name: 'init' }]);
  });

  test('a live invocables event refreshes every session on that cwd', async () => {
    const { manager, provider } = await makeManager();
    provider.invocables = [{ name: 'stale' }];
    const first = await manager.create('fake', '/repo');
    const second = await manager.create('fake', '/repo');
    await settle();

    // The event arrives on the FIRST session's run; the second must learn it too.
    provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'fresh' }] });
    await settle();

    assert.deepStrictEqual((await first.snapshot()).invocables, [{ name: 'fresh' }]);
    assert.deepStrictEqual((await second.snapshot()).invocables, [{ name: 'fresh' }]);
  });

  test('a hidden session gets no session-invocables message', async () => {
    const { manager, provider, emitted } = await makeManager();
    provider.invocables = [{ name: 'init' }];

    await manager.create('fake', '/repo');
    await settle();

    assert.deepStrictEqual(emitted.filter((m) => m.t === 'session-invocables'), []);
  });

  test('an archived pane is served the cwd catalog from cache', async () => {
    const { manager, provider, emitted } = await makeManager();
    provider.invocables = [{ name: 'init' }];
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    await settle();
    await manager.close(id);
    emitted.length = 0;

    await manager.setVisible([id]);
    await settle();

    const snap = emitted.find((m) => m.t === 'session-snapshot');
    assert.deepStrictEqual(snap?.session.invocables, [{ name: 'init' }]);
  });

  test('revealing an archived session on an unprobed cwd triggers exactly one probe', async () => {
    // Simulate a window reload: a fresh SessionManager restores the session
    // from the on-disk index (never live in this manager instance, so its
    // catalog cache starts empty), then the pane is revealed without ever
    // going through create()/open().
    const a = await manager.create('fake', '/repo');
    const id = a.state.id;
    await settle();
    await manager.close(id);
    await manager.dispose();

    const freshProvider = new FakeProvider(() => []);
    freshProvider.invocables = [{ name: 'init' }];
    const freshProviders = new Map<string, AgentProvider>([['fake', freshProvider]]);
    const freshSent: HostToWebview[] = [];
    const fresh = new SessionManager(new TranscriptStore(dir), freshProviders, (m) => freshSent.push(m));
    await fresh.init();

    await fresh.setVisible([id]);
    await settle();

    assert.deepStrictEqual(freshProvider.listInvocablesCalls, ['/repo']);
    await fresh.dispose();
  });

  test('a sibling\'s invocables event during an in-flight reveal snapshot does not jump the session-snapshot, and does not double-fire', async () => {
    const { manager: m, provider, emitted, store: mstore } = await makeManager();
    provider.invocables = [{ name: 'init' }];
    const x = await m.create('fake', '/repo'); // sibling, whose run fires the live event
    const y = await m.create('fake', '/repo'); // the session being revealed
    await settle();
    emitted.length = 0;

    // Pause store.tail() so setVisible()'s session.snapshot() for y stalls
    // mid-flight, mirroring the existing patch-buffering tests above.
    const realTail = mstore.tail.bind(mstore);
    let releaseTail: (() => void) | undefined;
    let tailStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { tailStarted = resolve; });
    (mstore as unknown as { tail: typeof mstore.tail }).tail = async (
      ...args: Parameters<typeof mstore.tail>
    ) => {
      tailStarted?.();
      await new Promise<void>((resolve) => { releaseTail = resolve; });
      return realTail(...args);
    };

    try {
      const visiblePromise = m.setVisible([y.state.id]);
      await started; // y's snapshot fetch is now in flight

      // x shares y's providerId+cwd and reports a fresh catalog mid-flight —
      // a live agent discovering skills while y's reveal is still pending.
      provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'fresh' }] });
      await settle();

      releaseTail?.();
      await visiblePromise;
    } finally {
      (mstore as unknown as { tail: typeof mstore.tail }).tail = realTail;
    }

    const order = emitted.map((msg) => msg.t);
    const snapIdx = order.indexOf('session-snapshot');
    const invIdx = order.indexOf('session-invocables');
    assert.ok(snapIdx >= 0, 'the snapshot must be emitted');
    assert.ok(invIdx >= 0, 'the invocables message must be emitted');
    assert.ok(snapIdx < invIdx, 'session-invocables must not arrive before its session-snapshot');
    assert.strictEqual(
      order.filter((t) => t === 'session-invocables').length, 1,
      'the reveal must not double-fire session-invocables',
    );
  });
  test('a session restored without the flag defaults to attaching context', async () => {
    const store2 = new TranscriptStore(dir);
    // Written by a build that predates includeEditorContext.
    await store2.writeIndex({
      sessions: [{
        id: 'legacy', providerId: 'fake', model: 'fake-small', title: 'Old',
        cwd: '/tmp', status: 'idle', permissionMode: 'default',
        usage: { inputTokens: 0, outputTokens: 0 },
        archived: false, createdAt: 1, updatedAt: 1,
      } as unknown as SessionState],
      layout: { orientation: 'vertical', panes: [] },
    });

    const restored = new SessionManager(store2, providers, () => {});
    await restored.init();
    assert.strictEqual(restored.summaries()[0].includeEditorContext, true);
    await restored.dispose();
  });

  /**
   * A provider whose model list is only correct after `fetchModels` — the
   * shape of every real backend, where the catalog lives in the CLI.
   */
  function modelProvider(id: string, onFetch?: () => Promise<never>): AgentProvider {
    let models: ModelInfo[] = [{ id: 'stale', displayName: 'Stale' }];
    return {
      id, displayName: id,
      listModels: () => models,
      fetchModels: async (cwd: string) => {
        if (onFetch) { await onFetch(); }
        models = [{ id: `fresh-${cwd}`, displayName: 'Fresh' }];
        return models;
      },
      start: () => { throw new Error('not used'); },
    };
  }

  test('refreshModels probes the providers and re-announces the catalog', async () => {
    const emitted: HostToWebview[] = [];
    const m = new SessionManager(
      new TranscriptStore(dir), new Map([['claude', modelProvider('claude')]]), (msg) => emitted.push(msg),
    );
    await m.init();

    await m.refreshModels('/repo');

    const catalogs = emitted.filter((msg) => msg.t === 'catalog') as
      Extract<HostToWebview, { t: 'catalog' }>[];
    assert.strictEqual(catalogs.length, 1, 'one emit for the whole catalog, not one per provider');
    assert.deepStrictEqual(catalogs[0].catalog, [{
      id: 'claude', displayName: 'claude',
      models: [{ id: 'fresh-/repo', displayName: 'Fresh' }],
    }]);
    await m.dispose();
  });

  test('a failed model probe leaves the provider fallback in place and still announces', async () => {
    const emitted: HostToWebview[] = [];
    const failing = modelProvider('claude', () => Promise.reject(new Error('no CLI')));
    const m = new SessionManager(
      new TranscriptStore(dir), new Map([['claude', failing]]), (msg) => emitted.push(msg),
    );
    await m.init();

    await assert.doesNotReject(() => m.refreshModels('/repo'));

    const catalogs = emitted.filter((msg) => msg.t === 'catalog') as
      Extract<HostToWebview, { t: 'catalog' }>[];
    assert.deepStrictEqual(catalogs[0].catalog[0].models, [{ id: 'stale', displayName: 'Stale' }]);
    await m.dispose();
  });

  test('create resolves a requested wire id onto the alias row covering it', async () => {
    const aliasProvider: AgentProvider = {
      id: 'claude', displayName: 'Claude',
      listModels: () => [
        { id: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5',
          effort: { levels: ['low', 'high'], default: 'high' } },
      ],
      // create() materializes an AgentSession, which starts a run — delegate
      // to the FakeProvider rather than reimplementing AgentRun here.
      start: (opts) => new FakeProvider(() => []).start(opts),
    };
    const m = new SessionManager(
      new TranscriptStore(dir), new Map([['claude', aliasProvider]]), () => {},
    );
    await m.init();

    const session = await m.create('claude', '/repo', 'claude-opus-5', 'low');

    assert.strictEqual(session.state.model, 'opus',
      'a session pinned to a wire id must land on the row the picker renders');
    assert.strictEqual(session.state.effort, 'low');
    await m.dispose();
  });

  test('refreshModels emits nothing when no provider can answer', async () => {
    const emitted: HostToWebview[] = [];
    const m = new SessionManager(new TranscriptStore(dir), providers, (msg) => emitted.push(msg));
    await m.init();

    await m.refreshModels('/repo');

    assert.deepStrictEqual(emitted.filter((msg) => msg.t === 'catalog'), []);
    await m.dispose();
  });
});
