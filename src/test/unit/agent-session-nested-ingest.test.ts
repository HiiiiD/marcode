import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  Invocable, SessionId, SessionState, SessionStatus, ToolCall, TranscriptPatch,
} from '../../protocol/messages';
import type { AgentEvent, QuestionAnswers, ToolDecision } from '../../providers/types';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', name: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    resumeTokens: {}, createdAt: 1, updatedAt: 1, includeEditorContext: true,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  mcp() {}
  cacheWindow() {}
  invocables(_id: SessionId, _entries: Invocable[]) {}
  usageWindows() {}
  changed() {}
}

const CARD: ToolCall = { kind: 'subagent', label: 'Subagent', action: 'spawn' };
const READ: ToolCall = { kind: 'file-read', label: 'Read', path: 'a.ts' };
const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };

suite('AgentSession nested ingest', () => {
  let dir: string;
  let sink: RecordingSink;
  let session: AgentSession;
  let providerResponded: string[];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-ingest-'));
    sink = new RecordingSink();
    providerResponded = [];
    const provider = new FakeProvider(() => []);
    session = new AgentSession(baseState(), provider, new TranscriptStore(dir), sink);
    const run = (session as unknown as { run: { respondToTool: (id: string) => void } }).run;
    const original = run.respondToTool.bind(run);
    run.respondToTool = (id: string) => { providerResponded.push(id); original(id); };
  });

  teardown(async () => {
    await session.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const openCard = () => session.ingestNested({ kind: 'tool-start', id: 'card', tool: CARD });

  test('an ingested tool-start with a parentId nests under the card', () => {
    openCard();
    session.ingestNested({ kind: 'tool-start', id: 'c1', tool: READ, parentId: 'card' });
    const nested = sink.patches.filter((p) => p.patch.op === 'append' && 'parentItemId' in p.patch && p.patch.parentItemId);
    assert.strictEqual(nested.length, 1);
  });

  test('a delegated permission is answered through the delegate, not the provider run', () => {
    openCard();
    const decisions: ToolDecision[] = [];
    session.ingestNested(
      { kind: 'permission', id: 'child:p1', tool: BASH, parentId: 'card' },
      { onDecision: (d) => decisions.push(d) },
    );
    assert.strictEqual(session.state.status, 'awaiting-approval');
    session.respondToPermission('child:p1', { allow: true });
    assert.deepStrictEqual(decisions, [{ allow: true }]);
    assert.deepStrictEqual(providerResponded, []);
    assert.notStrictEqual(session.state.status, 'awaiting-approval');
  });

  test('a second answer to the same delegated permission is a no-op', () => {
    openCard();
    const decisions: ToolDecision[] = [];
    session.ingestNested(
      { kind: 'permission', id: 'child:p1', tool: BASH, parentId: 'card' },
      { onDecision: (d) => decisions.push(d) },
    );
    session.respondToPermission('child:p1', { allow: true });
    session.respondToPermission('child:p1', { allow: false });
    assert.strictEqual(decisions.length, 1);
  });

  test('interrupt denies a delegated permission and tells the delegate', async () => {
    openCard();
    const decisions: ToolDecision[] = [];
    session.ingestNested(
      { kind: 'permission', id: 'child:p1', tool: BASH, parentId: 'card' },
      { onDecision: (d) => decisions.push(d) },
    );
    await session.interrupt();
    assert.deepStrictEqual(decisions, [{ allow: false, reason: 'Turn cancelled' }]);
    assert.notStrictEqual(session.state.status, 'awaiting-approval');
  });

  test('a delegated question is answered through the delegate and cancelled on interrupt', async () => {
    openCard();
    const answers: QuestionAnswers[] = [];
    let cancelled = 0;
    const question: AgentEvent = { kind: 'question', id: 'child:q1', questions: [], blocking: true };
    session.ingestNested(question, { onAnswer: (a) => answers.push(a), onCancel: () => { cancelled++; } });
    session.answerQuestion('child:q1', { a: ['x'] });
    assert.deepStrictEqual<QuestionAnswers[]>(answers, [{ a: ['x'] }]);
    session.ingestNested({ ...question, id: 'child:q2' }, { onAnswer: (a) => answers.push(a), onCancel: () => { cancelled++; } });
    await session.interrupt();
    assert.strictEqual(cancelled, 1);
  });

  test('the tap sees directly handled and ingested events alike', () => {
    const seen: string[] = [];
    session.setTap((e) => seen.push(e.kind));
    openCard();
    assert.deepStrictEqual(seen, ['tool-start']);
    session.setTap(undefined);
    session.ingestNested({ kind: 'tool-start', id: 'c1', tool: READ, parentId: 'card' });
    assert.deepStrictEqual(seen, ['tool-start']);
  });
});
