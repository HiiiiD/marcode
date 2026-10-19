import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { SessionOwnership } from '../../host/session-ownership';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, MoveThreadResult } from '../../providers/types';
import { threadKey } from '../../shared/thread-key';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SEED_MARK = 'before it moved to this directory';

suite('SessionManager.moveTo native thread move', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];
  const ownerships: SessionOwnership[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (ownerships.length > 0) { await ownerships.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function setup(opts: { oldToken?: string; timeoutMs?: number } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-native-move-'));
    dirs.push(dir);
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const manager = new SessionManager(
      store, providers, () => {},
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      opts.timeoutMs,
    );
    managers.push(manager);
    await manager.init();

    const session = await manager.create('fake', '/repo');
    session.send('plan the feature');
    await settle();

    const target = resolve('/repo/../t/a');
    const oldKey = threadKey('fake', 'cwd', session.state.cwd);
    const newKey = threadKey('fake', 'cwd', target);
    if (opts.oldToken) { session.state.resumeTokens[oldKey] = opts.oldToken; }
    else { delete session.state.resumeTokens[oldKey]; }
    store.append(session.state.id, {
      id: 'r1', ts: Date.now(), role: 'relocation', path: target, state: 'pending',
    });
    return { manager, session, provider, oldKey, newKey, target };
  }

  async function moveAndSend(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.manager.relocate(ctx.session.state.id, 'r1', true);
    const moved = ctx.manager.get(ctx.session.state.id)!;
    const tokens = { ...moved.state.resumeTokens };
    moved.send('continue');
    await settle();
    return { moved, tokens, text: ctx.provider.sent[ctx.provider.sent.length - 1].text };
  }

  test('native success skips the seed', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    ctx.provider.moveThreadResult = { resumeToken: 'tok' };
    const from = ctx.session.state.cwd;
    const { tokens, text } = await moveAndSend(ctx);
    assert.deepStrictEqual(
      ctx.provider.moveThreadCalls.map((c) => [c.resumeToken, c.from, c.to]),
      [['tok', from, ctx.target]],
    );
    assert.strictEqual(ctx.provider.starts.at(-1)!.resumeToken, 'tok');
    assert.strictEqual(text.includes(SEED_MARK), false);
    assert.strictEqual(tokens[ctx.newKey], 'tok');
  });

  test('no old-key token means no native attempt', async () => {
    const ctx = await setup();
    const { text } = await moveAndSend(ctx);
    assert.strictEqual(ctx.provider.moveThreadCalls.length, 0);
    assert.strictEqual(text.includes(SEED_MARK), true);
  });

  test('false falls back to the seed', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    ctx.provider.moveThreadResult = false;
    const { text } = await moveAndSend(ctx);
    assert.strictEqual(ctx.provider.moveThreadCalls.length, 1);
    assert.strictEqual(text.includes(SEED_MARK), true);
  });

  test('throw falls back', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    ctx.provider.moveThreadResult = new Error('boom');
    const { text } = await moveAndSend(ctx);
    assert.strictEqual(text.includes(SEED_MARK), true);
  });

  test('never settling falls back after the timeout', async () => {
    const ctx = await setup({ oldToken: 'tok', timeoutMs: 50 });
    ctx.provider.moveThreadResult = 'never';
    const { text } = await moveAndSend(ctx);
    assert.strictEqual(text.includes(SEED_MARK), true);
  });

  test('dropOldKey removes the old token', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    ctx.provider.moveThreadResult = { resumeToken: 'tok', dropOldKey: true };
    const { tokens } = await moveAndSend(ctx);
    assert.strictEqual(tokens[ctx.oldKey] === undefined, true);
    assert.strictEqual(tokens[ctx.newKey], 'tok');
  });

  test('open() during the native step resolves to the moved session', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    const id = ctx.session.state.id;
    let release!: (r: MoveThreadResult) => void;
    ctx.provider.moveThreadResult = new Promise((r) => { release = r; });
    const startsBefore = ctx.provider.starts.length;

    const moving = ctx.manager.relocate(id, 'r1', true);
    await until(() => ctx.provider.moveThreadCalls.length === 1);
    const opened = ctx.manager.open(id).then((s) => { s.send('mid-move'); return s; });
    await settle();
    release({ resumeToken: 'tok' });
    await moving;
    const session = await opened;
    await settle();

    assert.strictEqual(session === ctx.manager.get(id), true);
    assert.deepStrictEqual(ctx.provider.starts.slice(startsBefore).map((s) => s.cwd), [ctx.target]);
  });

  test('a foreign session never runs the native step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-native-move-foreign-'));
    dirs.push(dir);
    const hostAt = async (kind: 'vscode' | 'tui') => {
      const store = new TranscriptStore(dir, kind);
      const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
      const manager = new SessionManager(store, new Map<string, AgentProvider>([['fake', provider]]), () => {});
      const ownership = new SessionOwnership(path.join(dir, 'sessions'), kind, { heartbeatMs: 20 });
      manager.setOwnership(ownership, { tailIntervalMs: 20 });
      ownerships.push(ownership);
      managers.push(manager);
      await manager.init();
      return { manager, store, provider };
    };
    const owner = await hostAt('vscode');
    const made = await owner.manager.create('fake', '/w');
    made.send('hi');
    await settle();
    const target = resolve('/w/../t/a');
    made.state.resumeTokens[threadKey('fake', 'cwd', made.state.cwd)] = 'tok';
    owner.store.append(made.state.id, { id: 'r1', ts: Date.now(), role: 'relocation', path: target, state: 'pending' });
    await owner.manager.persistNow();
    await owner.store.flush();

    const guest = await hostAt('tui');
    await guest.manager.syncRoster();
    const opened = await guest.manager.open(made.state.id);
    const before = opened.state.cwd;
    guest.provider.moveThreadResult = { resumeToken: 'tok' };
    await guest.manager.relocate(made.state.id, 'r1', true);

    assert.strictEqual(guest.provider.moveThreadCalls.length, 0);
    assert.strictEqual(guest.manager.get(made.state.id)!.state.cwd, before);
  });

  test('forgetThreadAt still clears the old key on native success', async () => {
    const ctx = await setup({ oldToken: 'tok' });
    ctx.provider.moveThreadResult = { resumeToken: 'tok' };
    const from = ctx.session.state.cwd;
    await (ctx.manager as unknown as {
      moveTo(id: string, s: unknown, st: unknown, to: string, forget?: string): Promise<void>;
    }).moveTo(ctx.session.state.id, ctx.session, ctx.session.state, ctx.target, from);
    const state = ctx.manager.get(ctx.session.state.id)!.state;
    assert.strictEqual(state.resumeTokens[ctx.oldKey] === undefined, true);
    assert.strictEqual(state.resumeTokens[ctx.newKey], 'tok');
  });
});
