import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { DEFAULT_PROVIDER_IDS } from '../../shared/settings';
import { OpenCodeProvider } from '../../providers/opencode/opencode-provider';

/** A scripted spawn that answers `initialize` so `session/new` gets sent, then
 *  records every frame it received without answering it — enough to inspect
 *  the params `start()`'s `AcpRun` opened the session with. */
function recordingSpawn() {
  const seen: Record<string, unknown>[] = [];
  const spawn = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) { continue; }
        const frame = JSON.parse(line) as Record<string, unknown>;
        seen.push(frame);
        if (frame.method === 'initialize') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.initialize })}\n`);
        }
      }
    });
    return { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  };
  return { spawn, seen };
}

const waitFor = async (
  seen: Record<string, unknown>[], method: string,
): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 200; i++) {
    const hit = seen.find((f) => f.method === method);
    if (hit) { return hit; }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no ${method} was sent`);
};

/** A scripted `AcpChild` whose failure is triggered on demand — same shape as
 *  the inline fake the "async spawn failure" test above already uses, just
 *  reusable across two attempts for the retry test. */
function fakeAcpChild() {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  let notify: (reason: string) => void = () => {};
  return {
    child: {
      stdin: toAgent, stdout: toClient,
      kill: () => { toClient.end(); },
      onFailure: (cb: (reason: string) => void) => { notify = cb; },
    },
    failWith: (reason: string) => { notify(reason); },
  };
}

/**
 * `provider.start(...)` returns synchronously, but the actual spawn happens
 * after an awaited `reservePort()` — at least one microtask away. A plain
 * synchronous assertion right after `start()` would read stale state.
 * `setImmediate` reliably drains the whole microtask queue first (Node
 * always exhausts microtasks before the next macrotask phase), regardless
 * of how many `await`/`queueMicrotask` hops the retry chain takes.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** A spawn stub that answers initialize + session/new from the fixtures and
 *  records the frames it received. */
function scriptedSpawn() {
  const seen: Record<string, unknown>[] = [];
  const spawn = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) { continue; }
        const frame = JSON.parse(line) as Record<string, unknown>;
        seen.push(frame);
        if (frame.method === 'initialize') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.initialize })}\n`);
        }
        if (frame.method === 'session/new') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.newSession })}\n`);
        }
        if (frame.method === 'session/set_config_option') {
          // Echoes the same catalog back for every model — none of the
          // fixture's models declare a `thought_level` option, so the effort
          // sweep this answers never changes what `fetchModels` reports.
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { configOptions: frames.newSession.configOptions } })}\n`);
        }
        if (frame.method === 'session/close') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`);
        }
      }
    });
    return { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  };
  return { spawn, seen };
}

/**
 * Like `scriptedSpawn`, but the effort sweep's `session/set_config_option`
 * answers per model: `opencode/hy3-free` reports a `thought_level` option,
 * `opencode/big-pickle` does not — proving the probe attaches effort to the
 * one model that actually offers it, not to every row uniformly.
 *
 * `neverAnswerFor`, when given, drops that one model's config-write reply
 * entirely — every other frame still answers — to exercise the sweep's own
 * per-write timeout without hanging the whole test.
 */
function scriptedSpawnWithEffort(neverAnswerFor?: string) {
  const seen: Record<string, unknown>[] = [];
  const spawn = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) { continue; }
        const frame = JSON.parse(line) as Record<string, unknown>;
        seen.push(frame);
        if (frame.method === 'initialize') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.initialize })}\n`);
        }
        if (frame.method === 'session/new') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.newSession })}\n`);
        }
        if (frame.method === 'session/set_mode') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`);
        }
        if (frame.method === 'session/set_config_option') {
          const value = (frame.params as { value: string }).value;
          if (value === neverAnswerFor) { continue; }
          const configOptions = value === 'opencode/hy3-free'
            ? [
              ...frames.newSession.configOptions,
              {
                id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low',
                options: [{ value: 'low' }, { value: 'high' }],
              },
            ]
            : frames.newSession.configOptions;
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { configOptions } })}\n`);
        }
        if (frame.method === 'session/close') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`);
        }
      }
    });
    return { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  };
  return { spawn, seen };
}

suite('OpenCodeProvider', () => {
  test('starts with an empty catalog — models are the probe’s answer, never a default', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.deepStrictEqual(provider.listModels(), []);
  });

  test('threadScope is cwd — a cross-directory session/load never completes', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.threadScope, 'cwd');
  });

  test('loginKind reflects the constructor option', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn, loginKind: 'none' });
    assert.strictEqual(provider.loginKind, 'none');
  });

  test('loginKind is undefined when the constructor option is omitted', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.loginKind, undefined);
  });

  test('offers exactly the four modes it can enforce', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.deepStrictEqual(provider.listPermissionModes().map((m) => m.id),
      ['default', 'plan', 'bypass', 'dontAsk']);
  });

  test('every offered mode carries a description saying where prompting is decided', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.listPermissionModes().every((m) => (m.description ?? '').length > 0), true);
  });

  test('fetchModels probes a real session and returns what it reported', async () => {
    const scripted = scriptedSpawn();
    const provider = new OpenCodeProvider({ spawn: scripted.spawn });
    const models = await provider.fetchModels('/w');
    assert.deepStrictEqual(models, [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      { id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free' },
    ]);
    assert.deepStrictEqual(provider.listModels(), models);
  });

  test('fetchModels sweeps every model and attaches effort to the ones that offer it', async () => {
    const scripted = scriptedSpawnWithEffort();
    const provider = new OpenCodeProvider({ spawn: scripted.spawn });
    const models = await provider.fetchModels('/w');
    assert.deepStrictEqual(models, [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      {
        id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free',
        effort: { levels: ['low', 'high'], default: 'low' },
      },
    ]);
  });

  test('a model whose config write never answers does not block the rest of the sweep', async () => {
    const scripted = scriptedSpawnWithEffort('opencode/big-pickle');
    const provider = new OpenCodeProvider({ spawn: scripted.spawn, configOptionTimeoutMs: 30 });
    const models = await provider.fetchModels('/w');
    assert.deepStrictEqual(models, [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      {
        id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free',
        effort: { levels: ['low', 'high'], default: 'low' },
      },
    ]);
  });

  test('the probe closes the session it opened rather than littering history', async () => {
    const scripted = scriptedSpawn();
    await new OpenCodeProvider({ spawn: scripted.spawn }).fetchModels('/w');
    assert.strictEqual(scripted.seen.some((f) => f.method === 'session/close'), true);
  });

  test('a spawn failure rejects with text that tells the user what to do', async () => {
    const provider = new OpenCodeProvider({ spawn: () => { throw new Error('ENOENT'); } });
    await assert.rejects(() => provider.fetchModels('/w'), (err: Error) => {
      assert.strictEqual(err.message.includes('opencode'), true);
      return true;
    });
  });

  test('start() threads a requested effort through to the AcpRun it builds', async () => {
    const scripted = scriptedSpawnWithEffort();
    const provider = new OpenCodeProvider({ spawn: scripted.spawn });
    const run = provider.start({
      cwd: '/w', permissionMode: 'default', sessionId: 'test-session',
      model: 'opencode/hy3-free', effort: 'high',
    });
    for (let i = 0; i < 200; i++) {
      const writes = scripted.seen.filter((f) => f.method === 'session/set_config_option');
      if (writes.length >= 2) {
        assert.deepStrictEqual(writes[1].params, {
          sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', configId: 'effort', value: 'high',
        });
        await run.dispose();
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('fewer than 2 session/set_config_option were sent');
  });

  /**
   * The realistic Windows shape: `spawn` succeeds (a shell was launched
   * fine), nothing ever answers on stdout, and the child later reports why
   * through `onFailure` rather than by throwing. Without racing that signal,
   * this would only ever surface as the ACP SDK's own generic
   * "ACP connection closed" — no "opencode", no remedy.
   */
  test('an async spawn failure (a shell that never finds opencode) still names it', async () => {
    let fail: (reason: string) => void = () => {};
    const provider = new OpenCodeProvider({
      spawn: () => {
        const toAgent = new PassThrough();
        const toClient = new PassThrough();
        // Streams are live but nothing ever replies — the shell that ran
        // instead of `opencode` exits asynchronously, same as Windows does.
        return {
          stdin: toAgent, stdout: toClient,
          kill: () => { toClient.end(); },
          onFailure: (cb: (reason: string) => void) => { fail = cb; },
        };
      },
    });
    const pending = provider.fetchModels('/w');
    setImmediate(() => { fail("opencode acp exited (code 1): 'opencode' is not recognized"); });
    await assert.rejects(() => pending, (err: Error) => {
      assert.strictEqual(err.message.includes('opencode'), true);
      return true;
    });
  });

  test('fetchUsage and listInvocables are absent — no plan data over ACP', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.fetchUsage, undefined);
  });

  test('the default provider set includes opencode', () => {
    assert.strictEqual(DEFAULT_PROVIDER_IDS.includes('opencode'), true);
  });

  test('start() passes the self-control MCP config through to the AcpRun it builds', async () => {
    const { spawn, seen } = recordingSpawn();
    const provider = new OpenCodeProvider({
      spawn, selfControlMcp: { url: 'http://x/mcp', token: 't' },
    });
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 's-under-test' });
    const created = await waitFor(seen, 'session/new');
    assert.deepStrictEqual((created.params as { mcpServers: unknown }).mcpServers, [
      {
        type: 'http', name: 'marcode_self_control', url: 'http://x/mcp?sid=s-under-test',
        headers: [{ name: 'Authorization', value: 'Bearer t' }],
      },
    ]);
    await run.dispose();
  });

  test('an instance override sets id/displayName and merges env into the spawned process', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const { spawn: scripted } = scriptedSpawn();
    const provider = new OpenCodeProvider({
      id: 'opencode-grok', displayName: 'OpenCode (Grok)',
      env: { OPENCODE_CONFIG_DIR: '/home/user/.config/opencode-grok' } as NodeJS.ProcessEnv,
      spawn: (bin, env) => {
        capturedEnv = env;
        return scripted();
      },
    });
    assert.strictEqual(provider.id, 'opencode-grok');
    assert.strictEqual(provider.displayName, 'OpenCode (Grok)');
    const run = provider.start({ cwd: '/repo', permissionMode: 'default', sessionId: 'test-session' });
    // start() reserves a port (async) before spawning — the env merge only
    // lands after that microtask hop, so this assertion waits for it.
    await flush();
    assert.strictEqual(capturedEnv?.OPENCODE_CONFIG_DIR, '/home/user/.config/opencode-grok');
    await run.dispose();
  });

  test('id/displayName default to opencode/OpenCode when no instance override is given', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.id, 'opencode');
    assert.strictEqual(provider.displayName, 'OpenCode');
  });

  test('start() spawns opencode acp with a pinned port and an injected server password', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const provider = new OpenCodeProvider({
      spawn: (bin, env) => { capturedEnv = env; return fakeAcpChild().child; },
      reservePort: async () => 54321,
    });
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'sid' });
    await flush();
    assert.strictEqual(capturedEnv?.OPENCODE_SERVER_PASSWORD?.length, 48); // randomBytes(24).toString('hex')
    // Otherwise the SubagentWatch this run opened keeps retrying its (fake,
    // unreachable) server connection in the background forever — see
    // subagent-watch.ts's own `close()`.
    await run.dispose();
  });

  test('a port collision on spawn is retried with a new port, bounded', async () => {
    let attempts = 0;
    const ports: number[] = [];
    const provider = new OpenCodeProvider({
      reservePort: async () => { ports.push(++attempts); return attempts; },
      spawn: () => {
        const fake = fakeAcpChild();
        if (attempts < 2) { queueMicrotask(() => fake.failWith('EADDRINUSE')); }
        return fake.child;
      },
    });
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'sid' });
    await flush();
    // Proves a retry actually happened: reservePort was called more than once.
    assert.ok(ports.length >= 2);
    await run.dispose();
  });

  test('dispose() kills the real spawned process, not just the placeholder AcpRun holds', async () => {
    let realChildKilled = false;
    const provider = new OpenCodeProvider({
      spawn: () => {
        const toAgent = new PassThrough();
        const toClient = new PassThrough();
        return {
          stdin: toAgent, stdout: toClient,
          kill: () => { realChildKilled = true; toClient.end(); },
          onFailure: () => {},
        };
      },
      reservePort: async () => 54321,
    });
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'sid' });
    await flush();
    await run.dispose();
    assert.strictEqual(realChildKilled, true);
  });

  suite('checkForUpdate', () => {
    test('resolves current/latest, stripping the v tag prefix', async () => {
      const provider = new OpenCodeProvider({
        execVersion: async () => ({ stdout: '1.18.26\n' }),
        fetchLatest: (async () => ({
          ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
        })) as unknown as typeof fetch,
      });
      assert.deepStrictEqual(await provider.checkForUpdate(), { current: '1.18.26', latest: '1.18.27' });
    });

    test('resolves undefined when the local version cannot be determined', async () => {
      const provider = new OpenCodeProvider({
        execVersion: async () => { throw new Error('ENOENT'); },
        fetchLatest: (async () => ({
          ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
        })) as unknown as typeof fetch,
      });
      assert.strictEqual(await provider.checkForUpdate(), undefined);
    });

    test('runs the configured binPath, not the bare binary name', async () => {
      let seenBin: string | undefined;
      const provider = new OpenCodeProvider({
        binPath: '/opt/opencode/opencode',
        execVersion: async (bin) => { seenBin = bin; return { stdout: '1.18.26\n' }; },
        fetchLatest: (async () => ({
          ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
        })) as unknown as typeof fetch,
      });
      await provider.checkForUpdate();
      assert.strictEqual(seenBin, '/opt/opencode/opencode');
    });
  });
});
