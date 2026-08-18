import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { OpenCodeProvider } from '../../providers/opencode/opencode-provider';

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

  test('fetchUsage and listInvocables are absent — no plan data over ACP', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.fetchUsage, undefined);
  });
});
