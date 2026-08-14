import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  Invocable, SessionId, SessionState, SessionStatus, TranscriptItem, TranscriptPatch,
} from '../../protocol/messages';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1, includeEditorContext: true,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  servers: unknown[] = [];
  invocablesLog: Invocable[][] = [];
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  mcp(_id: SessionId, servers: unknown[]) { this.servers.push(servers); }
  invocables(_id: SessionId, entries: Invocable[]) { this.invocablesLog.push(entries); }
  // This suite is about tool nesting; usage never arrives here, but the sink
  // must still satisfy the interface.
  usageWindow() {}
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

function toolItems(items: TranscriptItem[]) {
  return items.filter((i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool');
}

suite('AgentSession subagent nesting', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-nest-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a child tool nests under its parent instead of appearing top-level', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: { subagent_type: 'Explore' } },
      { kind: 'tool-start', id: 'c1', name: 'Read', input: { path: 'a.ts' }, parentId: 'task1' },
      { kind: 'tool-end', id: 'c1', ok: true, output: 'contents', parentId: 'task1' },
      { kind: 'tool-end', id: 'task1', ok: true, output: 'found it' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('explore');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1, 'only the parent is a top-level item');
    assert.strictEqual(tools[0].name, 'Task');
    assert.strictEqual(tools[0].state, 'ok');
    assert.strictEqual(tools[0].children?.length, 1);
    assert.strictEqual((tools[0].children![0] as { name: string }).name, 'Read');
    assert.strictEqual((tools[0].children![0] as { state: string }).state, 'ok');
    await session.dispose();
  });

  test('child patches carry parentItemId so the webview can nest them', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Grep', input: {}, parentId: 'task1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const appends = sink.patches
      .map((p) => p.patch)
      .filter((p): p is Extract<TranscriptPatch, { op: 'append' }> => p.op === 'append');
    const parent = appends.find((p) => p.item.role === 'tool' && p.item.name === 'Task');
    const child = appends.find((p) => p.item.role === 'tool' && p.item.name === 'Grep');
    assert.ok(parent && child);
    assert.strictEqual(parent!.parentItemId, undefined);
    assert.strictEqual(child!.parentItemId, parent!.item.id);
    await session.dispose();
  });

  test('nesting is capped at depth 1 — a grandchild flattens to the top parent', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Task', input: {}, parentId: 'task1' },
      { kind: 'tool-start', id: 'g1', name: 'Read', input: {}, parentId: 'c1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].children?.length, 2, 'grandchild flattened alongside the child');
    const names = tools[0].children!.map((c) => (c as { name: string }).name);
    assert.deepStrictEqual(names, ['Task', 'Read']);
    for (const child of tools[0].children!) {
      assert.strictEqual((child as { children?: unknown }).children, undefined);
    }
    await session.dispose();
  });

  test('a child whose parent was never seen is promoted to top-level', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'c1', name: 'Read', input: {}, parentId: 'ghost' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'Read');
    assert.strictEqual(tools[0].children, undefined);
    await session.dispose();
  });

  test('an abandoned subagent is still written, with its children and an error state', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Read', input: {}, parentId: 'task1' },
      { kind: 'turn-end', reason: 'interrupted' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();
    await session.dispose();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    const tools = toolItems(items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].state, 'error');
    assert.strictEqual(tools[0].children?.length, 1);
  });

  test('a permission raised inside a subagent nests under it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Bash', input: { command: 'ls' }, parentId: 'task1' },
      { kind: 'permission', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const appends = sink.patches
      .map((p) => p.patch)
      .filter((p): p is Extract<TranscriptPatch, { op: 'append' }> => p.op === 'append');
    const perm = appends.find((p) => p.item.role === 'permission');
    assert.ok(perm, 'a permission item was appended');
    assert.ok(perm!.parentItemId, 'it nests under the subagent that raised it');

    const snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 1, 'still a top-level pending approval');
    assert.strictEqual(session.state.status, 'awaiting-approval');
    await session.dispose();
  });

  test('a permission answered after its parent was force-flushed still persists to the store', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Bash', input: { command: 'ls' }, parentId: 'task1' },
      { kind: 'permission', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'turn-end', reason: 'interrupted' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    session.respondToPermission('c1', { allow: true });
    await settle();
    await session.dispose();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    const tools = toolItems(items);
    assert.strictEqual(tools.length, 1);
    const child = tools[0].children?.find((c) => c.role === 'permission');
    assert.ok(child, 'the child permission item persisted on the parent');
    assert.strictEqual((child as { state: string }).state, 'allowed');
  });

  test('disposing a session mid-subagent still flushes its buffered children', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Read', input: {}, parentId: 'task1' },
      { kind: 'tool-end', id: 'c1', ok: true, output: 'contents', parentId: 'task1' },
      // Deliberately no turn-end: the provider is closed out from under the
      // running Task, the way a pane being closed mid-subagent looks.
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();
    await session.dispose();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    const tools = toolItems(items);
    assert.strictEqual(tools.length, 1, 'the parent is persisted');
    assert.strictEqual(tools[0].state, 'error');
    assert.strictEqual(tools[0].children?.length, 1, 'its child was not discarded');
    assert.strictEqual((tools[0].children![0] as { name: string }).name, 'Read');
  });

  test('an mcp tool name is split onto the item at creation', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'mcp__github__create_pr', input: {} },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools[0].name, 'create_pr');
    assert.strictEqual(tools[0].mcpServer, 'github');
    await session.dispose();
  });

  test('a plain tool call still produces no children field at all', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'Read', input: {} },
      { kind: 'tool-end', id: 't1', ok: true, output: 'x' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools[0].children, undefined);
    assert.strictEqual(tools[0].mcpServer, undefined);
    await session.dispose();
  });
});
