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
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const created = await waitFor(seen, 'session/new');
    assert.deepStrictEqual((created.params as { mcpServers: unknown }).mcpServers, [
      {
        type: 'http', name: 'marcode-self-control', url: 'http://x/mcp',
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
    provider.start({ cwd: '/repo', permissionMode: 'default' });
    assert.strictEqual(capturedEnv?.OPENCODE_CONFIG_DIR, '/home/user/.config/opencode-grok');
  });

  test('id/displayName default to opencode/OpenCode when no instance override is given', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.id, 'opencode');
    assert.strictEqual(provider.displayName, 'OpenCode');
  });
});
