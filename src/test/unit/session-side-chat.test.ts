import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import { SIDE_CHAT_HEADER } from '../../host/side-chat-digest';
import { leafSessionIds } from '../../webview/components/layout-tree';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager.startSideChat', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function setup(existingDir?: string) {
    const dir = existingDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'mar-side-'));
    if (!existingDir) { dirs.push(dir); }
    const provider = new FakeProvider((text) => text === 'keep working' ? [] : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    const manager = new SessionManager(
      new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {},
    );
    managers.push(manager);
    await manager.init();
    if (existingDir) { return { manager, parent: undefined as never, provider, dir }; }
    const parent = await manager.create('fake', '/repo', 'fake-small', undefined, 'bypass');
    parent.send('plan the feature');
    await settle();
    return { manager, parent, provider, dir };
  }

  const row = (m: SessionManager, id: string) => m.summaries({ includeSubagents: true }).find((x) => x.id === id);
  const inLayout = (m: SessionManager, id: string) => leafSessionIds(m.layout().root).includes(id);

  const errorsOf = async (s: { snapshot(): Promise<{ items: { role: string }[] }> }) =>
    (await s.snapshot()).items.filter((i) => i.role === 'error').length;

  test('a side chat inherits bypass permissions from its parent and is hidden', async () => {
    const { manager, parent } = await setup();

    const side = await manager.startSideChat(parent.state.id);

    assert.strictEqual(side!.state.permissionMode, 'bypass');
    assert.strictEqual(side!.state.kind, 'side');
    assert.strictEqual(side!.state.origin, 'side');
    assert.strictEqual(side!.state.parentId, parent.state.id);
    assert.strictEqual(side!.state.providerId, parent.state.providerId);
    assert.strictEqual(side!.state.model, parent.state.model);
    assert.strictEqual(side!.state.cwd, parent.state.cwd);
    assert.strictEqual(manager.summaries().some((s) => s.id === side!.state.id), false);
  });

  test('each parent permission mode reaches the side chat provider unchanged', async () => {
    const { manager, provider } = await setup();
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypass'] as const) {
      const parent = await manager.create('fake', '/repo', 'fake-small', undefined, mode);
      parent.send('hello');
      await settle();

      const side = await manager.startSideChat(parent.state.id, 'why?');
      await settle();

      assert.strictEqual(side!.state.permissionMode, mode);
      assert.strictEqual(provider.lastStart!.permissionMode, mode);
      assert.strictEqual(parent.state.permissionMode, mode);
      await manager.closeSideChat(side!.state.id);
    }
  });

  test('the side chat is shown in a pane', async () => {
    const { manager, parent } = await setup();

    const side = await manager.startSideChat(parent.state.id);

    assert.strictEqual(manager.visibleIds().includes(side!.state.id), true);
  });

  test('the side chat carries the parent transcript and the parent is untouched', async () => {
    const { manager, parent } = await setup();
    const before = (await parent.snapshot()).items.length;

    const side = await manager.startSideChat(parent.state.id);

    assert.strictEqual((await side!.snapshot()).items.length, before);
    assert.strictEqual((await parent.snapshot()).items.length, before);
  });

  test('a question given at the start is sent as the first message', async () => {
    const { manager, parent, provider } = await setup();

    const side = await manager.startSideChat(parent.state.id, 'why a clamp?');
    await settle();

    const last = provider.sent[provider.sent.length - 1].text;
    assert.strictEqual(last.includes('why a clamp?'), true);
    assert.strictEqual((await side!.snapshot()).items.some((i) => i.role === 'user' && i.text === 'why a clamp?'), true);
  });

  test('a side chat cannot start another side chat', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id);

    const nested = await manager.startSideChat(side!.state.id);

    assert.strictEqual(nested, undefined);
    assert.strictEqual(await errorsOf(side!), 1);
  });

  test('an empty transcript has nothing to branch from', async () => {
    const { manager } = await setup();
    const empty = await manager.create('fake', '/repo');

    const side = await manager.startSideChat(empty.state.id);

    assert.strictEqual(side, undefined);
    assert.strictEqual(await errorsOf(empty), 1);
  });

  test('a busy parent still gets a side chat carrying the running turn', async () => {
    const { manager, parent, provider } = await setup();
    parent.state.status = 'running';

    const side = await manager.startSideChat(parent.state.id, 'status?');
    await settle();

    assert.strictEqual(side!.state.permissionMode, 'bypass');
    assert.strictEqual(provider.sent[provider.sent.length - 1].text.includes('plan the feature'), true);
  });

  test('closing an unused side chat deletes it', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id);

    await manager.closeSideChat(side!.state.id);

    assert.strictEqual(row(manager, side!.state.id), undefined);
    assert.strictEqual(inLayout(manager, side!.state.id), false);
  });

  test('closing a used side chat keeps it hidden and out of the layout', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();

    await manager.closeSideChat(side!.state.id);

    assert.strictEqual(row(manager, side!.state.id)?.kind, 'side');
    assert.strictEqual(inLayout(manager, side!.state.id), false);
    assert.strictEqual(manager.get(side!.state.id), undefined);
    assert.strictEqual(manager.summaries().some((x) => x.id === side!.state.id), false);
  });

  test('a closed used side chat can be reopened', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();
    await manager.closeSideChat(side!.state.id);

    await manager.setVisible([...leafSessionIds(manager.layout().root), side!.state.id]);

    assert.strictEqual(manager.visibleIds().includes(side!.state.id), true);
  });

  test('promoting makes a normal roster session and keeps its lineage and mode', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();

    await manager.promoteSideChat(side!.state.id);

    const promoted = row(manager, side!.state.id)!;
    assert.strictEqual(promoted.kind, undefined);
    assert.strictEqual(promoted.parentId, parent.state.id);
    assert.strictEqual(promoted.origin, 'side');
    assert.strictEqual(promoted.permissionMode, 'bypass');
    assert.strictEqual(manager.summaries().some((x) => x.id === side!.state.id), true);
    assert.strictEqual(inLayout(manager, side!.state.id), true);
  });

  test('close and promote leave an ordinary session alone', async () => {
    const { manager, parent } = await setup();

    await manager.closeSideChat(parent.state.id);
    await manager.promoteSideChat(parent.state.id);

    assert.strictEqual(manager.summaries().some((x) => x.id === parent.state.id), true);
    assert.strictEqual(manager.get(parent.state.id) !== undefined, true);
  });

  test('deleting the parent closes the pane of its open side chat', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');

    await manager.remove(parent.state.id);

    assert.strictEqual(row(manager, side!.state.id), undefined);
    assert.strictEqual(inLayout(manager, side!.state.id), false);
  });

  test('after a reload a used side chat survives hidden and an unused one is gone', async () => {
    const first = await setup();
    const used = await first.manager.startSideChat(first.parent.state.id, 'why?');
    await settle();
    const unused = await first.manager.startSideChat(first.parent.state.id);
    const ids = { used: used!.state.id, unused: unused!.state.id };
    await first.manager.dispose();
    managers.pop();

    const second = await setup(first.dir);

    assert.strictEqual(row(second.manager, ids.used)?.kind, 'side');
    assert.strictEqual(inLayout(second.manager, ids.used), false);
    assert.strictEqual(row(second.manager, ids.unused), undefined);
  });

  test('bringing back queues the side chat for the next parent message only', async () => {
    const { manager, parent, provider } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why a clamp?');
    await settle();

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(parent.pendingSeedText?.includes(SIDE_CHAT_HEADER), true);
    assert.strictEqual(parent.pendingSeedText?.includes('USER: why a clamp?'), true);
    parent.send('thanks');
    await settle();
    const delivered = provider.sent[provider.sent.length - 1].text;
    assert.strictEqual(delivered.includes(SIDE_CHAT_HEADER) && delivered.includes('thanks'), true);
    const users = (await parent.snapshot()).items.filter((i) => i.role === 'user');
    assert.strictEqual(users[users.length - 1].role === 'user' && users[users.length - 1].text, 'thanks');
    assert.strictEqual(parent.pendingSeedText, undefined);
  });

  test('bringing back leaves the side chat open and promotable', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(manager.visibleIds().includes(side!.state.id), true);
    assert.strictEqual(row(manager, side!.state.id)?.kind, 'side');
  });

  test('bringing back while the parent is working queues the digest for its next message', async () => {
    const { manager, parent, provider } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();
    parent.send('keep working');
    await settle();
    const sentBeforeMerge = provider.sent.length;

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(parent.pendingSeedText?.includes('USER: why?'), true);
    assert.strictEqual(await errorsOf(side!), 0);
    assert.strictEqual(parent.state.status, 'running');
    assert.strictEqual(provider.sent.length, sentBeforeMerge);
    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();
    assert.strictEqual(parent.state.status, 'idle');
    assert.strictEqual(parent.pendingSeedText?.includes(SIDE_CHAT_HEADER), true);
    parent.send('use that answer');
    await settle();
    assert.strictEqual(provider.sent.at(-1)!.text.includes(SIDE_CHAT_HEADER), true);
    assert.strictEqual(parent.pendingSeedText, undefined);
  });

  test('a second bring back before the parent speaks is refused and changes nothing', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();
    await manager.mergeSideChat(side!.state.id);
    const queued = parent.pendingSeedText;

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(parent.pendingSeedText, queued);
    assert.strictEqual(await errorsOf(side!), 1);
  });

  test('a side chat nobody has spoken in has nothing to bring back', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id);

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(parent.pendingSeedText, undefined);
    assert.strictEqual(await errorsOf(side!), 1);
  });

  test('a promoted side chat whose parent was deleted cannot be brought back', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();
    await manager.promoteSideChat(side!.state.id);
    await manager.remove(parent.state.id);

    await manager.mergeSideChat(side!.state.id);

    assert.strictEqual(await errorsOf(side!), 1);
  });

  test('closing the pane of an unused side chat by any route deletes it', async () => {
    const { manager, parent } = await setup();
    const viaClose = await manager.startSideChat(parent.state.id);
    await manager.close(viaClose!.state.id);
    const viaSplit = await manager.startSideChat(parent.state.id);
    await manager.setVisible([]);

    assert.strictEqual(row(manager, viaClose!.state.id), undefined);
    assert.strictEqual(row(manager, viaSplit!.state.id), undefined);
  });

  test('hiding a used side chat from the split keeps it', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();

    await manager.setVisible([]);

    assert.strictEqual(row(manager, side!.state.id)?.kind, 'side');
  });

  test('a side chat cannot be forked until it is promoted', async () => {
    const { manager, parent } = await setup();
    const side = await manager.startSideChat(parent.state.id, 'why?');
    await settle();
    const itemId = (await side!.snapshot()).items[0].id;

    const refused = await manager.fork(side!.state.id, itemId);

    assert.strictEqual(refused, undefined);
    assert.strictEqual(await errorsOf(side!), 1);
    await manager.promoteSideChat(side!.state.id);
    const forked = await manager.fork(side!.state.id, itemId);
    assert.strictEqual(forked?.state.parentId, side!.state.id);
  });

  test('file mentions given with the question reach the first message', async () => {
    const { manager, parent } = await setup();
    const fileRefs = [{ path: 'src/app.ts', name: 'app.ts' }];

    const side = await manager.startSideChat(parent.state.id, 'look at @src/app.ts', fileRefs);
    await settle();

    const user = (await side!.snapshot()).items.find((i) => i.role === 'user' && i.text.startsWith('look at'));
    assert.deepStrictEqual(user?.role === 'user' && user.fileRefs, fileRefs);
  });
});
