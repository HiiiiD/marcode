import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { HostToWebview } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager lineage', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function boot(dir?: string, sent: HostToWebview[] = []) {
    const d = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'mar-lineage-'));
    if (!dir) { dirs.push(d); }
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    const manager = new SessionManager(
      new TranscriptStore(d), new Map<string, AgentProvider>([['fake', provider]]), (m) => sent.push(m),
    );
    managers.push(manager);
    await manager.init();
    return { manager, dir: d };
  }

  const has = (m: SessionManager, id: string) => m.summaries({ includeSubagents: true }).some((x) => x.id === id);

  const makeSide = (m: SessionManager, parentId: string) =>
    m.create('fake', '/repo', undefined, undefined, 'default', undefined, true, parentId, 'side');

  test('a side session is absent from summaries and present with includeSubagents', async () => {
    const { manager } = await boot();
    const parent = await manager.create('fake', '/repo');
    const side = await makeSide(manager, parent.state.id);

    assert.strictEqual(manager.summaries().some((s) => s.id === side.state.id), false);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).some((s) => s.id === side.state.id), true);
  });

  test('fork records its parent and origin', async () => {
    const { manager } = await boot();
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const itemId = (await parent.snapshot()).items[0].id;

    const forked = await manager.fork(parent.state.id, itemId);

    assert.strictEqual(forked!.state.parentId, parent.state.id);
    assert.strictEqual(forked!.state.origin, 'fork');
    assert.strictEqual(forked!.state.kind, undefined);
  });

  test('removing the parent removes its side sessions but keeps its forks', async () => {
    const { manager } = await boot();
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const itemId = (await parent.snapshot()).items[0].id;
    const forked = await manager.fork(parent.state.id, itemId);
    const side = await makeSide(manager, parent.state.id);

    await manager.remove(parent.state.id);

    assert.strictEqual(has(manager, side.state.id), false);
    assert.strictEqual(has(manager, forked!.state.id), true);
  });

  test('startup sweeps a side session whose parent is gone and keeps an orphaned fork', async () => {
    const first = await boot();
    const parent = await first.manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const itemId = (await parent.snapshot()).items[0].id;
    const forked = await first.manager.fork(parent.state.id, itemId);
    const side = await makeSide(first.manager, parent.state.id);
    side.send('q');
    await settle();
    const ids = { parent: parent.state.id, side: side.state.id, fork: forked!.state.id };
    await first.manager.dispose();
    managers.pop();
    // Drop only the parent row, leaving its children behind as a crash mid-delete would.
    const indexPath = path.join(first.dir, 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as { sessions: { id: string }[] };
    index.sessions = index.sessions.filter((s) => s.id !== ids.parent);
    await fs.writeFile(indexPath, JSON.stringify(index));

    const second = await boot(first.dir);

    assert.strictEqual(has(second.manager, ids.side), false);
    assert.strictEqual(has(second.manager, ids.fork), true);
  });

  test('a side session never gets a stored summary', async () => {
    const { manager } = await boot();
    const parent = await manager.create('fake', '/repo');
    const side = await makeSide(manager, parent.state.id);
    side.send('a question');
    await settle();

    await manager.ensureSummaries();

    assert.strictEqual(manager.summaries({ includeSubagents: true }).find((s) => s.id === side.state.id)?.summary === undefined, true);
  });

  const lastRoster = (sent: HostToWebview[]) =>
    [...sent].reverse().find((m): m is Extract<HostToWebview, { t: 'sessions-changed' }> => m.t === 'sessions-changed')!.sessions;

  test('a parent lists its forks and side chats as children, newest first', async () => {
    const sent: HostToWebview[] = [];
    const { manager } = await boot(undefined, sent);
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const itemId = (await parent.snapshot()).items[0].id;
    const forked = await manager.fork(parent.state.id, itemId);
    const hidden = await makeSide(manager, parent.state.id);
    hidden.state.origin = 'side';
    const promoted = await makeSide(manager, parent.state.id);
    promoted.state.origin = 'side';
    await manager.promoteSideChat(promoted.state.id);

    const children = manager.summaries().find((x) => x.id === parent.state.id)!.children!;

    assert.deepStrictEqual(
      children.map((c) => [c.id, c.origin, c.hidden]).sort(),
      [
        [forked!.state.id, 'fork', false],
        [hidden.state.id, 'side', true],
        [promoted.state.id, 'side', false],
      ].sort(),
    );
    assert.strictEqual(children.every((c) => c.title.length > 0 && c.status === 'idle'), true);
    assert.strictEqual(manager.summaries().find((x) => x.id === forked!.state.id)?.children, undefined);
  });

  test('a child that starts working re-sends its parent with the new status', async () => {
    const sent: HostToWebview[] = [];
    const { manager } = await boot(undefined, sent);
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const side = await manager.startSideChat(parent.state.id, 'q');
    await settle();

    side!.send('again');

    const child = lastRoster(sent).find((x) => x.id === parent.state.id)!.children!.find((c) => c.id === side!.state.id)!;
    assert.strictEqual(child.status, 'running');
  });

  test('removing a child takes it off the parent list', async () => {
    const sent: HostToWebview[] = [];
    const { manager } = await boot(undefined, sent);
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const itemId = (await parent.snapshot()).items[0].id;
    const forked = await manager.fork(parent.state.id, itemId);

    await manager.remove(forked!.state.id);

    assert.strictEqual(lastRoster(sent).find((x) => x.id === parent.state.id)?.children, undefined);
  });

  test('a side chat shown in a pane gets its own summary and stays out of the roster', async () => {
    const sent: HostToWebview[] = [];
    const { manager } = await boot(undefined, sent);
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const side = await manager.startSideChat(parent.state.id, 'q');
    await settle();
    sent.length = 0;

    side!.setPermissionMode('acceptEdits');

    const summaries = sent.filter((m): m is Extract<HostToWebview, { t: 'side-summary' }> => m.t === 'side-summary');
    assert.strictEqual(summaries[summaries.length - 1].session.permissionMode, 'acceptEdits');
    assert.strictEqual(lastRoster(sent).some((x) => x.id === side!.state.id), false);
  });

  test('a closed side chat gets no summary message', async () => {
    const sent: HostToWebview[] = [];
    const { manager } = await boot(undefined, sent);
    const parent = await manager.create('fake', '/repo');
    parent.send('first');
    await settle();
    const side = await manager.startSideChat(parent.state.id, 'q');
    await settle();
    await manager.closeSideChat(side!.state.id);
    sent.length = 0;

    parent.send('more');
    await settle();

    assert.strictEqual(sent.some((m) => m.t === 'side-summary'), false);
  });
});
