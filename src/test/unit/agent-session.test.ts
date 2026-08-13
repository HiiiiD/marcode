import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { SessionId, SessionState, SessionStatus, TranscriptPatch } from '../../protocol/messages';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-session-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('coalesces text deltas into one assistant item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    const snap = await session.snapshot();
    const assistant = snap.items.filter((i) => i.role === 'assistant');
    assert.strictEqual(assistant.length, 1);
    assert.strictEqual((assistant[0] as { text: string }).text, 'Hello');

    const deltas = sink.patches.filter((p) => p.patch.op === 'delta');
    assert.strictEqual(deltas.length, 2, 'each delta is streamed separately');
    await session.dispose();
  });

  test('appends the user message and derives the title from it', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('Refactor the auth module');
    await settle();

    assert.strictEqual(session.state.title, 'Refactor the auth module');
    const snap = await session.snapshot();
    assert.strictEqual(snap.items[0].role, 'user');
    await session.dispose();
  });

  test('a permission event parks the session and respondToPermission settles it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval');
    let snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 1);
    assert.strictEqual(snap.pending[0].requestId, 'r1');

    session.respondToPermission('r1', { allow: true });
    await settle();

    assert.deepStrictEqual(provider.decisions.get('r1'), { allow: true });
    snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 0);
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { state: string }).state, 'allowed');
    await session.dispose();
  });

  test('tool-start then tool-end replaces the tool item in place', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'Read', input: { path: 'a.ts' } },
      { kind: 'tool-end', id: 't1', ok: true, output: 'contents' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('read a.ts');
    await settle();

    const snap = await session.snapshot();
    const tools = snap.items.filter((i) => i.role === 'tool');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual((tools[0] as { state: string }).state, 'ok');
    assert.ok(sink.patches.some((p) => p.patch.op === 'replace'));
    await session.dispose();
  });

  test('turn-end with error moves the session to error and appends an error item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'turn-end', reason: 'error', error: 'spawn failed' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'spawn failed');
    await session.dispose();
  });

  test('dispose denies outstanding permissions so the provider can unwind', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: {} },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    await session.dispose();
    assert.deepStrictEqual(provider.decisions.get('r1'), {
      allow: false, reason: 'Session closed',
    });
  });

  test('records the resume token from the session event', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    assert.strictEqual(session.state.resumeToken, 'fake-session-1');
    await session.dispose();
  });
});
