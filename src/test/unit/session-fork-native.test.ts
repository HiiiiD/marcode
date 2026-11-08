import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import { threadKey } from '../../shared/thread-key';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SEED_MARK = 'before it moved to this directory';

suite('SessionManager.fork native thread fork', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function setup(timeoutMs?: number) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-fork-native-'));
    dirs.push(dir);
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    const manager = new SessionManager(
      new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {},
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      timeoutMs,
    );
    managers.push(manager);
    await manager.init();
    const session = await manager.create('fake', '/repo');
    session.send('first');
    await settle();
    session.send('second');
    await settle();
    const items = (await session.snapshot()).items;
    return { manager, session, provider, items, key: threadKey('fake', 'cwd', '/repo') };
  }

  const sentText = (p: FakeProvider) => p.sent[p.sent.length - 1].text;

  test('a native fork stores the returned token and skips the seed', async () => {
    const ctx = await setup();
    ctx.provider.forkThreadResult = { resumeToken: 'forked-tok' };

    const forked = await ctx.manager.fork(ctx.session.state.id, ctx.items[ctx.items.length - 1].id);
    assert.strictEqual(forked!.state.resumeTokens[ctx.key], 'forked-tok');
    forked!.send('hello');
    await settle();

    assert.strictEqual(ctx.provider.starts[ctx.provider.starts.length - 1].resumeToken, 'forked-tok');
    assert.strictEqual(sentText(ctx.provider).includes(SEED_MARK), false);
    assert.strictEqual(ctx.provider.forkThreadCalls.length, 1);
    assert.strictEqual(ctx.provider.forkThreadCalls[0].resumeToken, ctx.session.state.resumeTokens[ctx.key]);
    assert.strictEqual(ctx.provider.forkThreadCalls[0].turnIndex, undefined);
  });

  test('a fork at the end of an earlier turn passes that turn index', async () => {
    const ctx = await setup();
    ctx.provider.forkThreadResult = { resumeToken: 'forked-tok' };
    const endOfFirstTurn = ctx.items[1].id;

    await ctx.manager.fork(ctx.session.state.id, endOfFirstTurn);

    assert.strictEqual(ctx.provider.forkThreadCalls[0].turnIndex, 0);
  });

  test('a fork in the middle of a turn never asks the provider', async () => {
    const ctx = await setup();
    ctx.provider.forkThreadResult = { resumeToken: 'forked-tok' };
    const midTurn = ctx.items.find((i) => i.role === 'user')!.id;

    const forked = await ctx.manager.fork(ctx.session.state.id, midTurn);
    forked!.send('hello');
    await settle();

    assert.strictEqual(ctx.provider.forkThreadCalls.length, 0);
    assert.strictEqual(sentText(ctx.provider).includes(SEED_MARK), true);
  });

  for (const [label, result] of [
    ['declines', false], ['throws', new Error('boom')], ['never answers', 'never'],
  ] as const) {
    test(`a provider that ${label} falls back to the seed`, async () => {
      const ctx = await setup(30);
      ctx.provider.forkThreadResult = result;

      const forked = await ctx.manager.fork(ctx.session.state.id, ctx.items[ctx.items.length - 1].id);
      assert.deepStrictEqual(forked!.state.resumeTokens, {});
      forked!.send('hello');
      await settle();

      assert.strictEqual(sentText(ctx.provider).includes(SEED_MARK), true);
    });
  }

  test('a source with no resume token never asks the provider', async () => {
    const ctx = await setup();
    ctx.provider.forkThreadResult = { resumeToken: 'forked-tok' };
    delete ctx.session.state.resumeTokens[ctx.key];

    const forked = await ctx.manager.fork(ctx.session.state.id, ctx.items[ctx.items.length - 1].id);
    forked!.send('hello');
    await settle();

    assert.strictEqual(ctx.provider.forkThreadCalls.length, 0);
    assert.strictEqual(sentText(ctx.provider).includes(SEED_MARK), true);
  });

  test('a busy source forks through the seed', async () => {
    const ctx = await setup();
    ctx.provider.forkThreadResult = { resumeToken: 'forked-tok' };
    ctx.session.state.status = 'running';

    const forked = await ctx.manager.fork(ctx.session.state.id, ctx.items[ctx.items.length - 1].id);

    assert.strictEqual(ctx.provider.forkThreadCalls.length, 0);
    assert.deepStrictEqual(forked!.state.resumeTokens, {});
  });

  test('a parent that starts working while the provider forks falls back to the seed', async () => {
    const ctx = await setup();
    let release!: (r: { resumeToken: string }) => void;
    ctx.provider.forkThreadResult = new Promise((r) => { release = r; });

    const pending = ctx.manager.fork(ctx.session.state.id, ctx.items[ctx.items.length - 1].id);
    await until(() => ctx.provider.forkThreadCalls.length > 0);
    ctx.session.send('a new instruction');
    await settle();
    release({ resumeToken: 'forked-tok' });
    const forked = await pending;

    assert.deepStrictEqual(forked!.state.resumeTokens, {});
  });

  test('the same race for a side chat falls back to the seed', async () => {
    const ctx = await setup();
    let release!: (r: { resumeToken: string }) => void;
    ctx.provider.forkThreadResult = new Promise((r) => { release = r; });

    const pending = ctx.manager.startSideChat(ctx.session.state.id);
    await until(() => ctx.provider.forkThreadCalls.length > 0);
    ctx.session.send('a new instruction');
    await settle();
    release({ resumeToken: 'forked-tok' });
    const side = await pending;

    assert.deepStrictEqual(side!.state.resumeTokens, {});
  });
});
