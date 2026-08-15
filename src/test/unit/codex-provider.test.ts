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
  let killed = false;
  const send = (msg: unknown) => { stdout.write(`${JSON.stringify(msg)}\n`); };
  const sent = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { stdin, stdout, kill: () => { killed = true; }, send, sent, killed: () => killed };
}

/**
 * Defaults handed back automatically to any request this test isn't
 * specifically interested in, so a probe's earlier steps (`initialize`,
 * `account/read`) don't block on a response the test never sends.
 */
const AUTO_DEFAULTS: Record<string, unknown> = {
  initialize: { userAgent: 'codex', codexHome: '/home/codex', platformFamily: 'unix', platformOs: 'linux' },
  'account/read': { account: null, requiresOpenaiAuth: false },
};

/**
 * Wires a `CodexProvider` to one stub child process and exposes `respondTo`:
 * await it with a method name and a result, and it drains every request the
 * provider sends up to (and including) that method, auto-answering anything
 * earlier from `AUTO_DEFAULTS` so the probe's own chain of requests can
 * proceed to the one under test.
 */
function providerWithStub() {
  const child = stubChild();
  const provider = new CodexProvider({ spawn: () => child });
  const answered = new Set<unknown>();

  async function respondTo(method: string, result: unknown): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const next = child.sent().find((f) => f.method !== undefined && !answered.has(f.id));
      if (!next) { await tick(); continue; }
      answered.add(next.id);
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

  return { provider, respondTo, send: child.send, killed: child.killed };
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
    await respondTo('account/read', { requiresOpenaiAuth: true, authMethod: null });
    await assert.rejects(probe, /codex login/);
  });

  test('fetchUsage reads the account snapshot without a thread', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchUsage('/repo');
    await respondTo('account/rateLimits/read', {
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    });
    assert.deepStrictEqual((await probe)?.map((w) => w.usedPercent), [40]);
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
    await respondTo('thread/start', { threadId: 'th_1' });
    second.send('hi');
    await respondTo('thread/start', { threadId: 'th_2' });

    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'to-first' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_2', delta: 'to-second' } });
    await tick();

    assert.deepStrictEqual(firstEvents, ['to-first']);
    assert.deepStrictEqual(secondEvents, ['to-second']);
  });
});
