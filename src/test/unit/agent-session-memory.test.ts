import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type { Invocable, SessionId, SessionState, TranscriptPatch } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { UsageWindow } from '../../providers/types';

function baseState(resumeTokens: SessionState['resumeTokens'] = {}): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', name: 'Untitled', cwd: '/repo', status: 'idle', permissionMode: 'default',
    includeEditorContext: true, resumeTokens,
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class MemorySink implements SessionSink {
  recalls: string[] = [];
  constructor(private readonly answer: () => Promise<string | undefined>) {}
  patch(_id: SessionId, _patch: TranscriptPatch) { /* not asserted here */ }
  status() { /* not asserted here */ }
  mcp() { /* not asserted here */ }
  cacheWindow() { /* not asserted here */ }
  changed() { /* not asserted here */ }
  invocables(_id: SessionId, _entries: Invocable[]) { /* not asserted here */ }
  usageWindows(_providerId: string, _windows: UsageWindow[] | undefined) { /* not asserted */ }
  recall(text: string) { this.recalls.push(text); return this.answer(); }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession memory priming', () => {
  let dir: string;
  let store: TranscriptStore;
  const open: AgentSession[] = [];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-memory-'));
    store = new TranscriptStore(dir);
  });
  teardown(async () => {
    while (open.length > 0) { await open.pop()!.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  function make(answer: () => Promise<string | undefined>, state = baseState()) {
    const provider = new FakeProvider();
    const sink = new MemorySink(answer);
    const session = new AgentSession(state, provider, store, sink);
    open.push(session);
    return { provider, sink, session };
  }

  test('the first message reaches the provider behind the memory block, the transcript keeps only the typed text', async () => {
    const { provider, session } = make(async () => '<marcode-memory>hit</marcode-memory>');
    session.send('fix the login test');
    await settle();
    assert.strictEqual(provider.sent[0].text, '<marcode-memory>hit</marcode-memory>\n\nfix the login test');
    const users = (await session.snapshot()).items.filter((i) => i.role === 'user');
    assert.strictEqual((users[0] as { text: string }).text, 'fix the login test');
  });

  test('no block means the message goes through unchanged', async () => {
    const { provider, session } = make(async () => undefined);
    session.send('hello there');
    await settle();
    assert.strictEqual(provider.sent[0].text, 'hello there');
  });

  test('a failing lookup still sends the message', async () => {
    const { provider, session } = make(async () => { throw new Error('boom'); });
    session.send('hello there');
    await settle();
    assert.strictEqual(provider.sent[0].text, 'hello there');
  });

  test('only the first message triggers a lookup', async () => {
    const { provider, sink, session } = make(async () => '<marcode-memory>hit</marcode-memory>');
    session.send('first');
    await settle();
    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();
    session.send('second');
    await settle();
    assert.strictEqual(sink.recalls.length, 1);
    assert.strictEqual(provider.sent[1].text, 'second');
  });

  test('a resumed session is never primed', async () => {
    const { provider, sink, session } = make(
      async () => 'x', baseState({ 'fake:/repo': 'tok', fake: 'tok' } as SessionState['resumeTokens']),
    );
    session.send('hello there');
    await settle();
    assert.strictEqual(sink.recalls.length, 0);
    assert.strictEqual(provider.sent[0].text, 'hello there');
  });

  test('a message sent while the lookup is pending keeps its order', async () => {
    let release!: (v: string) => void;
    const { provider, session } = make(() => new Promise<string>((r) => { release = r; }));
    session.send('first');
    session.send('second');
    await settle();
    assert.strictEqual(provider.sent.length, 0);
    release('<marcode-memory>hit</marcode-memory>');
    await settle();
    assert.strictEqual(provider.sent[0].text.endsWith('first'), true);
  });
});
