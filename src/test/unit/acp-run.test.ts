import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { AcpRun } from '../../providers/acp/acp-run';
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
  const child = { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  const waitFor = async (method: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const hit = sent.find((f) => f.method === method);
      if (hit) { return hit; }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no ${method} was sent`);
  };
  return { child, sent, emit, waitFor };
}

const collect = (run: AcpRun, into: AgentEvent[]): void => {
  void (async () => { for await (const e of run.events) { into.push(e); } })();
};

suite('AcpRun', () => {
  test('initializes with protocol version 1 and no fs or terminal capability', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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

  test('a permission request under default mode parks as a permission event', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'bypass', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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

  test('leaving plan mode retracts it on the wire', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'plan', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));

    const modeWrites = async (n: number): Promise<Record<string, unknown>[]> => {
      for (let i = 0; i < 200; i++) {
        const hits = p.sent.filter((f) => f.method === 'session/set_mode');
        if (hits.length >= n) { return hits; }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`fewer than ${n} session/set_mode were sent`);
    };

    run.setPermissionMode('plan');
    const first = await modeWrites(1);
    assert.deepStrictEqual(first[0].params,
      { sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', modeId: 'plan' });
    p.emit({ jsonrpc: '2.0', id: first[0].id, result: {} });

    // bypass is enforced client-side for permission ANSWERING, but only an
    // explicit `build` takes the agent back out of plan mode.
    run.setPermissionMode('bypass');
    const both = await modeWrites(2);
    assert.deepStrictEqual(both[1].params,
      { sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', modeId: 'build' });
    await run.dispose();
  });

  test('dispose returns when the agent never answered initialize', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
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
