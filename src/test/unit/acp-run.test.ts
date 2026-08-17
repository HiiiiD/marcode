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
});
