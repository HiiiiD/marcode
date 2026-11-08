import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

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

  async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-side-'));
    dirs.push(dir);
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    const manager = new SessionManager(
      new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {},
    );
    managers.push(manager);
    await manager.init();
    const parent = await manager.create('fake', '/repo', 'fake-small', undefined, 'bypass');
    parent.send('plan the feature');
    await settle();
    return { manager, parent, provider };
  }

  const errorsOf = async (s: { snapshot(): Promise<{ items: { role: string }[] }> }) =>
    (await s.snapshot()).items.filter((i) => i.role === 'error').length;

  test('a side chat of a bypass parent starts in plan and is hidden', async () => {
    const { manager, parent } = await setup();

    const side = await manager.startSideChat(parent.state.id);

    assert.strictEqual(side!.state.permissionMode, 'plan');
    assert.strictEqual(side!.state.kind, 'side');
    assert.strictEqual(side!.state.origin, 'side');
    assert.strictEqual(side!.state.parentId, parent.state.id);
    assert.strictEqual(side!.state.providerId, parent.state.providerId);
    assert.strictEqual(side!.state.model, parent.state.model);
    assert.strictEqual(side!.state.cwd, parent.state.cwd);
    assert.strictEqual(manager.summaries().some((s) => s.id === side!.state.id), false);
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

    assert.strictEqual(side!.state.permissionMode, 'plan');
    assert.strictEqual(provider.sent[provider.sent.length - 1].text.includes('plan the feature'), true);
  });
});
