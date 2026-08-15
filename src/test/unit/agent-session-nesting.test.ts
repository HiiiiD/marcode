import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  Invocable, SessionId, SessionState, SessionStatus, ToolCall, TranscriptItem, TranscriptPatch,
} from '../../protocol/messages';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    resumeTokens: {},
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
  usageWindows() {}
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

function toolItems(items: TranscriptItem[]) {
  return items.filter((i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool');
}

const TASK: ToolCall = { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' };
const READ: ToolCall = { kind: 'file-read', label: 'Read', path: 'a.ts' };
const GREP: ToolCall = { kind: 'search', label: 'Grep', pattern: 'x', mode: 'content' };
const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };

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
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: READ, parentId: 'task1' },
      { kind: 'tool-end', id: 'c1', ok: true, output: { kind: 'text', text: 'contents' }, parentId: 'task1' },
      { kind: 'tool-end', id: 'task1', ok: true, output: { kind: 'text', text: 'found it' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('explore');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1, 'only the parent is a top-level item');
    assert.strictEqual(tools[0].tool.label, 'Task');
    assert.strictEqual(tools[0].state, 'ok');
    assert.strictEqual(tools[0].children?.length, 1);
    assert.strictEqual((tools[0].children![0] as Extract<TranscriptItem, { role: 'tool' }>).tool.label, 'Read');
    assert.strictEqual((tools[0].children![0] as { state: string }).state, 'ok');
    await session.dispose();
  });

  test('child patches carry parentItemId so the webview can nest them', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: GREP, parentId: 'task1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const appends = sink.patches
      .map((p) => p.patch)
      .filter((p): p is Extract<TranscriptPatch, { op: 'append' }> => p.op === 'append');
    const parent = appends.find((p) => p.item.role === 'tool' && p.item.tool.label === 'Task');
    const child = appends.find((p) => p.item.role === 'tool' && p.item.tool.label === 'Grep');
    assert.ok(parent && child);
    assert.strictEqual(parent!.parentItemId, undefined);
    assert.strictEqual(child!.parentItemId, parent!.item.id);
    await session.dispose();
  });

  test('nesting is capped at depth 1 — a grandchild flattens to the top parent', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: TASK, parentId: 'task1' },
      { kind: 'tool-start', id: 'g1', tool: READ, parentId: 'c1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].children?.length, 2, 'grandchild flattened alongside the child');
    const labels = tools[0].children!.map(
      (c) => (c as Extract<TranscriptItem, { role: 'tool' }>).tool.label,
    );
    assert.deepStrictEqual(labels, ['Task', 'Read']);
    for (const child of tools[0].children!) {
      assert.strictEqual((child as { children?: unknown }).children, undefined);
    }
    await session.dispose();
  });

  test('a child whose parent was never seen is promoted to top-level', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'c1', tool: READ, parentId: 'ghost' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].tool.label, 'Read');
    assert.strictEqual(tools[0].children, undefined);
    await session.dispose();
  });

  test('an abandoned subagent is still written, with its children and an error state', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: READ, parentId: 'task1' },
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
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: BASH, parentId: 'task1' },
      { kind: 'permission', id: 'c1', tool: BASH },
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
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: BASH, parentId: 'task1' },
      { kind: 'permission', id: 'c1', tool: BASH },
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
      { kind: 'tool-start', id: 'task1', tool: TASK },
      { kind: 'tool-start', id: 'c1', tool: READ, parentId: 'task1' },
      { kind: 'tool-end', id: 'c1', ok: true, output: { kind: 'text', text: 'contents' }, parentId: 'task1' },
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
    assert.strictEqual(
      (tools[0].children![0] as Extract<TranscriptItem, { role: 'tool' }>).tool.label, 'Read',
    );
  });

  // Splitting an `mcp__<server>__<tool>` name is now the provider
  // classifier's job (see providers/canonical/tool-call.ts's `parseMcpName`
  // and each provider's own map-tools.ts), not AgentSession's — the host no
  // longer parses tool names at all. This exercises the equivalent behavior
  // one layer up: a `tool-start` already carrying a classified `mcp` call is
  // persisted on the item exactly as the provider built it.
  test('an mcp-classified call is persisted on the item as the provider built it', async () => {
    const mcp: ToolCall = { kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' };
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: mcp },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.deepStrictEqual(tools[0].tool, mcp);
    await session.dispose();
  });

  test('a plain tool call still produces no children field at all', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: READ },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'x' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools[0].children, undefined);
    await session.dispose();
  });
});
