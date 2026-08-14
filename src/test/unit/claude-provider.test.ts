import * as assert from 'assert';
import { ClaudeProvider } from '../../providers/claude/claude-provider';

/**
 * A fake replacement for claude-provider.ts's `loadQuery()` — the "query
 * factory" seam ClaudeProvider's constructor accepts specifically so tests
 * can observe whether/when/with-what-Options a query gets constructed,
 * without touching the real @anthropic-ai/claude-agent-sdk package or
 * spawning a CLI subprocess.
 */
function fakeLoadQuery() {
  const calls: { options: Record<string, unknown> }[] = [];
  let closed = false;

  const queryFn = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push({ options: params.options });
    // A minimal stand-in for the real Query: a real async generator (so
    // `for await` over it behaves correctly and terminates) with the extra
    // Query-interface methods claude-provider.ts calls bolted on.
    const gen = (async function* () {
      // No messages: the fake session just sits open until closed.
    })() as AsyncGenerator<never, void> & {
      interrupt: () => Promise<undefined>;
      setPermissionMode: () => Promise<void>;
      applyFlagSettings: () => Promise<void>;
      close: () => void;
      getContextUsage: () => Promise<{
        totalTokens: number; maxTokens: number;
        memoryFiles: { path: string; type: string; tokens: number }[];
        messageBreakdown: undefined;
      }>;
    };
    gen.interrupt = async () => undefined;
    gen.setPermissionMode = async () => { /* no-op fake */ };
    gen.applyFlagSettings = async () => { /* no-op fake */ };
    gen.close = () => { closed = true; };
    gen.getContextUsage = async () => (
      { totalTokens: 0, maxTokens: 200_000, memoryFiles: [], messageBreakdown: undefined }
    );
    return gen;
  };

  return {
    load: async () => queryFn,
    calls,
    isClosed: () => closed,
  };
}

/** Lets a queued microtask (the async IIFE inside ensureStarted) run. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

suite('ClaudeProvider (lazy start)', () => {
  test('does not construct a query until the first send()', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    assert.strictEqual(fake.calls.length, 0);

    run.send('hello');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    await run.dispose();
  });

  test("setPermissionMode('bypass') before the first send() sets both the mode and the flag at construction", async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.setPermissionMode('bypass');
    assert.strictEqual(fake.calls.length, 0, 'must not construct a query just from a mode change');

    run.send('go');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].options.permissionMode, 'bypassPermissions');
    assert.strictEqual(fake.calls[0].options.allowDangerouslySkipPermissions, true);
    await run.dispose();
  });

  test('a session that never changes mode gets no allowDangerouslySkipPermissions key at all', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].options.permissionMode, 'default');
    assert.strictEqual('allowDangerouslySkipPermissions' in fake.calls[0].options, false);
    await run.dispose();
  });

  test('dispose() before any send() resolves cleanly and starts nothing', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    await assert.doesNotReject(() => run.dispose());
    assert.strictEqual(fake.calls.length, 0);

    // The events channel must be closed even though nothing ever started —
    // otherwise a consumer's `for await (const ev of run.events)` (as
    // AgentSession.pump() does) would hang forever.
    const iterator = run.events[Symbol.asyncIterator]();
    const result = await iterator.next();
    assert.strictEqual(result.done, true);
  });

  test('interrupt() before any send() is a no-op that does not throw', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    await assert.doesNotReject(() => run.interrupt());
    assert.strictEqual(fake.calls.length, 0);
    await run.dispose();
  });

  test('a model chosen before the first send is the one the query is built with', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.setModel('haiku');
    run.send('go');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(
      fake.calls.at(-1)!.options.model, 'haiku',
      'options are built lazily on first send, so a pre-send change must win',
    );
    await run.dispose();
  });

  test('setModel() after the first send is recorded but does not rebuild the running query', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();
    run.setModel('haiku');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1, 'setModel() must not construct a second query');
    assert.strictEqual(fake.calls[0].options.model, 'opus', 'the already-running query keeps its model');
    await run.dispose();
  });

  test('setEffort()/interrupt() before send() do not construct a query either', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', effort: 'low' });

    run.setEffort('high');
    await run.interrupt();
    assert.strictEqual(fake.calls.length, 0);
    await run.dispose();
  });

  test('setEffort()/setPermissionMode() failures are logged redacted, never raw', async () => {
    // These two are the only error paths in the provider that log instead of
    // becoming a turn-end event, so they are the only ones that could put a
    // raw SDK message — which can carry a stderr tail with credentials in it
    // — into the extension-host output channel unredacted.
    const secret = 'api_key=sk-not-a-real-key-0123456789';
    const boom = () => Promise.reject(new Error(`refused: ${secret}`));

    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      const gen = (async function* () { /* stays open */ })() as AsyncGenerator<never, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
      };
      gen.interrupt = async () => undefined;
      gen.setPermissionMode = boom;
      gen.applyFlagSettings = boom;
      gen.close = () => { /* no-op fake */ };
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('go');
    await flushMicrotasks();

    const logged: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      run.setEffort('high');
      run.setPermissionMode('plan');
      await flushMicrotasks();
      await flushMicrotasks();
    } finally {
      console.warn = realWarn;
    }

    assert.strictEqual(logged.length, 2, 'both failures must still be logged, not swallowed');
    for (const line of logged) {
      assert.ok(!line.includes(secret), `logged the raw secret-bearing reason: ${line}`);
      assert.ok(line.includes('[redacted]'), `expected a redacted reason, got: ${line}`);
    }
    await run.dispose();
  });

  test('contextBreakdown()/usageWindows() reject before the first send()', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    await assert.rejects(() => run.contextBreakdown!(), /has not started yet/);
    await assert.rejects(() => run.usageWindows!(), /has not started yet/);
    await run.dispose();
  });

  test('usageWindows() rejects with a legible message when the provider does not expose the experimental usage method', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();

    await assert.rejects(() => run.usageWindows!(), /does not report plan usage/);
    await run.dispose();
  });
});
