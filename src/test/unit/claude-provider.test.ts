import * as assert from 'assert';
import { ClaudeProvider } from '../../providers/claude/claude-provider';
import type { AgentEvent } from '../../providers/types';

/** A server-status shape matching the SDK's `Query.mcpServerStatus()` return type. */
type FakeSdkServerStatus = {
  name: string;
  status: string;
  tools?: { name: string }[];
  error?: string;
};

/**
 * A fake replacement for claude-provider.ts's `loadQuery()` — the "query
 * factory" seam ClaudeProvider's constructor accepts specifically so tests
 * can observe whether/when/with-what-Options a query gets constructed,
 * without touching the real @anthropic-ai/claude-agent-sdk package or
 * spawning a CLI subprocess.
 */
function fakeLoadQuery(opts: { mcpServerStatus?: () => Promise<FakeSdkServerStatus[]> } = {}) {
  const calls: { options: Record<string, unknown> }[] = [];
  let closed = false;

  const queryFn = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push({ options: params.options });
    // A minimal stand-in for the real Query: a real async generator (so
    // `for await` over it behaves correctly and terminates) with the extra
    // Query-interface methods claude-provider.ts calls bolted on.
    //
    // The generator body genuinely blocks (on a promise only `close()` can
    // resolve) — an *empty* `async function*` body (no yield, no await)
    // completes on its very first `next()`, which would race
    // claude-provider.ts's fire-and-forget `mcpServerStatus()` pull against
    // the pump's own `finally { events.close() }` on every test run.
    // Blocking here is what "sits open until closed" actually requires, and
    // `close()` unblocking it (rather than merely flipping a flag) is what
    // lets `dispose()`'s `await pump` ever resolve.
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    const gen = (async function* () {
      await stopSignal;
    })() as AsyncGenerator<never, void> & {
      interrupt: () => Promise<undefined>;
      setPermissionMode: () => Promise<void>;
      applyFlagSettings: () => Promise<void>;
      close: () => void;
      mcpServerStatus: () => Promise<FakeSdkServerStatus[]>;
    };
    gen.interrupt = async () => undefined;
    gen.setPermissionMode = async () => { /* no-op fake */ };
    gen.applyFlagSettings = async () => { /* no-op fake */ };
    gen.close = () => { closed = true; stop(); };
    gen.mcpServerStatus = opts.mcpServerStatus ?? (async () => []);
    return gen;
  };

  return {
    load: async () => queryFn,
    calls,
    isClosed: () => closed,
  };
}

/** Runs the macrotask queue once — enough for any pending microtask chain (e.g. an async `.then()` chain) to settle. */
async function flushMacrotask() {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** Pulls whatever is already queued on `run.events` without blocking if nothing is there yet. */
async function drainAvailableEvents(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const it = run.events[Symbol.asyncIterator]();
  const out: AgentEvent[] = [];
  for (;;) {
    const sentinel = Symbol('none');
    const result = await Promise.race([
      it.next(),
      new Promise<typeof sentinel>((resolve) => { setImmediate(() => resolve(sentinel)); }),
    ]);
    if (result === sentinel) { break; }
    const { done, value } = result as IteratorResult<AgentEvent>;
    if (done) { break; }
    out.push(value);
  }
  return out;
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

  test('never enables forwardSubagentText on the real Options handed to query()', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('hello');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(
      'forwardSubagentText' in fake.calls[0].options, false,
      'enabling this streams every subagent token into the transcript, which is exactly what the nested-card design avoids',
    );
    await run.dispose();
  });
});

suite('ClaudeProvider mcpServerStatus pull', () => {
  test('supersedes the init snapshot with the richer per-server shape once the query exists', async () => {
    const fake = fakeLoadQuery({
      mcpServerStatus: async () => [
        { name: 'filesystem', status: 'connected', tools: [{ name: 'read' }, { name: 'write' }] },
        { name: 'flaky', status: 'failed', error: 'connect ECONNREFUSED api_key=sk-not-a-real-key-0123456789' },
        // A future SDK bump could add a status our union doesn't know about.
        { name: 'newfangled', status: 'starting-up-in-a-way-we-have-never-seen' },
      ],
    });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    const mcpEvent = events.find((e): e is Extract<AgentEvent, { kind: 'mcp-servers' }> => e.kind === 'mcp-servers');
    assert.ok(mcpEvent, `expected an mcp-servers event, got: ${JSON.stringify(events)}`);
    assert.deepStrictEqual(mcpEvent.servers, [
      { name: 'filesystem', state: 'connected', toolCount: 2 },
      { name: 'flaky', state: 'failed', error: 'connect ECONNREFUSED [redacted]' },
      { name: 'newfangled', state: 'pending' },
    ]);
    await run.dispose();
  });

  test('an empty server list pushes no event', async () => {
    const fake = fakeLoadQuery({ mcpServerStatus: async () => [] });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    assert.ok(
      events.every((e) => e.kind !== 'mcp-servers'),
      `expected no mcp-servers event for an empty list, got: ${JSON.stringify(events)}`,
    );
    await run.dispose();
  });

  test('a rejected pull is swallowed: no turn-end error, no unhandled rejection', async () => {
    const fake = fakeLoadQuery({ mcpServerStatus: async () => { throw new Error('boom'); } });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    assert.deepStrictEqual(
      events, [],
      'a failed status pull must degrade silently (keep the coarser init snapshot), never surface as a turn-end error',
    );
    await assert.doesNotReject(() => run.dispose());
  });

  test('a synchronous throw from mcpServerStatus() itself does not abort the pump', async () => {
    // Distinct from the rejection case above: this simulates the call itself
    // throwing (e.g. an already-torn-down transport) rather than returning a
    // rejected promise. Left unguarded, this would propagate out of the
    // pump's outer try and turn the whole run into a turn-end error before a
    // single message is ever read.
    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      let stop!: () => void;
      const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
      const gen = (async function* () {
        await stopSignal;
      })() as AsyncGenerator<never, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
        mcpServerStatus: () => Promise<unknown[]>;
      };
      gen.interrupt = async () => undefined;
      gen.setPermissionMode = async () => { /* no-op fake */ };
      gen.applyFlagSettings = async () => { /* no-op fake */ };
      gen.close = () => { stop(); };
      gen.mcpServerStatus = (() => { throw new Error('transport already closed'); }) as never;
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    assert.deepStrictEqual(events, [], 'must degrade silently, not become a turn-end error');
    await assert.doesNotReject(() => run.dispose());
  });

  test('a status that resolves after dispose() is not pushed onto a dead run', async () => {
    let resolveStatus!: (servers: { name: string; status: string }[]) => void;
    const fake = fakeLoadQuery({
      mcpServerStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
    });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    await run.dispose();

    resolveStatus([{ name: 'late', status: 'connected' }]);
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    assert.deepStrictEqual(events, [], 'a status pull that resolves after dispose() must not be pushed');
  });

  test('listInvocables constructs a query, reads the catalog and closes it', async () => {
    let closed = false;
    let constructedCwd: string | undefined;
    const provider = new ClaudeProvider((async () => (params: { options: { cwd?: string } }) => {
      constructedCwd = params.options.cwd;
      return {
        supportedCommands: async () => [
          { name: 'init', description: 'Init', argumentHint: '' },
        ],
        close: () => { closed = true; },
        [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
      };
    }) as never);

    const out = await provider.listInvocables('/repo');

    assert.deepStrictEqual(out, [{ name: 'init', description: 'Init' }]);
    assert.strictEqual(constructedCwd, '/repo');
    assert.strictEqual(closed, true, 'the probe query must not outlive the answer');
  });

  test('listInvocables closes the query even when the catalog read fails', async () => {
    let closed = false;
    const provider = new ClaudeProvider((async () => () => ({
      supportedCommands: async () => { throw new Error('control request failed'); },
      close: () => { closed = true; },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    })) as never);

    await assert.rejects(() => provider.listInvocables('/repo'), /control request failed/);
    assert.strictEqual(closed, true);
  });

  /** A provider whose probe answers `supportedModels()` with `models`. */
  function providerWithModels(models: unknown[], onClose?: () => void) {
    return new ClaudeProvider((async () => () => ({
      supportedModels: async () => models,
      close: () => { onClose?.(); },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    })) as never);
  }

  test('fetchModels replaces the fallback list with what the CLI reports', async () => {
    let closed = false;
    const provider = providerWithModels([
      {
        value: 'claude-fable-5', displayName: 'Fable 5', description: '',
        supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      { value: 'haiku', displayName: 'Haiku 4.5', description: '' },
    ], () => { closed = true; });

    assert.strictEqual(
      provider.listModels().some((m) => m.id === 'claude-fable-5'), false,
      'precondition: the fallback list is what is served before a probe',
    );

    const out = await provider.fetchModels('/repo');

    assert.deepStrictEqual(out, [
      {
        id: 'claude-fable-5', displayName: 'Fable 5',
        effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      },
      { id: 'haiku', displayName: 'Haiku 4.5', effort: undefined },
    ]);
    assert.deepStrictEqual(provider.listModels(), out, 'the answer must stick');
    assert.strictEqual(closed, true, 'the probe query must not outlive the answer');
  });

  test('fetchModels defaults effort to the deepest level a model offers when it has no high', async () => {
    const provider = providerWithModels([
      {
        value: 'terse', displayName: 'Terse', description: '',
        supportsEffort: true, supportedEffortLevels: ['low', 'medium'],
      },
    ]);

    const [model] = await provider.fetchModels('/repo');

    assert.deepStrictEqual(model.effort, { levels: ['low', 'medium'], default: 'medium' });
  });

  test('an empty catalog leaves the fallback list in place', async () => {
    const provider = providerWithModels([]);
    const fallback = provider.listModels();

    const out = await provider.fetchModels('/repo');

    assert.deepStrictEqual(out, fallback, 'an empty picker is worse than a stale one');
  });

  test('fetchModels closes the query even when the model read fails', async () => {
    let closed = false;
    const provider = new ClaudeProvider((async () => () => ({
      supportedModels: async () => { throw new Error('control request failed'); },
      close: () => { closed = true; },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    })) as never);

    await assert.rejects(() => provider.fetchModels('/repo'), /control request failed/);
    assert.strictEqual(closed, true);
  });
});
