import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SessionStatus, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager.relocate', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) {
      await fs.rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  /**
   * A live session at `/repo` with one turn of history and a pending
   * relocation offer (item id `r1`) naming `target`.
   *
   * The offer is appended straight through the store rather than by scripting
   * a `git worktree add` through the provider: this suite is about answering
   * an offer, and Task 5's suite already covers raising one.
   */
  async function withPendingOffer(target: string, status: SessionStatus = 'idle') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-relocate-'));
    dirs.push(dir);
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const emitted: HostToWebview[] = [];
    const manager = new SessionManager(store, providers, (m) => emitted.push(m));
    managers.push(manager);
    await manager.init();

    const session = await manager.create('fake', '/repo');
    session.send('plan the feature');
    await settle();

    const to = resolve(target);
    store.append(session.state.id, {
      id: 'r1', ts: Date.now(), role: 'relocation', path: to, state: 'pending',
    });
    session.state.status = status;
    return { manager, session, provider, emitted, store, target: to };
  }

  test('moves cwd and marks the item moved', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd.endsWith('a'), true);

    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'moved');
  });

  test('declining leaves cwd alone and marks the item stayed', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', false);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);

    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'stayed');
  });

  test('answering twice is a no-op the second time', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', false);
    const before = manager.get(session.state.id)!.state.cwd;
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });

  test('reuses an existing thread for a directory already visited', async () => {
    const { manager, session, provider, target } = await withPendingOffer('/repo/../t/a');
    session.state.resumeTokens[`fake:${target}`] = 'known-token';
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, 'known-token');
    assert.strictEqual(manager.get(session.state.id)!.pendingSeedText, undefined);
  });

  test('seeds a fresh thread when the directory has no token', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, undefined);
    assert.strictEqual(manager.get(session.state.id)!.pendingSeedText!.length > 0, true);
  });

  test('refuses while the session is running', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a', 'running');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });

  test('the seed rides the next send and is spent there', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    const moved = manager.get(session.state.id)!;

    moved.send('now implement it');
    await settle();
    const first = provider.sent[provider.sent.length - 1].text;
    assert.strictEqual(first.includes('already happened'), true);
    assert.strictEqual(first.includes('plan the feature'), true);
    assert.strictEqual(first.endsWith('now implement it'), true);

    moved.send('and again');
    await settle();
    assert.strictEqual(provider.sent[provider.sent.length - 1].text, 'and again');
  });

  test('the seed never reaches the transcript', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    const moved = manager.get(session.state.id)!;

    moved.send('now implement it');
    await settle();
    // The provider saw the seed...
    assert.strictEqual(
      provider.sent[provider.sent.length - 1].text.includes('already happened'), true);

    // ...and the record of what the user said did not.
    const { items } = await moved.snapshot();
    const users = items.filter((i: TranscriptItem) => i.role === 'user');
    const last = users[users.length - 1];
    assert.strictEqual(last.role === 'user' && last.text, 'now implement it');
    assert.strictEqual(
      items.some((i) => JSON.stringify(i).includes('already happened')), false);
  });
});
