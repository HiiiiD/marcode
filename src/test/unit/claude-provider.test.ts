import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeProvider } from '../../providers/claude/claude-provider';
import type { AgentEvent } from '../../providers/types';

/** The subset of the SDK's real `CanUseTool` signature these tests drive directly. */
type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; signal: AbortSignal; requestId: string },
) => Promise<unknown>;

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
function fakeLoadQuery(opts: {
  mcpServerStatus?: () => Promise<FakeSdkServerStatus[]>;
  /** Stands in for `Query.setModel`. Default records and resolves; a test that
   * wants the failure path supplies one that rejects or throws. */
  setModel?: (model?: string) => Promise<void>;
  /** What `supportedModels()` answers, for a test that seeds the catalog. */
  models?: unknown[];
  /** Observes the `options` object passed to every fake `query()` call. */
  onQuery?: (options: unknown) => void;
} = {}) {
  const calls: { options: Record<string, unknown>; prompt: AsyncIterable<unknown> }[] = [];
  /** Every model pushed at the *running* query, in order. */
  const setModels: (string | undefined)[] = [];
  /** Every settings patch pushed at the *running* query via applyFlagSettings, in order. */
  const flagSettings: Record<string, unknown>[] = [];
  let closed = false;

  const queryFn = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push({ options: params.options, prompt: params.prompt });
    opts.onQuery?.(params.options);
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
      applyFlagSettings: (patch: Record<string, unknown>) => Promise<void>;
      setModel: (model?: string) => Promise<void>;
      close: () => void;
      mcpServerStatus: () => Promise<FakeSdkServerStatus[]>;
      supportedModels: () => Promise<unknown[]>;
    };
    gen.interrupt = async () => undefined;
    gen.setPermissionMode = async () => { /* no-op fake */ };
    gen.applyFlagSettings = async (patch: Record<string, unknown>) => { flagSettings.push(patch); };
    gen.setModel = (model?: string) => {
      setModels.push(model);
      return opts.setModel ? opts.setModel(model) : Promise.resolve();
    };
    gen.close = () => { closed = true; stop(); };
    gen.mcpServerStatus = opts.mcpServerStatus ?? (async () => []);
    gen.supportedModels = async () => opts.models ?? [];
    return gen;
  };

  return {
    load: async () => queryFn,
    calls,
    setModels,
    flagSettings,
    isClosed: () => closed,
  };
}

/** A plausible `supportedModels()` answer: one model with effort, one without. */
const CATALOG = [
  {
    value: 'claude-opus-5', displayName: 'Opus 5', description: '',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', displayName: 'Haiku 4.5', description: '' },
];

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

/**
 * Subscribes to `run.events` immediately and returns a getter for everything
 * received so far. Needed for the question tests below because they invoke
 * `canUseTool` directly rather than driving it through the fake query, so
 * events must be captured as they arrive rather than pulled after the fact
 * (as `drainAvailableEvents` does).
 */
function collect(run: { events: AsyncIterable<AgentEvent> }): () => AgentEvent[] {
  const out: AgentEvent[] = [];
  void (async () => {
    for await (const e of run.events) { out.push(e); }
  })();
  return () => out;
}

/** Flushes microtasks and one macrotask — enough for a Channel push to reach an async-iterating consumer. */
async function tick(): Promise<void> {
  await flushMacrotask();
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

  test('setModel() after the first send pushes the model at the running query', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();
    run.setModel('haiku');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1, 'setModel() must not construct a second query');
    assert.deepStrictEqual(fake.setModels, ['haiku'], 'the live query is told about the switch');
    assert.strictEqual(
      fake.calls[0].options.model, 'opus',
      'the construction-time options are history; the switch travels over the control channel',
    );
    await run.dispose();
  });

  test('setModel() before the first send does not touch a query that does not exist yet', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.setModel('haiku');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 0, 'a model change must not spawn a subprocess');
    assert.deepStrictEqual(fake.setModels, []);
    await run.dispose();
  });

  test('a rejecting setModel() is logged, not surfaced as a failed turn', async () => {
    // Same best-effort contract as setEffort/setPermissionMode: a control-channel
    // refusal is a degraded setting, not a broken conversation, so nothing may
    // reach `events` and nothing may reject at the caller.
    const fake = fakeLoadQuery({ setModel: () => Promise.reject(new Error('nope')) });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();
    assert.doesNotThrow(() => run.setModel('haiku'));
    await flushMacrotask();

    const events = await drainAvailableEvents(run);
    assert.strictEqual(events.some((e) => e.kind === 'turn-end'), false);
    await run.dispose();
  });

  test('a synchronously throwing setModel() does not throw at the caller', async () => {
    const fake = fakeLoadQuery({ setModel: () => { throw new Error('torn down'); } });
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

    run.send('go');
    await flushMicrotasks();

    assert.doesNotThrow(() => run.setModel('haiku'));
    await run.dispose();
  });

  test('the query omits effort when the catalog says the model has no effort control', async () => {
    // Belt-and-braces at the wire boundary: the host reconciles effort against
    // the model it is switching to, but a session persisted before a catalog
    // change can still be resumed carrying an effort its model cannot take.
    const fake = fakeLoadQuery({ models: CATALOG });
    const provider = new ClaudeProvider(fake.load as never);
    // The catalog is what the CLI answered, never a hardcoded list — so a
    // test about reconciling against it has to probe first, exactly as the
    // host does before any session can be created against this provider.
    await provider.fetchModels('/tmp');
    const run = provider.start({
      cwd: '/tmp', model: 'haiku', effort: 'max', permissionMode: 'default',
    });

    run.send('go');
    await flushMicrotasks();

    // [0] is the probe's own throwaway query; the session's is the last one.
    const started = fake.calls[fake.calls.length - 1];
    assert.strictEqual('effort' in started.options, false, 'haiku has no effort row');
    await run.dispose();
  });

  test('the query keeps an effort the model does support', async () => {
    const fake = fakeLoadQuery({ models: CATALOG });
    const provider = new ClaudeProvider(fake.load as never);
    await provider.fetchModels('/tmp');
    const run = provider.start({
      cwd: '/tmp', model: 'claude-opus-5', effort: 'low', permissionMode: 'default',
    });

    run.send('go');
    await flushMicrotasks();

    assert.strictEqual(fake.calls[fake.calls.length - 1].options.effort, 'low');
    await run.dispose();
  });

  test('the query asks for summarized thinking, or the blocks arrive empty', async () => {
    // Not a preference. Without `display: 'summarized'` the CLI still emits
    // `thinking` content blocks for every reasoning turn — with `thinking`
    // set to the empty string. The transcript then has a reasoning event
    // carrying no reasoning, which is indistinguishable downstream from a
    // model that did not think at all. Probed against the real SDK before
    // this was written; see map-events.ts.
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({
      cwd: '/tmp', model: 'claude-opus-5', effort: 'high', permissionMode: 'default',
    });

    run.send('go');
    await flushMicrotasks();

    assert.deepStrictEqual(fake.calls[0].options.thinking, {
      type: 'adaptive', display: 'summarized',
    });
    await run.dispose();
  });

  test('an effort on a model the catalog does not list is passed through untouched', async () => {
    // No row means no opinion: the CLI is the authority on ids we do not know.
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({
      cwd: '/tmp', model: 'some-future-model', effort: 'max', permissionMode: 'default',
    });

    run.send('go');
    await flushMicrotasks();

    assert.strictEqual(fake.calls[0].options.effort, 'max');
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

  test('setEffort() clamps a level the running model does not support before forwarding it live', async () => {
    // 'ultra' is Codex-only — no Claude model's `effort.levels` lists it — but
    // the wire type is the shared `EffortLevel` union with nothing tying a
    // value to a provider, and AgentSession.setEffort forwards it verbatim.
    // The clamp therefore has to happen here, mirroring what buildOptions
    // already does at construction time, or 'ultra' reaches
    // Query.applyFlagSettings live, mid-session.
    const fake = fakeLoadQuery({ models: CATALOG });
    const provider = new ClaudeProvider(fake.load as never);
    await provider.fetchModels('/tmp');
    const run = provider.start({
      cwd: '/tmp', model: 'claude-opus-5', effort: 'low', permissionMode: 'default',
    });

    run.send('go');
    await flushMicrotasks();
    run.setEffort('ultra');
    await flushMicrotasks();

    assert.strictEqual(fake.flagSettings.length, 1);
    assert.notStrictEqual(fake.flagSettings[0].effortLevel, 'ultra', 'must not forward an unsupported level to the SDK');
    // claude-opus-5's levels are low|medium|high|xhigh|max with 'high' as
    // default (the CLI's own default) — resolveEffort's fallback for a
    // requested level the model does not list.
    assert.strictEqual(fake.flagSettings[0].effortLevel, 'high');
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

  test('send appends one image block per image attachment', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-claude-attachment-'));
    const pngOnDisk = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(pngOnDisk, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    try {
      run.send('look', undefined, [
        { id: 'a1', path: pngOnDisk, name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: 4 },
      ]);
      await flushMicrotasks();

      const next = await fake.calls[0].prompt[Symbol.asyncIterator]().next();
      const message = next.value as {
        message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> };
      };
      const content = message.message.content;
      assert.strictEqual(content.length, 2);
      assert.strictEqual(content[0].type, 'text');
      assert.strictEqual(content[1].type, 'image');
      assert.strictEqual(content[1].source?.media_type, 'image/png');
      assert.strictEqual(content[1].source?.data, 'iVBORw==');
    } finally {
      await run.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('contextBreakdown() rejects before the first send()', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    await assert.rejects(() => run.contextBreakdown!(), /has not started yet/);
    await run.dispose();
  });

  test('start() adds the self-control MCP server to mcpServers when configured', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(
      fake.load as never,
      { url: 'http://127.0.0.1:1234/mcp', token: 'tok' },
    );
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('hi');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0].options.mcpServers, {
      marcode_self_control: {
        type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { authorization: 'Bearer tok' },
      },
    });
    await run.dispose();
  });

  test('start() omits mcpServers when no self-control config was given', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('hi');
    await flushMicrotasks();

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual('mcpServers' in fake.calls[0].options, false);
    await run.dispose();
  });
});

suite('ClaudeProvider usage pull', () => {
  test('fetchUsage issues the get_usage control request on a throwaway query', async () => {
    let closed = false;
    const provider = new ClaudeProvider(async () => (() => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 62, resets_at: '2026-08-14T17:10:00Z' } },
      }),
      close: () => { closed = true; },
    })) as never);

    const windows = await provider.fetchUsage('/repo');

    assert.deepStrictEqual(windows, [{
      id: 'five-hour', label: 'Session (5h)', usedPercent: 62,
      resetsAt: Date.parse('2026-08-14T17:10:00Z'),
    }]);
    assert.strictEqual(closed, true, 'the throwaway query must be closed');
  });

  test('fetchUsage closes the throwaway query even when the request rejects', async () => {
    let closed = false;
    const provider = new ClaudeProvider(async () => (() => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error('control request failed');
      },
      close: () => { closed = true; },
    })) as never);

    await assert.rejects(() => provider.fetchUsage('/repo'));
    // A rejection that leaked the subprocess would leak one per activation,
    // for the life of the window.
    assert.strictEqual(closed, true);
  });

  test('fetchUsage reports undefined when the account has no plan limits', async () => {
    const provider = new ClaudeProvider(async () => (() => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: false, rate_limits: null,
      }),
      close: () => {},
    })) as never);

    assert.strictEqual(await provider.fetchUsage('/repo'), undefined);
  });

  test('usageWindows answers on the live query without constructing a second one', async () => {
    let constructed = 0;
    const provider = new ClaudeProvider(async () => ((() => {
      constructed += 1;
      return {
        [Symbol.asyncIterator]: async function* () { /* never yields */ },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          rate_limits_available: true,
          rate_limits: { seven_day: { utilization: 18, resets_at: null } },
        }),
        close: () => {},
      };
    }) as never));

    const run = provider.start({ cwd: '/repo' } as never);
    run.send('hello');            // lazy start: this is what builds the query
    const windows = await run.usageWindows?.();

    assert.deepStrictEqual(windows?.map((w) => w.id), ['seven-day']);
    assert.strictEqual(constructed, 1, 'must reuse the session query, not probe');
  });

  test('usageWindows before the first send resolves undefined rather than spawning', async () => {
    let constructed = 0;
    const provider = new ClaudeProvider(async () => ((() => {
      constructed += 1;
      return { close: () => {} };
    }) as never));

    const run = provider.start({ cwd: '/repo' } as never);

    // Lazy start is deliberate — a usage pull must not be the thing that
    // spawns a CLI for a session the user never sent to. The activation probe
    // already covers this case.
    assert.strictEqual(await run.usageWindows?.(), undefined);
    assert.strictEqual(constructed, 0);
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

  test('an OAuth expiry mid-turn reads as a sign-in problem, not raw SDK text', async () => {
    const provider = new ClaudeProvider((async () => {
      throw new Error('Failed to authenticate: OAuth session expired and could not be refreshed');
    }) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.send('go');
    await flushMacrotask();
    const events = await drainAvailableEvents(run);

    assert.deepStrictEqual(events, [
      { kind: 'turn-end', reason: 'error', error: 'Not signed in to Claude. Run `claude auth login`.' },
    ]);
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

  /** A provider whose probe always fails with `message`. */
  function providerThatFails(message: string) {
    return new ClaudeProvider((async () => () => ({
      supportedModels: async () => { throw new Error(message); },
      close: () => {},
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    })) as never);
  }

  test('listModels is empty until the CLI answers', async () => {
    assert.deepStrictEqual(
      providerWithModels([]).listModels(), [],
      'no install has been probed yet, so there is nothing this provider can honestly offer',
    );
  });

  test('fetchModels reports what the CLI says this install can run', async () => {
    let closed = false;
    const provider = providerWithModels([
      {
        value: 'claude-fable-5', displayName: 'Fable 5', description: '',
        supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      { value: 'haiku', displayName: 'Haiku 4.5', description: '' },
    ], () => { closed = true; });

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

  test('fetchModels carries the wire id an alias row resolves to, and drops it when redundant', async () => {
    const provider = providerWithModels([
      { value: 'opus', displayName: 'Opus', description: '', resolvedModel: 'claude-opus-5' },
      {
        value: 'claude-sonnet-5', displayName: 'Sonnet', description: '',
        resolvedModel: 'claude-sonnet-5',
      },
    ]);

    const [alias, exact] = await provider.fetchModels('/repo');

    assert.strictEqual(alias.resolvedModel, 'claude-opus-5',
      'a session persisted on the wire id has to be able to find this row');
    assert.strictEqual('resolvedModel' in exact, false,
      'a row that resolves to its own id has nothing to reconcile');
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

  test('a CLI that lists no models leaves the provider with nothing to offer', async () => {
    const provider = providerWithModels([]);

    const out = await provider.fetchModels('/repo');

    assert.deepStrictEqual(out, [],
      'an install that can run no model must not be selectable');
    assert.deepStrictEqual(provider.listModels(), []);
  });

  test('a failed probe drops the catalog an earlier probe cached', async () => {
    let fail = false;
    const provider = new ClaudeProvider((async () => () => ({
      supportedModels: async () => {
        if (fail) { throw new Error('spawn ENOENT'); }
        return [{ value: 'haiku', displayName: 'Haiku 4.5', description: '' }];
      },
      close: () => {},
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    })) as never);
    await provider.fetchModels('/repo');
    assert.strictEqual(provider.listModels().length, 1, 'precondition: the first probe answered');

    fail = true;
    await assert.rejects(() => provider.fetchModels('/repo'));

    assert.deepStrictEqual(provider.listModels(), [],
      'a binary that stopped working must not keep serving the models it used to run');
  });

  test('fetchModels rejects with a message about the CLI, not the SDK internals', async () => {
    const provider = providerThatFails(
      'Claude Code executable not found at C:\\Users\\x\\claude.exe. '
      + 'Is options.pathToClaudeCodeExecutable set?',
    );

    await assert.rejects(() => provider.fetchModels('/repo'), (err: Error) => {
      assert.match(err.message, /Claude Code CLI not found/);
      assert.strictEqual(/pathToClaudeCodeExecutable/.test(err.message), false,
        'the reason reaches the panel, so it names the tool the user installed');
      return true;
    });
  });

  test('fetchModels reports an expired OAuth session as a sign-in problem, not raw SDK text', async () => {
    const provider = providerThatFails('Failed to authenticate: OAuth session expired and could not be refreshed');

    await assert.rejects(() => provider.fetchModels('/repo'), (err: Error) => {
      assert.strictEqual(err.message, 'Not signed in to Claude. Run `claude auth login`.');
      return true;
    });
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

suite('ClaudeProvider (questions)', () => {
  test('AskUserQuestion emits a question event rather than a permission', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('AskUserQuestion', {
      questions: [{
        header: 'Scope', question: 'Which one?', multiSelect: false,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
      }],
    }, { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.ok(q && q.kind === 'question');
    assert.strictEqual(q.blocking, true);
    assert.strictEqual(q.questions.length, 1);
    assert.strictEqual(q.questions[0].id, 'Which one?');
    assert.strictEqual(q.questions[0].allowOther, true);
    assert.strictEqual(q.questions[0].secret, false);
    assert.strictEqual(q.questions[0].options?.length, 2);
    assert.strictEqual(events().some((e) => e.kind === 'permission'), false);
  });

  test('respondToQuestion resolves with answers spread over the original input', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    collect(run);
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    const input = {
      questions: [{
        header: 'Scope', question: 'Which one?', multiSelect: true,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
      }],
    };
    const decision = canUseTool('AskUserQuestion', input,
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    run.respondToQuestion('t1', { 'Which one?': ['A', 'B'] });

    assert.deepStrictEqual(await decision, {
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which one?': 'A, B' } },
    });
  });

  test('a malformed questions payload degrades to a permission card', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('AskUserQuestion', { questions: 'not an array' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    assert.strictEqual(events().some((e) => e.kind === 'permission'), true);
    assert.strictEqual(events().some((e) => e.kind === 'question'), false);
  });
});

suite('ClaudeProvider (cancellation)', () => {
  test('interrupt settles a parked permission — it does not strand the card', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('Write', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await run.interrupt();

    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
    assert.strictEqual(events().some((e) => e.kind === 'request-cancelled' && e.id === 't1'), true);
  });

  test('interrupt() converges the turn locally even when the SDK never reports its own result message', async () => {
    // The fake query's generator body only awaits its stop signal — it never
    // yields the SDK's `result` message (terminal_reason: 'aborted_streaming'
    // /'aborted_tools') that map-events.ts otherwise relies on to emit
    // turn-end. This is the real-world case where that message is delayed or
    // dropped: interrupt() must still converge the session, not leave status
    // wedged at 'running' with a queued message parked behind it forever.
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    await run.interrupt();

    assert.strictEqual(
      events().some((e) => e.kind === 'turn-end' && e.reason === 'interrupted'),
      true,
      'interrupt() must self-resolve the turn, not wait on the SDK result message alone',
    );
  });

  test('a late genuine result message for an interrupted turn does not end a newer turn already in flight', async () => {
    // interrupt() pushes its own synthetic turn-end immediately, but the SDK's
    // real `result` message for the interrupted turn (terminal_reason:
    // 'aborted_streaming') can still arrive later, over the SAME persistent
    // `for await` loop that serves every turn in the conversation. If a
    // queued message was drained and a new turn is already running by the
    // time that late message shows up, it must not be mistaken for that new
    // turn's own end.
    let releaseLateResult!: () => void;
    const lateResult = new Promise<void>((resolve) => { releaseLateResult = resolve; });
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      const gen = (async function* () {
        await lateResult;
        yield {
          type: 'result', subtype: 'error_during_execution',
          terminal_reason: 'aborted_streaming', errors: [],
          uuid: 'u1', session_id: 's1',
        };
        await stopSignal;
      })() as AsyncGenerator<unknown, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
        mcpServerStatus: () => Promise<unknown[]>;
      };
      gen.interrupt = async () => undefined;
      gen.setPermissionMode = async () => { /* no-op fake */ };
      gen.applyFlagSettings = async () => { /* no-op fake */ };
      gen.close = () => { stop(); releaseLateResult(); };
      gen.mcpServerStatus = async () => [];
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    await run.interrupt();
    const turnEndsAfterInterrupt = events().filter((e) => e.kind === 'turn-end').length;
    assert.strictEqual(turnEndsAfterInterrupt, 1, 'interrupt() self-resolves the first turn once');

    // Stands in for AgentSession.drainQueued() re-delivering the parked
    // message once the synthetic turn-end above went through.
    run.send('second');
    await tick();

    releaseLateResult();
    await tick();

    assert.strictEqual(
      events().filter((e) => e.kind === 'turn-end').length,
      turnEndsAfterInterrupt,
      'the late result message belongs to the interrupted turn and must not end the newer turn',
    );
    await run.dispose();
  });

  test('interrupt() stops every tracked background task before interrupting the foreground turn', async () => {
    // A backgrounded task (Ctrl+B semantics) survives Query.interrupt() by
    // design — the SDK reports its id via `background_tasks_changed` and
    // exposes `stopTask(id)` as the only way to actually stop it.
    const stoppedTaskIds: string[] = [];
    const order: string[] = [];
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      const gen = (async function* () {
        yield {
          type: 'system', subtype: 'background_tasks_changed',
          tasks: [
            { task_id: 'bg-1', task_type: 'agent', description: 'Investigating' },
            { task_id: 'bg-2', task_type: 'bash', description: 'Running tests' },
          ],
          uuid: 'u1', session_id: 's1',
        };
        await stopSignal;
      })() as AsyncGenerator<unknown, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
        mcpServerStatus: () => Promise<unknown[]>;
        stopTask: (taskId: string) => Promise<void>;
      };
      gen.interrupt = async () => { order.push('interrupt'); return undefined; };
      gen.setPermissionMode = async () => { /* no-op fake */ };
      gen.applyFlagSettings = async () => { /* no-op fake */ };
      gen.close = () => { stop(); };
      gen.mcpServerStatus = async () => [];
      gen.stopTask = async (taskId: string) => { stoppedTaskIds.push(taskId); order.push(`stop:${taskId}`); };
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('go');
    await tick();

    await run.interrupt();

    assert.deepStrictEqual(stoppedTaskIds, ['bg-1', 'bg-2']);
    assert.deepStrictEqual(
      order, ['stop:bg-1', 'stop:bg-2', 'interrupt'],
      'both background tasks are stopped before the foreground interrupt',
    );
    await run.dispose();
  });

  test('a drained background-tasks-changed event (empty taskIds) leaves interrupt() with nothing to stop', async () => {
    const stoppedTaskIds: string[] = [];
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      const gen = (async function* () {
        yield {
          type: 'system', subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-1', task_type: 'agent', description: 'Investigating' }],
          uuid: 'u1', session_id: 's1',
        };
        yield {
          type: 'system', subtype: 'background_tasks_changed',
          tasks: [], uuid: 'u2', session_id: 's1',
        };
        await stopSignal;
      })() as AsyncGenerator<unknown, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
        mcpServerStatus: () => Promise<unknown[]>;
        stopTask: (taskId: string) => Promise<void>;
      };
      gen.interrupt = async () => undefined;
      gen.setPermissionMode = async () => { /* no-op fake */ };
      gen.applyFlagSettings = async () => { /* no-op fake */ };
      gen.close = () => { stop(); };
      gen.mcpServerStatus = async () => [];
      gen.stopTask = async (taskId: string) => { stoppedTaskIds.push(taskId); };
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('go');
    await tick();

    await run.interrupt();

    assert.deepStrictEqual(stoppedTaskIds, [], 'the set already drained, so there is nothing left to stop');
    await run.dispose();
  });

  test('an aborted question resolves deny, never null', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    collect(run);
    run.send('hi');
    await tick();

    const controller = new AbortController();
    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('AskUserQuestion', {
      questions: [{ header: 'H', question: 'Q?', multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
    }, { toolUseID: 't1', signal: controller.signal, requestId: 'rq1' });
    controller.abort();

    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
  });

  test('an abort followed by interrupt settles once and emits one cancellation', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const controller = new AbortController();
    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('Write', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: controller.signal, requestId: 'rq1' });
    controller.abort();
    await run.interrupt();
    await decision;

    assert.strictEqual(events().filter((e) => e.kind === 'request-cancelled').length, 1);
  });

  test('a request that arrives on an already-aborted signal denies instead of parking', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const controller = new AbortController();
    controller.abort();
    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    // `addEventListener('abort')` on an already-aborted signal never fires,
    // so without the pre-check this promise parks with nothing able to
    // resolve it: interrupt() ran before the entry existed, and there is no
    // card to click.
    const decision = canUseTool('Write', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: controller.signal, requestId: 'rq1' });

    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
    assert.strictEqual(events().some((e) => e.kind === 'permission'), false);
  });

  test('dispose denies a parked question — never "allow with no answers"', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    collect(run);
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('AskUserQuestion', {
      questions: [{ header: 'H', question: 'Q?', multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
    }, { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await run.dispose();

    // `{}` here would produce `{behavior:'allow', updatedInput:{...input,
    // answers:{}}}` — running the tool with no answer at all, which is the
    // exact shape the question card exists to eliminate.
    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
  });
});

suite('ClaudeProvider permission metadata', () => {
  /** Helper to yield control so microtasks can execute (specifically permission calls). */
  async function tick() {
    await Promise.resolve();
    await Promise.resolve();
  }

  test('a permission event carries the bridge-rendered title and reason', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as never as (
      toolName: string,
      input: unknown,
      options: Record<string, unknown>,
    ) => Promise<{ behavior: string } | null>;

    const permissionPromise = canUseTool('Read', { file_path: '/tmp/a' }, {
      toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1',
      title: 'Claude wants to read a.txt', displayName: 'Read file',
      description: 'Read access to /tmp', decisionReason: 'outside allowed directories',
      blockedPath: '/tmp/a',
    });
    await tick();

    // Drain available events to find the permission event
    const events = await drainAvailableEvents(run);
    const p = events.find((e) => e.kind === 'permission');
    assert.strictEqual(p?.kind, 'permission');
    assert.strictEqual((p as any)?.meta?.title, 'Claude wants to read a.txt');
    assert.strictEqual((p as any)?.meta?.decisionReason, 'outside allowed directories');
    assert.strictEqual((p as any)?.meta?.blockedPath, '/tmp/a');

    // Respond to the permission to unblock
    run.respondToTool('t1', { allow: true });
    await tick();
    await permissionPromise;
    await run.dispose();
  });

  test('a permission event omits meta entirely when the bridge sends none', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('hi');
    await tick();

    const canUseTool = fake.calls[0].options.canUseTool as never as (
      toolName: string,
      input: unknown,
      options: Record<string, unknown>,
    ) => Promise<{ behavior: string } | null>;

    const permissionPromise = canUseTool('Read', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    // Drain available events to find the permission event
    const events = await drainAvailableEvents(run);
    const p = events.find((e) => e.kind === 'permission');
    assert.strictEqual(p?.kind, 'permission');
    assert.strictEqual((p as any)?.meta === undefined, true);

    // Respond to the permission to unblock
    run.respondToTool('t1', { allow: true });
    await tick();
    await permissionPromise;
    await run.dispose();
  });
});

suite('ClaudeProvider instance overrides', () => {
  test('an instance override sets id, displayName and merges env/pathToClaudeCodeExecutable into Options', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fake = fakeLoadQuery({
      onQuery: (options) => { capturedOptions = options as Record<string, unknown>; },
    });
    const provider = new ClaudeProvider(fake.load as never, undefined, {
      id: 'claude-work', displayName: 'Claude (work)',
      env: { ANTHROPIC_API_KEY: 'sk-work' } as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/opt/claude-work/claude',
    });
    assert.strictEqual(provider.id, 'claude-work');
    assert.strictEqual(provider.displayName, 'Claude (work)');
    const run = provider.start({ cwd: '/repo', permissionMode: 'default' });
    run.send('hi');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual((capturedOptions?.env as Record<string, string> | undefined)?.ANTHROPIC_API_KEY, 'sk-work');
    assert.strictEqual(capturedOptions?.pathToClaudeCodeExecutable, '/opt/claude-work/claude');
    await run.dispose();
  });

  test('an instance override merges env/pathToClaudeCodeExecutable into the probe path (fetchModels)', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fake = fakeLoadQuery({
      onQuery: (options) => { capturedOptions = options as Record<string, unknown>; },
      models: [],
    });
    const provider = new ClaudeProvider(fake.load as never, undefined, {
      id: 'claude-work', displayName: 'Claude (work)',
      env: { ANTHROPIC_API_KEY: 'sk-work' } as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/opt/claude-work/claude',
    });
    await provider.fetchModels('/repo');
    assert.strictEqual((capturedOptions?.env as Record<string, string> | undefined)?.ANTHROPIC_API_KEY, 'sk-work');
    assert.strictEqual(capturedOptions?.pathToClaudeCodeExecutable, '/opt/claude-work/claude');
  });

  test('id/displayName default to claude/Claude when no instance override is given', () => {
    const provider = new ClaudeProvider(fakeLoadQuery().load as never);
    assert.strictEqual(provider.id, 'claude');
    assert.strictEqual(provider.displayName, 'Claude');
    assert.strictEqual(provider.loginKind, undefined);
  });

  test('loginKind passes through from the instance override', () => {
    const provider = new ClaudeProvider(fakeLoadQuery().load as never, undefined, { loginKind: 'none' });
    assert.strictEqual(provider.loginKind, 'none');
  });
});
