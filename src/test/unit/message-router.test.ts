import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('MessageRouter', () => {
  let dir: string;
  let sent: HostToWebview[];
  let provider: FakeProvider;
  let manager: SessionManager;
  let router: MessageRouter;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-router-'));
    sent = [];
    provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
    router = new MessageRouter(manager, (m) => sent.push(m), '/tmp');
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('ready produces a hydrate carrying the catalog', async () => {
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.ok(hydrate);
    assert.strictEqual(hydrate.catalog.length, 1);
    assert.strictEqual(hydrate.catalog[0].id, 'fake');
    assert.deepStrictEqual(hydrate.sessions, []);
    assert.deepStrictEqual(hydrate.usage, {});
  });

  test('ready carries the manager\'s current usage snapshot on hydrate', async () => {
    await manager.create('fake', '/tmp');
    manager.usageWindows('fake', [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }]);
    await settle();

    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.deepStrictEqual(hydrate.usage, {
      fake: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
  });

  test('ready kicks off a usage refresh alongside the model refresh', async () => {
    await router.handle({ t: 'ready' });
    await settle();

    assert.deepStrictEqual(provider.fetchUsageCalls, ['/tmp']);
  });

  test('create-session then send drives a turn', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    sent.length = 0;

    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-patch' && m.id === id));
  });

  test('load-more emits session-prepend', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    for (let i = 0; i < 5; i++) {
      await router.handle({ t: 'send', id, text: `msg ${i}` });
      await settle();
    }
    const session = manager.get(id)!;
    const snap = await session.snapshot();
    sent.length = 0;

    await router.handle({ t: 'load-more', id, beforeItemId: snap.items[1].id });
    const prepend = sent.find((m) => m.t === 'session-prepend');
    assert.ok(prepend);
  });

  test('an unknown session id is ignored rather than thrown', async () => {
    await router.handle({ t: 'send', id: 'nope', text: 'hi' });
    await router.handle({ t: 'interrupt', id: 'nope' });
    assert.ok(true, 'no exception escaped the router');
  });

  test('cancel-queued drops the message a send parked mid-turn', async () => {
    // Its own provider: the suite's default script ends every turn on the
    // spot, so a session over it is never busy long enough to park anything.
    const silent = new FakeProvider();
    const quiet = new SessionManager(
      new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', silent]]),
      (m) => sent.push(m),
    );
    await quiet.init();
    const quietRouter = new MessageRouter(quiet, (m) => sent.push(m), '/tmp');
    await quietRouter.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = quiet.summaries()[0].id;

    await quietRouter.handle({ t: 'send', id, text: 'first' });
    await settle();
    await quietRouter.handle({ t: 'send', id, text: 'second' });
    await settle();
    assert.strictEqual(quiet.get(id)!.state.queued?.text, 'second');

    await quietRouter.handle({ t: 'cancel-queued', id });
    assert.strictEqual(quiet.get(id)!.state.queued, undefined);

    silent.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();
    assert.deepStrictEqual(silent.sent.map((s) => s.text), ['first']);
    await quiet.dispose();
  });

  test('cancel-queued for an unknown session id is ignored rather than thrown', async () => {
    await router.handle({ t: 'cancel-queued', id: 'nope' });
    assert.ok(true, 'no exception escaped the router');
  });

  test('create-session with an unknown providerId is ignored rather than thrown', async () => {
    await router.handle({ t: 'create-session', providerId: 'nope-provider', cwd: '/tmp' });
    assert.strictEqual(manager.summaries().length, 0);
    assert.ok(true, 'no exception escaped the router');
  });

  test('create-session carries the requested permission mode through to the session', async () => {
    await router.handle({
      t: 'create-session', providerId: 'fake', cwd: '/tmp', mode: 'acceptEdits',
    });
    assert.strictEqual(manager.summaries()[0].permissionMode, 'acceptEdits');
  });

  test('ready after a restart materializes and returns persisted session snapshots', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();
    await router.handle({
      t: 'set-layout',
      layout: { orientation: 'vertical', panes: [{ sessionId: id, size: 1 }] },
    });
    // Flush everything to disk and tear down the live session, simulating a
    // window/extension-host reload: index.json + transcript exist on disk,
    // but nothing is live in the new SessionManager's `live` map.
    await manager.dispose();

    const providers2 = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    const sent2: HostToWebview[] = [];
    const manager2 = new SessionManager(new TranscriptStore(dir), providers2, (m) => sent2.push(m));
    await manager2.init();
    const router2 = new MessageRouter(manager2, (m) => sent2.push(m), '/tmp');

    await router2.handle({ t: 'ready' });
    const hydrate = sent2.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.ok(hydrate);
    assert.strictEqual(hydrate.snapshots.length, 1);
    assert.ok(hydrate.snapshots[0].items.length > 0, 'restored snapshot should carry persisted items');

    await manager2.dispose();
  });

  test('ready does not revive a session the user explicitly closed', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();
    // close() archives the session but does NOT prune its pane from the
    // layout (only delete-session does) — the pane is still there on the
    // next `ready`, just pointing at an archived session.
    await router.handle({
      t: 'set-layout',
      layout: { orientation: 'vertical', panes: [{ sessionId: id, size: 1 }] },
    });
    await router.handle({ t: 'close-session', id });
    await manager.dispose();

    const providers2 = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    const sent2: HostToWebview[] = [];
    const manager2 = new SessionManager(new TranscriptStore(dir), providers2, (m) => sent2.push(m));
    await manager2.init();
    const router2 = new MessageRouter(manager2, (m) => sent2.push(m), '/tmp');

    await router2.handle({ t: 'ready' });

    assert.strictEqual(manager2.get(id), undefined, 'closed session must not be revived as live');
    const summary = manager2.summaries().find((s) => s.id === id);
    assert.ok(summary);
    assert.strictEqual(summary!.archived, true, 'closed session must remain archived');

    await manager2.dispose();
  });

  test('handle(null) resolves rather than throwing', async () => {
    await router.handle(null as never);
    assert.ok(true, 'no exception escaped the router');
  });

  test('a malformed set-layout does not brick subsequent ready calls', async () => {
    await router.handle({ t: 'set-layout', layout: undefined } as never);
    sent.length = 0;
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate');
    assert.ok(hydrate, 'ready should still hydrate after a malformed set-layout');
  });

  test('set-effort for a restored-but-not-live session lands in persisted state', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    // Simulate "restored but not live": archive+release without deleting.
    // Needs a transcript — close() discards an unused session outright.
    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();
    await manager.close(id);
    assert.strictEqual(manager.get(id), undefined, 'session must not be live before the mutation');

    await router.handle({ t: 'set-effort', id, effort: 'high' });

    const session = manager.get(id);
    assert.ok(session, 'set-effort should have revived the session');
    assert.strictEqual(session!.state.effort, 'high');
  });

  test('set-permission-mode for a restored-but-not-live session lands in persisted state', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();
    await manager.close(id);
    assert.strictEqual(manager.get(id), undefined, 'session must not be live before the mutation');

    await router.handle({ t: 'set-permission-mode', id, mode: 'bypass' });

    const session = manager.get(id);
    assert.ok(session, 'set-permission-mode should have revived the session');
    assert.strictEqual(session!.state.permissionMode, 'bypass');
  });

  test('set-model reaches the session', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });

    await router.handle({ t: 'set-model', id, model: 'fake-small' });

    const session = manager.get(id);
    assert.ok(session);
    assert.strictEqual((await session!.snapshot()).model, 'fake-small');
  });

  test('request-context replies with a keyed result', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    sent.length = 0;

    await router.handle({ t: 'request-context', id });

    const reply = sent.find((m) => m.t === 'context-breakdown') as
      Extract<HostToWebview, { t: 'context-breakdown' }>;
    assert.ok(reply);
    assert.strictEqual(reply.id, id);
    // The suite's FakeProvider scripts no reports, so this is the not-ok path.
    assert.strictEqual(reply.result.ok, false);
  });

  test('open-file is accepted but not acted on by the router', async () => {
    sent.length = 0;
    await router.handle({ t: 'open-file', id: 's1', path: '/repo/CLAUDE.md' });
    assert.deepStrictEqual(sent, []);
  });

  test('send attaches the tracked context when the session opts in', async () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const fake = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const providers = new Map<string, AgentProvider>([['fake', fake]]);
    const mgr = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await mgr.init();
    const r = new MessageRouter(mgr, (m) => sent.push(m), '/tmp', {
      current: () => ctx,
      reveal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: ctx });
    await mgr.dispose();
  });

  test('send attaches nothing when the session has opted out', async () => {
    const fake = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const providers = new Map<string, AgentProvider>([['fake', fake]]);
    const mgr = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await mgr.init();
    const r = new MessageRouter(mgr, (m) => sent.push(m), '/tmp', {
      current: () => ({ path: 'src/a.ts', languageId: 'typescript' }),
      reveal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'set-include-context', id: session.state.id, on: false });
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: undefined });
    assert.strictEqual(session.state.includeEditorContext, false);
    await mgr.dispose();
  });

  test('set-include-context persists across a session reload', async () => {
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }])],
    ]);
    const mgr = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await mgr.init();
    const r = new MessageRouter(mgr, (m) => sent.push(m), '/tmp');

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'set-include-context', id: session.state.id, on: false });
    assert.strictEqual(session.state.includeEditorContext, false);

    // The manager persists on a debounce; dispose() flushes it before
    // resolving, the same way "init restores sessions and layout from the
    // index" (session-manager.test.ts) forces a flush to observe a reload.
    await mgr.dispose();

    const reloaded = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await reloaded.init();
    assert.strictEqual(reloaded.summaries()[0].includeEditorContext, false);
    await reloaded.dispose();
  });

  test('reveal-file reaches the editor host', async () => {
    const calls: { path: string; startLine?: number }[] = [];
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => null,
      reveal: (path, startLine) => calls.push({ path, startLine }),
    });

    await r.handle({ t: 'reveal-file', path: 'src/a.ts', startLine: 12 });

    assert.deepStrictEqual(calls, [{ path: 'src/a.ts', startLine: 12 }]);
  });

  test('answer-relocation reaches the manager with the session, item and choice', async () => {
    const calls: [string, string, boolean][] = [];
    manager.relocate = async (id, itemId, move) => { calls.push([id, itemId, move]); };

    await router.handle({ t: 'answer-relocation', id: 's-1', itemId: 'r1', move: true });
    await router.handle({ t: 'answer-relocation', id: 's-1', itemId: 'r2', move: false });

    assert.deepStrictEqual(calls, [['s-1', 'r1', true], ['s-1', 'r2', false]]);
  });

  test('answer-relocation is not dropped as a malformed message', async () => {
    // The wire guard is a hand-maintained tag set, not the union: a new arm
    // that is added to `WebviewToHost` but not to KNOWN_MESSAGE_TAGS type-checks
    // everywhere and is silently discarded at runtime.
    let reached = false;
    manager.relocate = async () => { reached = true; };
    await router.handle({ t: 'answer-relocation', id: 's-1', itemId: 'r1', move: true });
    assert.strictEqual(reached, true);
  });

  test('both bring-back messages survive the wire guard and reach the manager', async () => {
    // Same trap as `answer-relocation` above, twice over: two new inbound arms
    // mean two new entries in KNOWN_MESSAGE_TAGS, and a missing one is dropped
    // at runtime while every type check still passes.
    const calls: string[] = [];
    manager.requestBringBack = async (id) => { calls.push(`ask:${id}`); };
    manager.bringBack = async (id) => { calls.push(`do:${id}`); };

    await router.handle({ t: 'request-bring-back', id: 's-1' });
    await router.handle({ t: 'bring-back', id: 's-1' });

    assert.deepStrictEqual(calls, ['ask:s-1', 'do:s-1']);
  });

  test('both stale-tree messages survive the wire guard and reach the manager', async () => {
    // Same trap again, and worse here: neither message carries a SessionId, so
    // a tag missing from KNOWN_MESSAGE_TAGS would leave the sweep silently
    // dead with nothing in any transcript to show for it.
    const calls: string[] = [];
    manager.requestStaleTrees = async () => { calls.push('ask'); };
    manager.removeStaleTree = async (path: string) => { calls.push(`remove:${path}`); };

    await router.handle({ t: 'request-stale-trees' });
    await router.handle({ t: 'remove-stale-tree', path: '/repo/trees/feat-x' });

    assert.deepStrictEqual(calls, ['ask', 'remove:/repo/trees/feat-x']);
  });

  test('a rejecting stale-tree removal is caught rather than becoming an unhandled rejection', async () => {
    manager.removeStaleTree = async () => { throw new Error('git exploded'); };
    await router.handle({ t: 'remove-stale-tree', path: '/repo/trees/feat-x' });
  });

  test('a rejecting bring-back is caught rather than becoming an unhandled rejection', async () => {
    // Awaited, not `void`ed: this one shells out to git and touches the
    // filesystem, where EPERM/EBUSY are routine on Windows.
    manager.bringBack = async () => { throw new Error('git exploded'); };
    await router.handle({ t: 'bring-back', id: 's-1' });
  });

  test('ready emits the current editor context', async () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => ctx,
      reveal: () => {},
    });

    await r.handle({ t: 'ready' });

    const msg = sent.find((m) => m.t === 'editor-context') as
      Extract<HostToWebview, { t: 'editor-context' }>;
    assert.ok(msg);
    assert.deepStrictEqual(msg.ctx, ctx);
  });

  test('send with a ref composes the payload into the prompt', async () => {
    const source = await manager.create('fake', dir);
    source.send('plan it');
    await settle();
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do @agent-1 message',
      refs: [{ sessionId: source.state.id, kind: 'message', title: 'agent-1' }],
    });
    await settle();

    const items = (await target.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text.includes('Do @agent-1 message'), true);
    assert.strictEqual(user?.role === 'user' && user.text.includes('--- message from agent-1 ---'), true);
    assert.strictEqual(user?.role === 'user' && user.refs?.length, 1);
  });

  test('send with an unresolvable ref sends nothing and records why', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do @ghost message',
      refs: [{ sessionId: 'nope', kind: 'message', title: 'ghost' }],
    });
    await settle();

    const items = (await target.snapshot()).items;
    assert.strictEqual(items.some((i) => i.role === 'user'), false);
    const error = items.find((i) => i.role === 'error');
    assert.strictEqual(error?.role === 'error' && error.message.includes('ghost'), true);
    assert.strictEqual(target.state.status, 'idle');
  });

  test('one missing ref reads in the singular', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do @ghost message',
      refs: [{ sessionId: 'nope', kind: 'message', title: 'ghost' }],
    });
    await settle();

    const items = (await target.snapshot()).items;
    const error = items.find((i) => i.role === 'error');
    assert.strictEqual(
      error?.role === 'error' && error.message,
      'Nothing to hand off from ghost (message). That session has not produced one yet.',
    );
  });

  test('several missing refs read in the plural', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do it',
      refs: [
        { sessionId: 'nope', kind: 'message', title: 'a' },
        { sessionId: 'nix', kind: 'plan', title: 'b' },
      ],
    });
    await settle();

    const items = (await target.snapshot()).items;
    const error = items.find((i) => i.role === 'error');
    assert.strictEqual(
      error?.role === 'error' && error.message,
      'Nothing to hand off from a (message), b (plan). '
      + 'Those sessions have not produced them yet.',
    );
  });

  test('two kinds missing from one session keep the subject singular', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do it',
      refs: [
        { sessionId: 'nope', kind: 'message', title: 'a' },
        { sessionId: 'nope', kind: 'plan', title: 'a' },
      ],
    });
    await settle();

    const items = (await target.snapshot()).items;
    const error = items.find((i) => i.role === 'error');
    assert.strictEqual(
      error?.role === 'error' && error.message,
      'Nothing to hand off from a (message), a (plan). '
      + 'That session has not produced them yet.',
    );
  });

  test('send without refs is unchanged', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({ t: 'send', id: target.state.id, text: 'plain' });
    await settle();

    const items = (await target.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text, 'plain');
    assert.strictEqual(user?.role === 'user' && user.refs, undefined);
  });

  test('create-session with a seed sends the composed first message', async () => {
    const source = await manager.create('fake', dir);
    source.send('plan it');
    await settle();

    await router.handle({
      t: 'create-session', providerId: 'fake', cwd: '',
      seed: {
        text: 'Execute @agent-1 message',
        refs: [{ sessionId: source.state.id, kind: 'message', title: 'agent-1' }],
      },
    });
    await settle();

    const created = manager.summaries().find((s) => s.id !== source.state.id);
    assert.strictEqual(created !== undefined, true);
    const items = (await manager.get(created!.id)!.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text.includes('--- message from agent-1 ---'), true);
  });

  test('create-session with an unresolvable seed still creates the session', async () => {
    await router.handle({
      t: 'create-session', providerId: 'fake', cwd: '',
      seed: {
        text: 'Execute @ghost message',
        refs: [{ sessionId: 'nope', kind: 'message', title: 'ghost' }],
      },
    });
    await settle();

    const created = manager.summaries()[0];
    const items = (await manager.get(created.id)!.snapshot()).items;
    assert.strictEqual(items.some((i) => i.role === 'user'), false);
    assert.strictEqual(items.some((i) => i.role === 'error'), true);
  });
});
