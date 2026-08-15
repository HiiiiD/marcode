import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { CodexProvider } from '../../providers/codex/codex-provider';

/** Lets a microtask chain (a `.then`, an `await` inside an async fn) settle. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A stub child: no binary, no auth, no network. Same shape as codex-app-server.test.ts's. */
function stubChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  let killCount = 0;
  const send = (msg: unknown) => { stdout.write(`${JSON.stringify(msg)}\n`); };
  const sent = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    stdin, stdout, kill: () => { killCount += 1; }, send, sent,
    killed: () => killCount > 0, killCount: () => killCount,
  };
}

/**
 * Defaults handed back automatically to any request this test isn't
 * specifically interested in, so a probe's earlier steps (`initialize`,
 * `account/read`) don't block on a response the test never sends.
 */
const AUTO_DEFAULTS: Record<string, unknown> = {
  initialize: { userAgent: 'codex', codexHome: '/home/codex', platformFamily: 'unix', platformOs: 'linux' },
  // The realistic signed-in shape (measured against a live ChatGPT Plus
  // account, codex-cli 0.147.0): `requiresOpenaiAuth: true` right alongside
  // a populated `account`. Defaulting to this (rather than a signed-out
  // shape) is deliberate — a test that doesn't care about auth should sail
  // through to whatever it's actually probing, the same way a real signed-in
  // install does.
  'account/read': { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
};

/**
 * The exact params each request must carry, checked on every frame the stub
 * drains.
 *
 * This table is the point of the stub. Matching on a method NAME and
 * answering regardless of params is how `{ cwd }` on
 * `account/rateLimits/read` shipped: that request declares `params:
 * undefined` (a serde unit), so a live 0.147.0 binary answered every call
 * with `Invalid request: invalid type: map, expected unit` and `fetchUsage`
 * rejected forever — while every unit test passed, because both sides of the
 * conversation were ours and neither looked. A `{}` here is not "don't care";
 * it is the assertion that we send an empty object and nothing else.
 *
 * A method absent from this table is unchecked, so add one when you add a
 * request. `params` is compared with `deepStrictEqual`, so an extra field
 * fails as loudly as a missing one.
 */
const EXPECTED_PARAMS: Record<string, unknown> = {
  // Unit params — an object with ANY field is a hard protocol error.
  'account/rateLimits/read': {},
  // Both are process/account-global. Neither declares a `cwd`.
  'account/read': {},
  'model/list': {},
  // Plural, an array, and the only cwd-scoped probe in the class.
  'skills/list': { cwds: ['/repo'] },
};

/**
 * Wires a `CodexProvider` to one stub child process and exposes `respondTo`:
 * await it with a method name and a result, and it drains every request the
 * provider sends up to (and including) that method, auto-answering anything
 * earlier from `AUTO_DEFAULTS` so the probe's own chain of requests can
 * proceed to the one under test.
 *
 * Every drained frame — the one under test and the auto-answered ones alike
 * — is checked against `EXPECTED_PARAMS` first, so a wrong payload fails the
 * test that happens to be running rather than the next live turn.
 */
function providerWithStub() {
  const child = stubChild();
  const provider = new CodexProvider({ spawn: () => child });
  const answered = new Set<unknown>();

  function checkParams(frame: { method: string; params?: unknown }): void {
    if (!(frame.method in EXPECTED_PARAMS)) { return; }
    assert.deepStrictEqual(
      frame.params, EXPECTED_PARAMS[frame.method],
      `${frame.method} sent params the protocol does not declare`,
    );
  }

  async function respondTo(method: string, result: unknown): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const next = child.sent().find((f) => f.method !== undefined && !answered.has(f.id));
      if (!next) { await tick(); continue; }
      answered.add(next.id);
      checkParams(next);
      if (next.method === method) {
        child.send({ id: next.id, result });
        await tick();
        return;
      }
      child.send({ id: next.id, result: AUTO_DEFAULTS[next.method] ?? {} });
      await tick();
    }
    throw new Error(`respondTo('${method}') timed out waiting for a matching request`);
  }

  return {
    provider, respondTo, send: child.send, sent: child.sent,
    killed: child.killed, killCount: child.killCount,
  };
}

suite('CodexProvider', () => {
  test('declares five modes and omits acceptEdits', () => {
    const provider = new CodexProvider({ spawn: () => stubChild() });
    assert.deepStrictEqual(provider.listPermissionModes().map((m) => m.id),
      ['default', 'auto', 'plan', 'dontAsk', 'bypass']);
  });

  test('starts with no models until a probe answers', () => {
    // listModels is a cache, not a source of truth. An empty list is what
    // puts the provider in unavailable() rather than in the picker.
    assert.deepStrictEqual(new CodexProvider({ spawn: () => stubChild() }).listModels(), []);
  });

  test('fetchModels maps the catalog and hides hidden rows', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    await respondTo('model/list', {
      data: [
        {
          id: 'gpt-5-codex', displayName: 'GPT-5 Codex', hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' },
            { reasoningEffort: 'high', description: '' }],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'internal', displayName: 'Internal', hidden: true,
          supportedReasoningEfforts: [], defaultReasoningEffort: 'low',
        },
      ],
      nextCursor: null,
    });
    const models = await probe;
    assert.deepStrictEqual(models.map((m) => m.id), ['gpt-5-codex']);
    assert.deepStrictEqual(models[0].effort, { levels: ['low', 'high'], default: 'high' });
    // The cache is updated by the probe, so the picker sees it synchronously.
    assert.deepStrictEqual(provider.listModels().map((m) => m.id), ['gpt-5-codex']);
  });

  test('a missing binary rejects fetchModels with an actionable message', async () => {
    const provider = new CodexProvider({
      spawn: () => { throw new Error('ENOENT'); },
    });
    // This rejection IS the availability mechanism: session-manager records
    // the reason and shows the provider as unavailable.
    await assert.rejects(provider.fetchModels('/repo'), /not found/i);
  });

  test('an unauthenticated account rejects with the login instruction', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    // A genuinely signed-out account: `account` itself is null/absent. This
    // is the real signal — see the next test for why `requiresOpenaiAuth`
    // alone cannot be it.
    await respondTo('account/read', { account: null, requiresOpenaiAuth: true });
    await assert.rejects(probe, /codex login/);
  });

  test('a signed-in ChatGPT account is not reported as signed out', async () => {
    // The regression this pins: `requiresOpenaiAuth` describes whether this
    // provider requires OpenAI auth AT ALL, not whether it is missing — a
    // live, signed-in ChatGPT Plus account on codex-cli 0.147.0 returns
    // `requiresOpenaiAuth: true` right alongside a populated `account`.
    // Treating that combination as "not signed in" made fetchModels reject
    // for every ChatGPT-auth user, unconditionally.
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    await respondTo('account/read', {
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    });
    await respondTo('model/list', {
      data: [{
        id: 'gpt-5-codex', displayName: 'GPT-5 Codex', hidden: false,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'high',
      }],
      nextCursor: null,
    });
    const models = await probe;
    assert.deepStrictEqual(models.map((m) => m.id), ['gpt-5-codex']);
  });

  test('a rejected handshake still kills the spawned child', async () => {
    // Symmetric with the spawn-failure case above: if `initialize` itself is
    // refused, nothing else holds the already-spawned child — leaving it
    // alive here means every failed handshake leaks one more process.
    const { provider, send, sent, killCount } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    await tick();
    const init = sent().find((f) => f.method === 'initialize');
    assert.ok(init, 'expected an initialize request to have been sent');
    send({ id: init.id, error: { message: 'handshake refused' } });
    await assert.rejects(probe);
    assert.strictEqual(killCount(), 1);
  });

  test('fetchUsage reads the account snapshot without a thread', async () => {
    const { provider, respondTo } = providerWithStub();
    // The cwd is accepted and must NOT reach the wire — `respondTo` asserts
    // that against EXPECTED_PARAMS. The response is the full
    // `GetAccountRateLimitsResponse`, extra buckets included, so the parse
    // is exercised against what the binary actually sends rather than a
    // trimmed shape we invented.
    const probe = provider.fetchUsage('/repo');
    await respondTo('account/rateLimits/read', {
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null }, secondary: null },
      },
      rateLimitResetCredits: null,
    });
    assert.deepStrictEqual((await probe)?.map((w) => w.usedPercent), [40]);
  });

  // The structural gap that let three payload bugs ship: nothing asserted
  // what we put on the wire, only that a method by that name was called.
  // These pin the params of every request this class sends. `account/read`,
  // `model/list` and `account/rateLimits/read` each declare no params at
  // all — `{ cwd }` on the last one was rejected by every live binary with
  // `Invalid request: invalid type: map, expected unit`.
  test('every probe sends exactly the params its request declares', async () => {
    const { provider, respondTo, sent } = providerWithStub();

    const models = provider.fetchModels('/repo');
    await respondTo('model/list', { data: [], nextCursor: null });
    await models;

    const usage = provider.fetchUsage('/repo');
    await respondTo('account/rateLimits/read', { rateLimits: { primary: null, secondary: null } });
    await usage;

    const skills = provider.listInvocables('/repo');
    await respondTo('skills/list', { data: [] });
    await skills;

    const paramsOf = (method: string): unknown =>
      sent().find((f) => f.method === method)?.params;
    assert.deepStrictEqual(paramsOf('account/read'), {});
    assert.deepStrictEqual(paramsOf('model/list'), {});
    assert.deepStrictEqual(paramsOf('account/rateLimits/read'), {});
    assert.deepStrictEqual(paramsOf('skills/list'), { cwds: ['/repo'] });
  });

  test('two sessions share one process', () => {
    let spawns = 0;
    const provider = new CodexProvider({ spawn: () => { spawns += 1; return stubChild(); } });
    provider.start({ cwd: '/a', permissionMode: 'default' });
    provider.start({ cwd: '/b', permissionMode: 'plan' });
    assert.strictEqual(spawns, 1);
  });

  test('the process is torn down when the last run is disposed', async () => {
    const { provider, killed } = providerWithStub();
    const first = provider.start({ cwd: '/a', permissionMode: 'default' });
    const second = provider.start({ cwd: '/b', permissionMode: 'default' });
    await first.dispose();
    assert.strictEqual(killed(), false);
    await second.dispose();
    assert.strictEqual(killed(), true);
  });

  test('listInvocables flattens skills across cwd entries, skips only explicitly-disabled rows, and maps scope to origin', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.listInvocables('/repo');
    await respondTo('skills/list', {
      data: [
        {
          cwd: '/repo',
          skills: [
            {
              name: 'plan', description: 'Plan the work in detail', shortDescription: 'Plan',
              path: '/repo/.codex/skills/plan.md', scope: 'project', enabled: true,
            },
            {
              name: 'retired', description: 'No longer offered',
              path: '/repo/.codex/skills/retired.md', scope: 'project', enabled: false,
            },
            // No `enabled` field at all — must still be offered. Only an
            // explicit `false` suppresses a skill; a missing field is not
            // the same fact and a truthy check would conflate the two.
            {
              name: 'unmarked', description: 'Never says either way',
              path: '/repo/.codex/skills/unmarked.md', scope: 'project',
            } as never,
          ],
          errors: [],
        },
        {
          cwd: '/home/.codex',
          skills: [
            {
              name: 'brainstorm', description: 'Explore options before building',
              path: '/home/.codex/skills/brainstorm.md', scope: 'user', enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });
    const invocables = await probe;
    assert.deepStrictEqual(invocables, [
      { name: 'plan', description: 'Plan', origin: 'project' },
      { name: 'unmarked', description: 'Never says either way', origin: 'project' },
      { name: 'brainstorm', description: 'Explore options before building', origin: 'user' },
    ]);
  });

  test('setBinPath changes what the next connect() spawns', () => {
    const spawnedBins: string[] = [];
    const provider = new CodexProvider({
      binPath: 'codex-old',
      spawn: (bin) => { spawnedBins.push(bin); return stubChild(); },
    });
    provider.start({ cwd: '/a', permissionMode: 'default' });
    assert.deepStrictEqual(spawnedBins, ['codex-old']);

    provider.setBinPath('codex-new');
    provider.start({ cwd: '/a', permissionMode: 'default' });
    assert.deepStrictEqual(spawnedBins, ['codex-old', 'codex-new']);
  });

  test('setBinPath tears down a live connection even with an active run, and that run ends in error rather than an unhandled rejection', async () => {
    const { provider, respondTo, killCount } = providerWithStub();
    const run = provider.start({ cwd: '/a', permissionMode: 'default' });
    run.send('hi');
    await respondTo('thread/start', { thread: { id: 'th_1' } });

    const events: Array<{ kind: string; reason?: string }> = [];
    void (async () => {
      for await (const e of run.events) { events.push(e as { kind: string; reason?: string }); }
    })();

    // A declared-wrong binary must kill the process outright, unlike the
    // ref-counted teardown a run's own dispose() triggers.
    provider.setBinPath('codex-new');
    await tick();

    assert.strictEqual(killCount(), 1);
    assert.ok(events.some((e) => e.kind === 'turn-end' && e.reason === 'error'),
      'expected the active run to end with a turn-end/error event, not hang or throw');
  });

  // Not in the brief's list, but load-bearing: AppServer's onNotification/
  // onServerRequest/onClose are single-slot setters (last caller wins), and
  // one process serves every Codex session. If each CodexRun registered
  // itself directly on the shared AppServer, starting a second run would
  // silently steal every event the first run was waiting on. This pins the
  // provider's fan-out: both runs must go on hearing only their own thread.
  test('two concurrent runs each receive only their own thread\'s events', async () => {
    const { provider, respondTo, send } = providerWithStub();
    const first = provider.start({ cwd: '/a', permissionMode: 'default' });
    const second = provider.start({ cwd: '/b', permissionMode: 'default' });

    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    void (async () => {
      for await (const e of first.events) { if (e.kind === 'text') { firstEvents.push(e.delta); } }
    })();
    void (async () => {
      for await (const e of second.events) { if (e.kind === 'text') { secondEvents.push(e.delta); } }
    })();

    first.send('hi');
    await respondTo('thread/start', { thread: { id: 'th_1' } });
    second.send('hi');
    await respondTo('thread/start', { thread: { id: 'th_2' } });

    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'to-first' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_2', delta: 'to-second' } });
    await tick();

    assert.deepStrictEqual(firstEvents, ['to-first']);
    assert.deepStrictEqual(secondEvents, ['to-second']);
  });
});
