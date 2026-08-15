import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { AppServer } from '../../providers/codex/app-server';
import { CodexRun } from '../../providers/codex/codex-run';
import type { AgentEvent, StartOptions } from '../../providers/types';

/**
 * A stub child: no binary, no auth, no network. Duplicated from
 * codex-app-server.test.ts's `stub()` rather than shared — the tasks that
 * produced these two suites may land out of order, and a shared fixture
 * across them is not worth the coupling.
 */
function stub() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  let killed = false;
  const server = new AppServer({ stdin, stdout, kill: () => { killed = true; } });
  const send = (msg: unknown) => { stdout.write(`${JSON.stringify(msg)}\n`); };
  const sent = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { server, send, sent, killed: () => killed };
}

/** Lets a microtask chain (a `.then`, an `await` inside an async fn) settle. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Starts a `CodexRun`, answers its `thread/start` request and delivers the
 * `thread/started` notification that establishes the thread id — the two
 * things every test past the first three needs before it can exercise
 * anything thread-scoped. `AppServer`'s request ids are per-instance and
 * start at 1, and nothing else has talked to `server` yet, so the
 * `thread/start` request this triggers is deterministically id 1.
 */
async function started(
  server: AppServer, threadId: string, opts: Partial<StartOptions> = {},
): Promise<CodexRun> {
  const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'default', ...opts });
  run.send('hi');
  await tick();
  server.ingest(`${JSON.stringify({ id: 1, result: { threadId } })}\n`);
  server.ingest(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: threadId } } })}\n`);
  await tick();
  return run;
}

/** Drains `run.events` into an array in the background, for assertions. */
function collect(run: CodexRun): () => AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of run.events) { events.push(event); }
  })();
  return () => events;
}

suite('CodexRun', () => {
  test('the first send starts a thread with the mode settings', async () => {
    const { server, sent } = stub();
    const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'plan', model: 'gpt-5-codex' });
    run.send('hello');
    await tick();
    const start = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual(start.params.approvalPolicy, 'never');
    assert.strictEqual(start.params.sandbox, 'read-only');
    assert.strictEqual(start.params.approvalsReviewer, 'user');
    assert.strictEqual(start.params.cwd, '/repo');
  });

  test('a resume token resumes instead of starting', async () => {
    const { server, sent } = stub();
    const run = new CodexRun(server, {
      cwd: '/repo', permissionMode: 'default', resumeToken: 'th_old',
    });
    run.send('hi');
    await tick();
    assert.strictEqual(sent().some((f) => f.method === 'thread/resume'), true);
    assert.strictEqual(sent().some((f) => f.method === 'thread/start'), false);
  });

  test('auto routes approvals to the guardian', async () => {
    const { server, sent } = stub();
    new CodexRun(server, { cwd: '/repo', permissionMode: 'auto' }).send('hi');
    await tick();
    const start = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual(start.params.approvalsReviewer, 'auto_review');
  });

  test('only this thread\'s notifications reach this run', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_other', delta: 'no' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'yes' } });
    await tick();
    assert.deepStrictEqual(events().filter((e) => e.kind === 'text').map((e) => e.delta), ['yes']);
  });

  test('an approval decision answers the originating request', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({
      id: 42, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'th_1', command: 'rm -rf x', cwd: '/repo' },
    });
    await tick();
    run.respondToTool('42', { allow: true });
    assert.deepStrictEqual(sent().at(-1), { id: 42, result: { decision: 'approved' } });
  });

  test('a denial carries the reason as the rejection', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 43, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    run.respondToTool('43', { allow: false, reason: 'not this file' });
    assert.deepStrictEqual(sent().at(-1),
      { id: 43, result: { decision: { denied: { rejection: 'not this file' } } } });
  });

  test('an input request is declined rather than left hanging', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 44, method: 'item/tool/requestUserInput',
      params: { threadId: 'th_1', questions: [], isBlocking: true },
    });
    await tick();
    // Answered immediately: an unanswered blocking request hangs the turn.
    assert.strictEqual(sent().at(-1).id, 44);
    // And said so in the transcript, rather than failing silently.
    assert.strictEqual(events().some((e) => e.kind === 'tool-start'), true);
  });

  test('a mode change retargets the live thread', async () => {
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    run.setPermissionMode('bypass');
    await tick();
    const update = sent().at(-1);
    assert.strictEqual(update.params.approvalPolicy, 'never');
    assert.deepStrictEqual(update.params.sandboxPolicy, { type: 'dangerFullAccess' });
  });

  test('a failing setter does not reject at the caller', async () => {
    const { server } = stub();
    const run = await started(server, 'th_1');
    server.close('gone');
    // Fire-and-forget by design: callers must never see these reject.
    assert.doesNotThrow(() => { run.setPermissionMode('plan'); });
    assert.doesNotThrow(() => { run.setModel('other'); });
    assert.doesNotThrow(() => { run.setEffort('high'); });
  });

  test('the connection closing ends the turn with an error', async () => {
    const { server } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    server.close('app-server exited');
    await tick();
    const last = events().at(-1);
    assert.ok(last);
    assert.strictEqual(last.kind, 'turn-end');
    assert.strictEqual(last.kind === 'turn-end' && last.reason, 'error');
  });
});
