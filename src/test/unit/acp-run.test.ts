import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { AcpRun } from '../../providers/acp/acp-run';
import { openCodeModeId } from '../../providers/opencode/map-modes';
import { openCodeTools } from '../../providers/opencode/map-tools';
import type { AgentEvent } from '../../providers/types';

/** A scripted ACP agent. `sent` records what the run wrote; `emit` pushes a
 *  frame back at it. */
function peer() {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  toAgent.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) { sent.push(JSON.parse(line)); }
    }
  });
  const emit = (frame: unknown): void => { toClient.write(`${JSON.stringify(frame)}\n`); };
  let notify: (reason: string) => void = () => {};
  const child = {
    stdin: toAgent, stdout: toClient,
    kill: () => { toClient.end(); },
    onFailure: (cb: (reason: string) => void) => { notify = cb; },
  };
  /** The child died and said why — what `spawnOpenCodeAcp`'s own `fail()` reports. */
  const crash = (reason: string): void => { notify(reason); toClient.end(); };
  const waitFor = async (method: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const hit = sent.find((f) => f.method === method);
      if (hit) { return hit; }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no ${method} was sent`);
  };
  return { child, sent, emit, waitFor, crash };
}

const collect = (run: AcpRun, into: AgentEvent[]): void => {
  void (async () => { for await (const e of run.events) { into.push(e); } })();
};

/**
 * Answers the whole startup handshake — `initialize`, `session/new` and the
 * mode assertion `startInner` awaits — and returns that `session/set_mode`
 * frame. Anything that needs `startup` to actually resolve (every setter goes
 * through it, and so does `send`) has to answer all three.
 */
const modeWrites = async (
  p: ReturnType<typeof peer>, n: number,
): Promise<Record<string, unknown>[]> => {
  for (let i = 0; i < 200; i++) {
    const hits = p.sent.filter((f) => f.method === 'session/set_mode');
    if (hits.length >= n) { return hits; }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`fewer than ${n} session/set_mode were sent`);
};

const handshake = async (p: ReturnType<typeof peer>): Promise<Record<string, unknown>> => {
  const init = await p.waitFor('initialize');
  p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
  const created = await p.waitFor('session/new');
  p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
  const mode = await p.waitFor('session/set_mode');
  p.emit({ jsonrpc: '2.0', id: mode.id, result: {} });
  await new Promise((r) => setTimeout(r, 20));
  return mode;
};

suite('AcpRun', () => {
  test('initializes with protocol version 1 and no fs or terminal capability', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    const init = await p.waitFor('initialize');
    assert.deepStrictEqual((init.params as { clientCapabilities: unknown }).clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    });
    assert.strictEqual((init.params as { protocolVersion: number }).protocolVersion, 1);
    await run.dispose();
  });

  test('emits a session event carrying the session id as the resume token', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(events[0],
      { kind: 'session', resumeToken: 'ses_ff0400c8affe2kYFjqc6OUHpG3' });
    await run.dispose();
  });

  test('a session update reaches the event stream', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', update: frames.updates.agentMessageChunk } });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'text' && e.delta === 'Done'), true);
    await run.dispose();
  });

  test("a read's tool-end keeps the kind and path the earlier frames carried", async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    await handshake(p);
    for (const update of [frames.updates.readToolCall, frames.updates.readToolCallInProgress,
      frames.updates.readToolCallCompleted]) {
      p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', update } });
    }
    await new Promise((r) => setTimeout(r, 20));
    const end = events.find((e) => e.kind === 'tool-end') as { tool?: unknown } | undefined;
    assert.deepStrictEqual(end?.tool, {
      kind: 'file-read', label: 'Read',
      path: 'C:/Users/dev/AppData/Local/Temp/oc-read-spike/notes.txt',
    });
    await run.dispose();
  });

  test('a permission request under default mode parks as a permission event', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', id: 900, method: 'session/request_permission',
             params: frames.requestPermission });
    await new Promise((r) => setTimeout(r, 20));
    const parked = events.find((e) => e.kind === 'permission');
    assert.strictEqual(parked !== undefined, true);
    run.respondToTool((parked as { id: string }).id, { allow: true });
    await new Promise((r) => setTimeout(r, 20));
    const reply = p.sent.find((f) => f.id === 900 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result,
      { outcome: { outcome: 'selected', optionId: 'once' } });
    await run.dispose();
  });

  test('bypass answers the permission itself and surfaces no card', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'bypass', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', id: 901, method: 'session/request_permission',
             params: frames.requestPermission });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'permission'), false);
    const reply = p.sent.find((f) => f.id === 901 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result,
      { outcome: { outcome: 'selected', optionId: 'always' } });
    await run.dispose();
  });

  test('contextBreakdown reports the last usage update', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', update: frames.updates.usageUpdate } });
    await new Promise((r) => setTimeout(r, 20));
    const breakdown = await run.contextBreakdown!();
    assert.strictEqual(breakdown.windowTokens, 200000);
    assert.strictEqual(breakdown.usedTokens, 8896);
    await run.dispose();
  });

  test('a replayed update during session/load is suppressed', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
      resumeToken: 'ses_old',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    await p.waitFor('session/load');
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_old', update: frames.updates.agentMessageChunk } });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'text'), false);
    await run.dispose();
  });

  test('setModel writes the model config option', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, []);
    await handshake(p);
    run.setModel('opencode/hy3-free');
    const set = await p.waitFor('session/set_config_option');
    assert.deepStrictEqual(set.params, {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', configId: 'model', value: 'opencode/hy3-free',
    });
    await run.dispose();
  });

  test('a rejected setter never rejects to the caller', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, []);
    await handshake(p);
    run.setModel('nope');
    const set = await p.waitFor('session/set_config_option');
    p.emit({ jsonrpc: '2.0', id: set.id,
             error: { code: -32602, message: 'model not found: nope' } });
    // The assertion is that this test finishes without an unhandled rejection.
    await new Promise((r) => setTimeout(r, 30));
    await run.dispose();
  });

  test('a send after a failed startup ends the turn instead of hanging it', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id,
             error: { code: -32603, message: 'agent is broken' } });
    await new Promise((r) => setTimeout(r, 20));
    // The user retries by typing. Only a turn-end clears `running`, and the
    // one startup pushed belongs to the turn that already ended.
    run.send('are you there');
    await new Promise((r) => setTimeout(r, 20));
    const failed = events.filter(
      (e): e is Extract<AgentEvent, { kind: 'turn-end' }> =>
        e.kind === 'turn-end' && e.reason === 'error',
    );
    assert.strictEqual(failed.length, 2);
    assert.strictEqual(failed[1].error, 'agent is broken');
    await run.dispose();
  });

  test('the mode a session was created with is asserted at startup', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'plan', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, []);
    // ACP's session/new carries no mode, and AgentSession only calls
    // setPermissionMode on a user CHANGE — so without this write a session
    // created (or reloaded) as plan comes up in the agent's default.
    const created = await handshake(p);
    assert.deepStrictEqual(created.params,
      { sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', modeId: 'plan' });

    // ...and leaving plan retracts it: only an explicit build takes the agent
    // back out, so a client-side-enforced mode still has to write one.
    run.setPermissionMode('bypass');
    const writes = await modeWrites(p, 2);
    assert.deepStrictEqual(writes[1].params,
      { sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', modeId: 'build' });
    await run.dispose();
  });

  test('a mode the agent never advertised is not written', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'plan', tools: openCodeTools,
      // A mapper written against some other ACP agent. The neutral layer
      // checks the vendor's answer against the ids session/new advertised.
      modeId: () => 'architect', clientName: 'mar-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(p.sent.some((f) => f.method === 'session/set_mode'), false);
    await run.dispose();
  });

  test('interrupt cancels a parked permission request', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    await handshake(p);
    run.send('edit the file');
    const prompt = await p.waitFor('session/prompt');
    p.emit({ jsonrpc: '2.0', id: 902, method: 'session/request_permission',
             params: frames.requestPermission });
    await new Promise((r) => setTimeout(r, 20));
    const parked = events.find((e) => e.kind === 'permission');
    assert.strictEqual(parked !== undefined, true);

    // session/cancel is a notification and the SDK does not abort inbound
    // request handlers, so nothing but this drain answers the parked request.
    const stopped = run.interrupt();
    const cancel = await p.waitFor('session/cancel');
    assert.deepStrictEqual((cancel.params as { sessionId: string }).sessionId,
      'ses_ff0400c8affe2kYFjqc6OUHpG3');
    p.emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
    await stopped;

    const reply = p.sent.find((f) => f.id === 902 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result, { outcome: { outcome: 'cancelled' } });
    // The card has to stop rendering pending, or recomputeWaitingStatus pins
    // the session at awaiting-approval for a turn that no longer exists.
    assert.strictEqual(
      events.some((e) => e.kind === 'request-cancelled'
        && e.id === (parked as { id: string }).id),
      true,
    );
    assert.strictEqual(
      events.some((e) => e.kind === 'turn-end' && e.reason === 'interrupted'), true);
    await run.dispose();
  });

  test('a child that dies mid-turn reports its own reason, not the SDK close', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, events);
    await handshake(p);
    run.send('build it');
    await p.waitFor('session/prompt');
    // Startup already settled, so the onFailure rejection start() races has
    // nowhere to land — only the retained reason saves it.
    p.crash('opencode acp exited (code 1): out of memory');
    await new Promise((r) => setTimeout(r, 30));
    const failed = events.find(
      (e): e is Extract<AgentEvent, { kind: 'turn-end' }> =>
        e.kind === 'turn-end' && e.reason === 'error',
    );
    assert.strictEqual(failed?.error, 'opencode acp exited (code 1): out of memory');
    await run.dispose();
  });

  test('dispose returns when the agent never answered initialize', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    collect(run, []);
    await p.waitFor('initialize');
    // Never answered. `send` parks on a startup promise that will never
    // resolve — nothing dispose does may wait on it, or extension shutdown
    // blocks on this one agent and its child is never killed.
    run.send('hello');
    await new Promise((r) => setTimeout(r, 20));
    const outcome = await Promise.race([
      run.dispose().then(() => 'disposed'),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    assert.strictEqual(outcome, 'disposed');
  });

  /**
   * The realistic Windows shape: `spawn` succeeds — the streams are live —
   * but nothing ever answers `initialize`, and the child later reports why
   * through `onFailure` rather than by throwing (a shell that ran instead of
   * `opencode` and exits async). Without racing that signal, startup only
   * ever fails via the SDK's own stream-close handling, whose generic
   * "ACP connection closed" names neither the binary nor a fix.
   */
  test('an async spawn failure surfaces its real reason, not the SDK’s generic close', async () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    let fail: (reason: string) => void = () => {};
    const child = {
      stdin: toAgent, stdout: toClient,
      kill: () => { toClient.end(); },
      onFailure: (cb: (reason: string) => void) => { fail = cb; },
    };
    const run = new AcpRun(child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code',
    });
    const events: AgentEvent[] = [];
    collect(run, events);
    setImmediate(() => { fail("opencode acp exited (code 1): 'opencode' is not recognized"); });
    await new Promise((r) => setTimeout(r, 30));
    const failed = events.find(
      (e): e is Extract<AgentEvent, { kind: 'turn-end' }> => e.kind === 'turn-end' && e.reason === 'error',
    );
    assert.strictEqual(failed !== undefined, true);
    assert.strictEqual(failed?.error?.includes('opencode'), true);
    assert.strictEqual(failed?.error?.includes('ACP connection closed'), false);
    await run.dispose();
  });
});
