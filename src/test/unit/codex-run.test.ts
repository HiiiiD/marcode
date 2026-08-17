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
 * Starts a `CodexRun` and answers its `thread/start` request with the shape
 * the real server sends — `{ thread: { id } }`, measured on codex-cli 0.147.0
 * — which is the one thing every test past the first three needs before it
 * can exercise anything thread-scoped. `AppServer`'s request ids are
 * per-instance and start at 1, and nothing else has talked to `server` yet, so
 * the `thread/start` request this triggers is deterministically id 1.
 *
 * No `thread/started` notification: `thread/start` does emit one, but
 * `thread/resume` does not, so a fixture that delivered it would let a run
 * that only works with it keep passing here — which is exactly the bug this
 * harness previously hid.
 */
async function started(
  server: AppServer, threadId: string, opts: Partial<StartOptions> = {},
): Promise<CodexRun> {
  const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'default', ...opts });
  run.send('hi');
  await tick();
  server.ingest(`${JSON.stringify({ id: 1, result: { thread: { id: threadId } } })}\n`);
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

  // The hang this suite was blind to. `thread/resume` answers with
  // `{ thread: { id } }` and emits NO `thread/started` notification (measured
  // on codex-cli 0.147.0) — so a run that took the id only from a
  // `threadId` field on the response, or only from that notification, never
  // learned its own thread, never sent `turn/start`, and never emitted a
  // single event. The session sat on "Working…" forever, with no error to
  // show for it.
  test('a resumed thread takes its id from the response and sends the turn', async () => {
    const { server, sent } = stub();
    const run = new CodexRun(server, {
      cwd: '/repo', permissionMode: 'default', resumeToken: 'th_old',
    });
    run.send('hi');
    await tick();
    server.ingest(`${JSON.stringify({ id: 1, result: { thread: { id: 'th_old' } } })}\n`);
    await tick();
    const turn = sent().find((f) => f.method === 'turn/start');
    assert.strictEqual(turn?.params.threadId, 'th_old');
    assert.strictEqual(run.threadId, 'th_old');
  });

  test('the start response alone carries the resume token', async () => {
    const { server } = stub();
    const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();
    server.ingest(`${JSON.stringify({ id: 1, result: { thread: { id: 'th_1' } } })}\n`);
    await tick();
    assert.deepStrictEqual(
      events().filter((e) => e.kind === 'session').map((e) => e.resumeToken), ['th_1'],
    );
  });

  // `thread/started` names its thread under `thread.id`, not `threadId`, so
  // the generic guard never matched it and the provider's fan-out handed
  // every live run every other session's start. Each one recorded the
  // stranger's id as its own resume token: two Codex sessions in one window
  // ended up pointing at a single thread, and the loser resumed a
  // conversation it had never had.
  test('another thread\'s start does not retarget this run\'s resume token', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ method: 'thread/started', params: { thread: { id: 'th_other' } } });
    await tick();
    // Its own token, from its own start response, and nothing else.
    assert.deepStrictEqual(
      events().filter((e) => e.kind === 'session').map((e) => e.resumeToken), ['th_1'],
    );
    assert.strictEqual(run.threadId, 'th_1');
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

  // The exact bytes of an approval answer, which is what the earlier version
  // of this suite never checked: it asserted `{decision:'approved'}` — the
  // legacy v1 `ReviewDecision` — and passed, because the stub on the other
  // side was ours too. Measured on a live codex-cli 0.147.0:
  // `{decision:'approved'}` left the command unrun and the agent reported
  // that its "required approval mechanism failed"; `{decision:'accept'}` ran
  // it. `accept`/`decline` are the v2 enums' members.
  test('a command approval is accepted with the v2 decision, not the v1 one', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({
      id: 42, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'th_1', command: 'rm -rf x', cwd: '/repo' },
    });
    await tick();
    run.respondToTool('42', { allow: true });
    assert.deepStrictEqual(sent().at(-1), { id: 42, result: { decision: 'accept' } });
  });

  test('a fileChange denial answers decline, with no v1 rejection envelope', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 43, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    // The reason has nowhere to go: no v2 decision carries free text. It
    // stays in the transcript rather than being smuggled into a shape the
    // server would refuse.
    run.respondToTool('43', { allow: false, reason: 'not this file' });
    assert.deepStrictEqual(sent().at(-1), { id: 43, result: { decision: 'decline' } });
  });

  test('a fileChange approval accepts', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 45, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    run.respondToTool('45', { allow: true });
    assert.deepStrictEqual(sent().at(-1), { id: 45, result: { decision: 'accept' } });
  });

  test('a permissions request is answered with an empty, turn-scoped grant', async () => {
    // `PermissionsRequestApprovalResponse` has NO decision field — it asks
    // which permissions to grant, not yes/no. An empty profile at the
    // narrower scope is the only refusal the type can express, and it is
    // what both answers send, since a ToolDecision carries no permission set
    // to grant with.
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 46, method: 'item/permissions/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    run.respondToTool('46', { allow: false });
    assert.deepStrictEqual(sent().at(-1),
      { id: 46, result: { permissions: {}, scope: 'turn' } });
  });

  test('disposing declines every parked approval in its own response shape', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 47, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    // Not awaited: dispose() also fires `thread/unsubscribe` and waits on a
    // reply this stub never sends. The denials go out before that.
    void run.dispose();
    await tick();
    // Not `{denied:{rejection:'Session closed'}}`: that is the v1 shape, it
    // fails to deserialize, and the request stays parked — the exact hang
    // this denial exists to prevent.
    const reply = sent().find((f) => f.id === 47 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result, { decision: 'decline' });
  });

  test('a requestUserInput becomes a question event, not a decline', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 44, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true,
        questions: [{
          id: 'q1', header: 'Scope', question: 'Which one?',
          isOther: true, isSecret: false,
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
        }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.strictEqual(q.blocking, true);
    assert.strictEqual(q.questions[0].id, 'q1');
    assert.strictEqual(q.questions[0].allowOther, true);
    assert.strictEqual(q.questions[0].secret, false);
    // Nothing is answered yet — the request stays parked.
    assert.strictEqual(sent().some((f) => f.id === 44), false);
  });

  test('respondToQuestion answers the parked request in codex shape', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 44, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true,
        questions: [{ id: 'q1', header: 'H', question: 'Q?', isOther: false, isSecret: false,
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    run.respondToQuestion(q!.id, { q1: ['A', 'B'] });
    await tick();

    assert.deepStrictEqual(sent().at(-1),
      { id: 44, result: { answers: { q1: { answers: ['A', 'B'] } } } });
  });

  test('a question with null options maps to a free-text question', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 45, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: false,
        questions: [{ id: 'q1', header: 'H', question: 'Name?', isOther: true, isSecret: true, options: null }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.strictEqual(q.blocking, false);
    assert.strictEqual(q.questions[0].options === undefined, true);
    assert.strictEqual(q.questions[0].secret, true);
  });

  test('malformed requestUserInput params answer the request instead of throwing', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    // No `questions` at all. Mapping this used to throw straight out of the
    // stdout data handler: an uncaught exception in the extension host, the
    // rest of the chunk dropped, and a blocking request left unanswered with
    // no card to answer it.
    send({
      id: 49, method: 'item/tool/requestUserInput',
      params: { threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true },
    });
    await tick();

    assert.strictEqual(events().some((e) => e.kind === 'question'), false);
    assert.deepStrictEqual(sent().find((f) => f.id === 49)?.result, { answers: {} });
    const end = events().find((e) => e.kind === 'tool-end');
    assert.strictEqual(end?.kind === 'tool-end' && end.ok, false);
  });

  test('a question entry that is not an object degrades the same way', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 50, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true,
        questions: ['just a string'],
      },
    });
    await tick();

    assert.strictEqual(events().some((e) => e.kind === 'question'), false);
    assert.deepStrictEqual(sent().find((f) => f.id === 50)?.result, { answers: {} });
  });

  test('interrupt settles every parked request, approvals included', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 51, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' },
    });
    send({
      id: 52, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_2', isBlocking: true,
        questions: [{ id: 'q1', header: 'H', question: 'Q?', isOther: false, isSecret: false, options: null }],
      },
    });
    await tick();
    const parked = events().filter((e) => e.kind === 'permission' || e.kind === 'question');
    assert.strictEqual(parked.length, 2, 'both must actually be parked first');

    void run.interrupt();
    await tick();
    // `interrupt()` awaits `turn/interrupt` before settling anything, and the
    // stub answers nothing on its own.
    const rpc = sent().find((f) => f.method === 'turn/interrupt');
    server.ingest(`${JSON.stringify({ id: rpc.id, result: {} })}\n`);
    await tick();

    // Every parked request has a reply frame. Without the approval half, the
    // card stays `pending`, the host pins the session at `awaiting-approval`
    // for a turn that no longer exists, and a later Allow answers a request
    // codex has already abandoned.
    for (const id of [51, 52]) {
      assert.strictEqual(
        sent().some((f) => f.id === id && f.result !== undefined), true,
        `request ${id} was left unanswered by interrupt()`,
      );
    }
    const cancelled = events().filter((e) => e.kind === 'request-cancelled').map((e) => e.id);
    assert.deepStrictEqual(cancelled.sort(), ['51', '52']);
  });

  test('an MCP elicitation is still declined with an action', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    collect(run);
    send({ id: 48, method: 'mcpServer/elicitation/request', params: { threadId: 'th_1' } });
    await tick();
    assert.deepStrictEqual(sent().at(-1),
      { id: 48, result: { action: 'decline', content: null, _meta: null } });
  });

  test('a mode change retargets the live thread on its next turn', async () => {
    // Codex has no in-place patch for a thread's settings — the live
    // override primitive is the next `turn/start`, which is what this
    // asserts against rather than a `thread/metadata/update` frame (that
    // request carries only `threadId`/`gitInfo` and cannot express a mode).
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    run.setPermissionMode('bypass');
    run.send('again');
    await tick();
    const turn = sent().filter((f) => f.method === 'turn/start').at(-1);
    assert.strictEqual(turn.params.approvalPolicy, 'never');
    assert.deepStrictEqual(turn.params.sandboxPolicy, { type: 'dangerFullAccess' });
  });

  test('a model change reaches the next turn/start', async () => {
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    run.setModel('gpt-5.6-sol');
    run.send('again');
    await tick();
    const turn = sent().filter((f) => f.method === 'turn/start').at(-1);
    assert.strictEqual(turn.params.model, 'gpt-5.6-sol');
  });

  test('an effort change reaches the next turn/start', async () => {
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    run.setEffort('xhigh');
    run.send('again');
    await tick();
    const turn = sent().filter((f) => f.method === 'turn/start').at(-1);
    assert.strictEqual(turn.params.effort, 'xhigh');
  });

  test('an account-global notification reaches a started run', async () => {
    // account/rateLimits/updated carries no threadId at all — it must pass
    // the thread filter regardless of whether this run has started, since it
    // is the only trigger for a live mid-session usage pull.
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ method: 'account/rateLimits/updated', params: {} });
    await tick();
    assert.strictEqual(events().some((e) => e.kind === 'usage-stale'), true);
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

  test('thread/start carries no effort field', async () => {
    // Neither ThreadStartParams nor ThreadResumeParams declares one. serde
    // ignores unknown fields, so sending it was inert — which is why it had
    // to go rather than stay: a field that looks like it works and does
    // nothing is the thing a future reader trusts. Effort reaches the model
    // on turn/start, which does declare it (asserted above).
    const { server, sent } = stub();
    new CodexRun(server, { cwd: '/repo', permissionMode: 'default', effort: 'high' }).send('hi');
    await tick();
    const start = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual('effort' in start.params, false);
  });

  test('usageWindows sends unit params and reads the nested snapshot', async () => {
    // Two bugs in one call, both invisible to a name-only check: `{ cwd }`
    // is a hard protocol error against a `params: undefined` request, and
    // the snapshot is nested under `rateLimits` — typing the response as a
    // bare RateLimitSnapshot found no primary/secondary and returned [].
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    const pending = run.usageWindows();
    await tick();
    const req = sent().find((f) => f.method === 'account/rateLimits/read');
    assert.deepStrictEqual(req.params, {});
    // The full GetAccountRateLimitsResponse, extra buckets included.
    server.ingest(`${JSON.stringify({
      id: req.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
          secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: null },
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
    })}\n`);
    assert.deepStrictEqual((await pending)?.map((w) => w.usedPercent), [12, 63]);
  });

  test('usageWindows goes quiet once the connection is gone, rather than respawning', async () => {
    // setBinPath tears the shared process down without disposing its runs.
    // An ungated request here goes through ThreadView.request, which spawns
    // a FRESH process and drives it with a dead thread's id.
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    const before = sent().length;
    server.close('binary changed');
    assert.strictEqual(await run.usageWindows(), undefined);
    assert.strictEqual(sent().length, before);
  });

  test('MCP startup statuses accumulate into a full roster', async () => {
    // The notification is one server at a time; the mcp-servers event is a
    // full-replacement list that AgentSession assigns wholesale. Emitting a
    // single-element list per notification would leave the strip showing
    // only whichever server reported last.
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'th_1', name: 'github', status: 'starting', error: null, failureReason: null },
    });
    send({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'th_1', name: 'linear', status: 'failed', error: 'boom', failureReason: null },
    });
    send({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'th_1', name: 'github', status: 'ready', error: null, failureReason: null },
    });
    await tick();
    const last = events().filter((e) => e.kind === 'mcp-servers').at(-1);
    assert.deepStrictEqual(last?.kind === 'mcp-servers' && last.servers, [
      { name: 'github', state: 'connected' },
      { name: 'linear', state: 'failed', error: 'boom' },
    ]);
  });

  test('a reauthentication failure reads as needs-auth, not a broken server', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'th_1', name: 'github', status: 'failed',
        error: 'token expired', failureReason: 'reauthenticationRequired',
      },
    });
    await tick();
    const last = events().filter((e) => e.kind === 'mcp-servers').at(-1);
    assert.strictEqual(last?.kind === 'mcp-servers' && last.servers[0].state, 'needs-auth');
  });

  test('skills/changed re-pulls the catalog and emits the new invocables', async () => {
    // The notification is `Record<string, never>` — an invalidation signal
    // carrying no payload, so no pure mapper can answer it. The list has to
    // be pulled.
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ method: 'skills/changed', params: {} });
    await tick();
    const req = sent().find((f) => f.method === 'skills/list');
    assert.deepStrictEqual(req.params, { cwds: ['/repo'] });
    server.ingest(`${JSON.stringify({
      id: req.id,
      result: {
        data: [{
          cwd: '/repo',
          skills: [
            { name: 'plan', shortDescription: 'Plan', description: 'Plan it', path: '/p', scope: 'project', enabled: true },
            { name: 'off', description: 'Retired', path: '/o', scope: 'project', enabled: false },
          ],
          errors: [],
        }],
      },
    })}\n`);
    await tick();
    const last = events().filter((e) => e.kind === 'invocables').at(-1);
    assert.deepStrictEqual(last?.kind === 'invocables' && last.entries,
      [{ name: 'plan', description: 'Plan', origin: 'project' }]);
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
