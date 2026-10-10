import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type { Invocable, SessionId, SessionState, SessionStatus, TranscriptPatch } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { UsageWindow } from '../../providers/types';
import type { ShellAliasTable } from '../../host/shell/shell-aliases';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', name: 'Untitled', cwd: process.cwd(), status: 'idle', permissionMode: 'default',
    includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1,
  };
}

const ALIASES: ShellAliasTable = { node: { command: process.execPath, args: ['-e'] } };

class Sink implements SessionSink {
  patches: TranscriptPatch[] = [];
  patch(_id: SessionId, p: TranscriptPatch) { this.patches.push(p); }
  status(_id: SessionId, _s: SessionStatus) { /* not asserted */ }
  mcp() { /* not asserted */ }
  cacheWindow() { /* not asserted */ }
  changed() { /* not asserted */ }
  invocables(_id: SessionId, _e: Invocable[]) { /* not asserted */ }
  usageWindows(_p: string, _w: UsageWindow[] | undefined) { /* not asserted */ }
  shellAliases() { return ALIASES; }
}

const settle = async (ms = 50) => { await new Promise((r) => setTimeout(r, ms)); };
async function until(cond: () => boolean) {
  for (let i = 0; i < 150 && !cond(); i++) { await settle(20); }
}

suite('AgentSession shell', () => {
  let dir: string; let store: TranscriptStore;
  const open: AgentSession[] = [];
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-shell-')); store = new TranscriptStore(dir); });
  teardown(async () => {
    while (open.length) { await open.pop()!.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  function make(script: ConstructorParameters<typeof FakeProvider>[0] = () => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]) {
    const provider = new FakeProvider(script);
    const sink = new Sink();
    const session = new AgentSession(baseState(), provider, store, sink);
    open.push(session);
    return { provider, sink, session };
  }
  const shellItems = (sink: Sink) => sink.patches.flatMap((p) => ('item' in p && p.item.role === 'shell' ? [p.item] : []));

  test('runShell appends a running item and finishes it, persisted', async () => {
    const { session, sink } = make();
    session.runShell('node console.log("hi")');
    await until(() => shellItems(sink).at(-1)?.state === 'done');
    const last = shellItems(sink).at(-1)!;
    assert.deepStrictEqual([last.state, last.exitCode, last.output.trim()], ['done', 0, 'hi']);
    const snap = await session.snapshot();
    assert.strictEqual(snap.items.some((i) => i.role === 'shell' && i.state === 'done'), true);
  });

  test('the next typed prompt carries the output once; the user item records only the typed text', async () => {
    const { session, sink, provider } = make();
    session.runShell('node console.log("marker-123")');
    await until(() => shellItems(sink).at(-1)?.state === 'done');
    session.send('what did that print?');
    await until(() => provider.sent.length > 0);
    assert.strictEqual(provider.sent[0].text.includes('marker-123'), true);
    assert.strictEqual(provider.sent[0].text.endsWith('what did that print?'), true);
    const snap = await session.snapshot();
    const user = snap.items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text, 'what did that print?');
    await until(() => session.state.status === 'idle');
    session.send('again');
    await until(() => provider.sent.length > 1);
    assert.strictEqual(provider.sent[1].text.includes('marker-123'), false);
  });

  test('a delegated prompt does not carry the shell output', async () => {
    const { session, sink, provider } = make();
    session.runShell('node console.log("private-out")');
    await until(() => shellItems(sink).at(-1)?.state === 'done');
    session.send('hello from peer', undefined, undefined, undefined, { sessionId: 's2', name: 'peer' });
    await until(() => provider.sent.length > 0);
    assert.strictEqual(provider.sent[0].text.includes('private-out'), false);
    await until(() => session.state.status === 'idle');
    session.send('now me');
    await until(() => provider.sent.length > 1);
    assert.strictEqual(provider.sent[1].text.includes('private-out'), true);
  });

  test('a slash command stays at the start of the prompt and the output waits for the next one', async () => {
    const { session, sink, provider } = make();
    session.runShell('node console.log("held-back")');
    await until(() => shellItems(sink).at(-1)?.state === 'done');
    session.send('/compact');
    await until(() => provider.sent.length > 0);
    assert.strictEqual(provider.sent[0].text, '/compact');
    await until(() => session.state.status === 'idle');
    session.send('what was that?');
    await until(() => provider.sent.length > 1);
    assert.strictEqual(provider.sent[1].text.includes('held-back'), true);
  });

  test('a second command while one runs is refused with an error item', async () => {
    const { session, sink } = make();
    session.runShell('node setInterval(()=>{},1000)');
    session.runShell('node 1');
    await settle();
    const snap = await session.snapshot();
    assert.strictEqual(snap.items.filter((i) => i.role === 'shell').length, 1);
    assert.strictEqual(snap.items.some((i) => i.role === 'error'), true);
    const running = shellItems(sink).at(-1)!;
    session.cancelShell(running.id);
    await until(() => shellItems(sink).at(-1)?.state === 'cancelled');
    assert.strictEqual(shellItems(sink).at(-1)?.state, 'cancelled');
  });

  test('a command runs while a turn is in flight and leaves the status alone', async () => {
    const { session, sink } = make(() => [{ kind: 'text', delta: 'x' }]);
    session.send('go');
    await settle();
    const before = session.state.status;
    session.runShell('node console.log(1)');
    await until(() => shellItems(sink).at(-1)?.state === 'done');
    assert.strictEqual(shellItems(sink).at(-1)?.state, 'done');
    assert.strictEqual(session.state.status, before);
  });

  test('a finished command stored by an earlier process reaches the next prompt after a reload', async () => {
    store.append('s1', { id: 'u0', ts: 1, role: 'user', text: 'earlier' });
    store.append('s1', { id: 'sh0', ts: 2, role: 'shell', command: 'pwd', state: 'done', output: 'PRE-RELOAD\n', exitCode: 0 });
    await store.flush('s1');
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, new Sink());
    open.push(session);
    await session.snapshot();
    session.send('continue');
    await until(() => provider.sent.length > 0);
    assert.strictEqual(provider.sent.at(-1)!.text.includes('PRE-RELOAD'), true);
  });
});
