import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { postMoveSession } from '../../providers/opencode/move-session';
import { OpenCodeProvider } from '../../providers/opencode/opencode-provider';

type Call = { url: string; init?: RequestInit };
const reply = (status: number) => new Response(null, { status });

suite('postMoveSession', () => {
  test('POSTs the documented body with basic auth', async () => {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return reply(204); }) as unknown as typeof fetch;
    const ok = await postMoveSession('http://127.0.0.1:1', 'tok', 'ses_1', '/dest', fetchFn);
    assert.strictEqual(ok, true);
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:1/experimental/control-plane/move-session');
    assert.strictEqual(calls[0].init?.method, 'POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.strictEqual(headers.Authorization, `Basic ${Buffer.from('opencode:tok').toString('base64')}`);
    assert.deepStrictEqual(JSON.parse(calls[0].init?.body as string),
      { sessionID: 'ses_1', destination: { directory: '/dest' }, moveChanges: false });
  });

  test('returns false for 400/404/500 and for a rejected fetch', async () => {
    for (const status of [400, 404, 500]) {
      const f = (async () => reply(status)) as unknown as typeof fetch;
      assert.strictEqual(await postMoveSession('http://x', 't', 's', '/d', f), false);
    }
    const rejecting = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    assert.strictEqual(await postMoveSession('http://x', 't', 's', '/d', rejecting), false);
  });
});

suite('OpenCodeProvider.moveThread', () => {
  const args = { resumeToken: 'ses_1', from: '/a', to: '/b' };

  function harness(opts: { fetchImpl: (url: string, n: number) => Response; reserve?: () => Promise<number> }) {
    const state = { killed: 0, spawnEnv: undefined as NodeJS.ProcessEnv | undefined, urls: [] as string[] };
    let n = 0;
    const provider = new OpenCodeProvider({
      spawn: (_bin, env) => {
        state.spawnEnv = env;
        return { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => { state.killed++; } };
      },
      reservePort: opts.reserve ?? (async () => 4321),
      moveFetch: (async (url: string) => {
        state.urls.push(url);
        return opts.fetchImpl(url, n++);
      }) as unknown as typeof fetch,
      moveReadyIntervalMs: 1,
    });
    return { provider, state };
  }

  test('returns the token and drops the old key on success', async () => {
    const { provider, state } = harness({ fetchImpl: () => reply(204) });
    assert.deepStrictEqual(await provider.moveThread!(args), { resumeToken: 'ses_1', dropOldKey: true });
    assert.strictEqual(state.killed, 1);
    assert.strictEqual(typeof state.spawnEnv?.OPENCODE_SERVER_PASSWORD, 'string');
  });

  test('kills the short-lived child even when the endpoint fails', async () => {
    const { provider, state } = harness({ fetchImpl: () => reply(500) });
    assert.strictEqual(await provider.moveThread!(args), false);
    assert.strictEqual(state.killed, 1);
  });

  test('returns false when the port cannot be reserved', async () => {
    const { provider, state } = harness({ fetchImpl: () => reply(204), reserve: async () => { throw new Error('nope'); } });
    assert.strictEqual(await provider.moveThread!(args), false);
    assert.strictEqual(state.killed, 0);
  });

  test('waits for the server to answer before posting', async () => {
    const { provider, state } = harness({
      fetchImpl: (_url, n) => { if (n < 2) { throw new Error('ECONNREFUSED'); } return reply(204); },
    });
    assert.notStrictEqual(await provider.moveThread!(args), false);
    assert.strictEqual(state.urls.length, 4);
    assert.strictEqual(state.urls[3].endsWith('/move-session'), true);
  });
});
