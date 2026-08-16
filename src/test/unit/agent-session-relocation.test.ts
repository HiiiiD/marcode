import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type {
  Invocable, SessionId, SessionState, SessionStatus, TranscriptItem, TranscriptPatch,
} from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, UsageWindow } from '../../providers/types';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/repo', status: 'idle', permissionMode: 'default',
    includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    pendingQuestions: [],
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: TranscriptPatch[] = [];
  patch(_id: SessionId, patch: TranscriptPatch) { this.patches.push(patch); }
  status(_id: SessionId, _status: SessionStatus) { /* not asserted here */ }
  mcp(_id: SessionId, _servers: unknown[]) { /* not asserted here */ }
  changed() { /* not asserted here */ }
  invocables(_id: SessionId, _entries: Invocable[]) { /* not asserted here */ }
  usageWindows(_providerId: string, _windows: UsageWindow[] | undefined) { /* not asserted */ }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession relocation offer', () => {
  let dir: string;
  let store: TranscriptStore;
  const open: AgentSession[] = [];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-reloc-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => {
    while (open.length > 0) { await open.pop()!.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * A session over FakeProvider with a handle on its run, so a test can push
   * events straight in the way a real provider does — without a `send` first,
   * because the offer is a reaction to a tool call, not to a user message.
   */
  async function makeSession() {
    const provider = new FakeProvider();
    const sink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, sink);
    open.push(session);
    const run = provider.runs[0];
    return {
      session, provider,
      patches: sink.patches as { op: string; item?: TranscriptItem }[],
      emit: (event: AgentEvent) => { run.emit(event); },
    };
  }

  test('appends a pending offer after a successful worktree add', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/a -b a' } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    const offers = patches
      .map((p) => p.item)
      .filter((i): i is TranscriptItem => i?.role === 'relocation');
    assert.strictEqual(offers.length, 1);
    assert.strictEqual(offers[0].role === 'relocation' && offers[0].state, 'pending');
    assert.strictEqual(offers[0].role === 'relocation' && offers[0].path.endsWith('a'), true);
  });

  test('appends nothing when the tree resolves to where the session already is', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add .' } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });

  test('treats a case-differing path as the same tree on Windows', async function () {
    // On win32 the filesystem is case-insensitive, so `C:\Repo` and `C:\repo`
    // are one directory and offering to "move" between them is an offer to go
    // nowhere. On a case-sensitive filesystem they are genuinely different.
    if (process.platform !== 'win32') { this.skip(); }
    const { session, patches, emit } = await makeSession();
    const shouted = session.state.cwd.toUpperCase();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: `git worktree add ${shouted}` } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });

  test('appends nothing for a worktree a subagent created', async () => {
    // A subagent's tree is a side quest: a research agent that makes a scratch
    // worktree, reads it and reports back has no claim on where the parent
    // conversation lives, and a fan-out of them would post one card each.
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'a1',
      tool: { kind: 'subagent', label: 'Agent', action: 'spawn', agent: 'explore' } });
    emit({ kind: 'tool-start', id: 'x1', parentId: 'a1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/scratch -b s' } });
    emit({ kind: 'tool-end', id: 'x1', parentId: 'a1', ok: true, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });

  test('appends nothing when the command failed', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/a' } });
    emit({ kind: 'tool-end', id: 'x1', ok: false, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });

  test('appends nothing for an ordinary command', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'yarn test' } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await settle();
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });
});
