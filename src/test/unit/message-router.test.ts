import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { AttachmentStore } from '../../host/attachment-store';
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
  let attachments: AttachmentStore;

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
    attachments = new AttachmentStore(dir);
    router = new MessageRouter(manager, (m) => sent.push(m), '/tmp', undefined, attachments);
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

  test('hydrate says whether an empty catalog is still a pending question', async () => {
    // FakeProvider has no `fetchModels`, so nothing will be probed and the
    // catalog it hydrates with is already the final answer. Saying `probing`
    // here would leave the panel in "checking…" for the life of the window.
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.strictEqual(hydrate.probing, false);
  });

  test('refresh-catalog re-probes and announces a settled catalog', async () => {
    // Whatever the answer, the retry must produce one message saying the
    // question is closed — that emit is the only feedback the button has.
    await router.handle({ t: 'refresh-catalog' });

    const catalogs = sent.filter((m) => m.t === 'catalog') as
      Extract<HostToWebview, { t: 'catalog' }>[];
    assert.strictEqual(catalogs.length, 1);
    assert.strictEqual(catalogs[0].probing, false);
  });

  test('open-settings reaches the host with the section to reveal', async () => {
    const sections: string[] = [];
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => null,
      reveal: () => {},
      openDiff: () => {},
      openSettings: (section) => sections.push(section),
      openExternal: () => {},
    });

    await r.handle({ t: 'open-settings', section: 'hiiiidCode.enabledProviders' });

    assert.deepStrictEqual(sections, ['hiiiidCode.enabledProviders']);
  });

  test('open-external reaches the host with the url to open', async () => {
    const urls: string[] = [];
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => null,
      reveal: () => {},
      openDiff: () => {},
      openSettings: () => {},
      openExternal: (url) => urls.push(url),
    });

    await r.handle({ t: 'open-external', url: 'https://example.test/a' });

    assert.deepStrictEqual(urls, ['https://example.test/a']);
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

  test('attach-paste writes the file and emits the new pending set', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    sent.length = 0;

    await router.handle({
      t: 'attach-paste', id, name: 'shot.png', mediaType: 'image/png', base64: 'iVBORw==',
    });

    const session = manager.get(id)!;
    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'session-attachments' }>;
    assert.strictEqual(msg.t, 'session-attachments');
    assert.strictEqual(msg.id, id);
    assert.deepStrictEqual(msg.attachments.map((attachment) => attachment.name), ['shot.png']);
    assert.strictEqual(session.pendingAttachments.length, 1);
  });

  test('a clipboard image with no name of its own is numbered as it arrives', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;

    await router.handle({ t: 'attach-paste', id, mediaType: 'image/png', base64: 'iVBORw==' });
    await router.handle({ t: 'attach-paste', id, mediaType: 'image/png', base64: 'iVBORw==' });

    // Numbered against the pending set, so two screenshots are two names — a
    // shared fallback makes the chips' remove labels indistinguishable.
    assert.deepStrictEqual(
      manager.get(id)!.pendingAttachments.map((a) => a.name),
      ['Pasted image 1', 'Pasted image 2'],
    );
  });

  test('a paste that carries its own name keeps it', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;

    await router.handle({
      t: 'attach-paste', id, name: 'diagram.png', mediaType: 'image/png', base64: 'iVBORw==',
    });

    assert.deepStrictEqual(manager.get(id)!.pendingAttachments.map((a) => a.name), ['diagram.png']);
  });

  test('an oversized paste is rejected without touching the pending set', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    sent.length = 0;
    const huge = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');

    await router.handle({
      t: 'attach-paste', id, name: 'big.png', mediaType: 'image/png', base64: huge,
    });

    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'attachments-rejected' }>;
    assert.strictEqual(msg.t, 'attachments-rejected');
    assert.match(msg.reasons[0], /10 MB/);
    assert.strictEqual(manager.get(id)!.pendingAttachments.length, 0);
  });

  test('an eleventh pending attachment is rejected before paste storage', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const session = manager.get(id)!;
    session.addAttachments(Array.from({ length: 10 }, (_, index) => ({
      id: `a${index}`, path: `/tmp/${index}.txt`, name: `${index}.txt`, kind: 'file' as const, bytes: 1,
    })));
    sent.length = 0;

    await router.handle({
      t: 'attach-paste', id, name: 'extra.png', mediaType: 'image/png', base64: 'iVBORw==',
    });

    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'attachments-rejected' }>;
    assert.strictEqual(msg.t, 'attachments-rejected');
    assert.match(msg.reasons[0], /10 attachments/);
    assert.strictEqual(session.pendingAttachments.length, 10);
  });

  test('attach-drop adopts file uris and ignores non-file entries', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const real = path.join(dir, 'notes.md');
    await fs.writeFile(real, '# hi');
    sent.length = 0;

    await router.handle({
      t: 'attach-drop', id,
      uris: [pathToFileURL(real).href, 'https://example.com/x.png'],
    });

    const session = manager.get(id)!;
    assert.strictEqual(session.pendingAttachments.length, 1);
    assert.strictEqual(session.pendingAttachments[0].name, 'notes.md');
    assert.strictEqual((sent.at(-1) as HostToWebview).t, 'session-attachments');
  });

  test('a mixed drop names every file it refused, and why', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const good = path.join(dir, 'keep.md');
    const folder = path.join(dir, 'a-folder');
    await fs.writeFile(good, 'x');
    await fs.mkdir(folder, { recursive: true });
    sent.length = 0;

    await router.handle({
      t: 'attach-drop', id,
      uris: [pathToFileURL(good).href, pathToFileURL(folder).href],
    });

    assert.deepStrictEqual(manager.get(id)!.pendingAttachments.map((a) => a.name), ['keep.md']);
    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'attachments-rejected' }>;
    assert.strictEqual(msg.t, 'attachments-rejected');
    // One line per refused file, each naming the file and the constraint —
    // a batch count would name neither.
    assert.deepStrictEqual(msg.reasons, ['a-folder — that is a folder']);
  });

  test('a drop that is all folders still reports each one', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const one = path.join(dir, 'one');
    const two = path.join(dir, 'two');
    await fs.mkdir(one, { recursive: true });
    await fs.mkdir(two, { recursive: true });
    sent.length = 0;

    await router.handle({
      t: 'attach-drop', id, uris: [pathToFileURL(one).href, pathToFileURL(two).href],
    });

    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'attachments-rejected' }>;
    assert.strictEqual(msg.reasons.length, 2);
  });

  test('attach-failed reports a clipboard read the webview could not finish', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    sent.length = 0;

    await router.handle({ t: 'attach-failed', id, name: 'image.png' });

    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'attachments-rejected' }>;
    assert.strictEqual(msg.t, 'attachments-rejected');
    assert.deepStrictEqual(msg.reasons, ['image.png — could not be read']);
  });

  test('attach-pick adopts what the host dialog returned', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const real = path.join(dir, 'pick.md');
    await fs.writeFile(real, 'x');
    const pickerRouter = new MessageRouter(
      manager, (message) => sent.push(message), '/tmp', undefined, attachments,
      { pick: async () => [real] },
    );

    await pickerRouter.handle({ t: 'attach-pick', id });

    assert.deepStrictEqual(manager.get(id)!.pendingAttachments.map((attachment) => attachment.name), ['pick.md']);
  });

  test('attach-pick with a cancelled dialog emits nothing new', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    const pickerRouter = new MessageRouter(
      manager, (message) => sent.push(message), '/tmp', undefined, attachments,
      { pick: async () => [] },
    );
    const before = sent.length;

    await pickerRouter.handle({ t: 'attach-pick', id });

    assert.strictEqual(sent.length, before);
    assert.strictEqual(manager.get(id)!.pendingAttachments.length, 0);
  });

  test('attach-remove drops one attachment and emits the replacement set', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({
      t: 'attach-paste', id, name: 'shot.png', mediaType: 'image/png', base64: 'iVBORw==',
    });
    const attachmentId = manager.get(id)!.pendingAttachments[0].id;

    await router.handle({ t: 'attach-remove', id, attachmentId });

    assert.strictEqual(manager.get(id)!.pendingAttachments.length, 0);
    const msg = sent.at(-1) as Extract<HostToWebview, { t: 'session-attachments' }>;
    assert.strictEqual(msg.t, 'session-attachments');
    assert.strictEqual(msg.attachments.length, 0);
  });

  test('an attachment message for an unknown session is a no-op', async () => {
    await router.handle({ t: 'attach-remove', id: 'nope', attachmentId: 'x' });
    assert.strictEqual(manager.summaries().length, 0);
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

  test('question-answer reaches the addressed session', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });

    provider.runs[0].emit({
      kind: 'question', id: 'r1', blocking: true,
      questions: [{
        id: 'q1', header: 'H', question: 'Q?', multiSelect: false,
        allowOther: true, secret: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
    });
    await settle();

    await router.handle({ t: 'question-answer', id, requestId: 'r1', answers: { q1: ['A'] } });
    await settle();

    assert.deepStrictEqual(provider.answered, [['r1', { q1: ['A'] }]]);
    const session = manager.get(id);
    assert.ok(session);
    const snap = await session!.snapshot();
    assert.strictEqual((snap.items.at(-1) as { state: string }).state, 'answered');
    assert.strictEqual(snap.pendingQuestions.length, 0);
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

  test('open-review survives the wire guard as a deliberate no-op, same as open-file', async () => {
    // Same trap as `answer-relocation` above: a tag missing from
    // KNOWN_MESSAGE_TAGS is silently dropped as "malformed" at runtime while
    // every type check still passes. This router also backs `ReviewPanel`
    // directly, unlike `open-file`, which `PanelViewProvider` always
    // intercepts first — so a regression here is not latent the same way.
    sent.length = 0;
    await router.handle({ t: 'open-review' });
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
      openDiff: () => {},
      openSettings: () => {},
      openExternal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: ctx, attachments: undefined });
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
      openDiff: () => {},
      openSettings: () => {},
      openExternal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'set-include-context', id: session.state.id, on: false });
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: undefined, attachments: undefined });
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
      openDiff: () => {},
      openSettings: () => {},
      openExternal: () => {},
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
      openDiff: () => {},
      openSettings: () => {},
      openExternal: () => {},
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
