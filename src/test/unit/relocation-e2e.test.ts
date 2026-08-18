import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SessionId, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

/**
 * The whole path, wired the way the extension wires it: a real
 * `SessionManager` over a real `TranscriptStore`, one `FakeProvider`, and no
 * shortcuts past `AgentSession`. Where the two focused suites each cut the
 * chain in half — `agent-session-relocation` raises an offer nobody answers,
 * `session-relocate` answers an offer nobody raised — this one carries a
 * single session from a `git worktree add` through to the send that spends
 * the seed.
 */
suite('relocation end to end', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) {
      await fs.rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  /** A live, idle session at `/repo` with one completed turn behind it. */
  async function liveSession() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-e2e-'));
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
    return { manager, store, session, provider, emitted, id: session.state.id };
  }

  /** The run behind the session the manager currently holds for `id`. */
  function currentRun(provider: FakeProvider) {
    return provider.runs[provider.runs.length - 1];
  }

  /** Every item the store holds for `id`, offers included. */
  async function items(store: TranscriptStore, id: SessionId): Promise<TranscriptItem[]> {
    return (await store.tail(id, 500)).items;
  }

  /**
   * Scripts a top-level `git worktree add` the way a provider reports one,
   * and returns the offer it raised.
   */
  async function addWorktree(
    manager: SessionManager, store: TranscriptStore, provider: FakeProvider,
    id: SessionId, target: string,
  ): Promise<TranscriptItem> {
    const run = currentRun(provider);
    run.emit({
      kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: `git worktree add ${target} -b a` },
    });
    run.emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await settle();
    await manager.get(id)!.snapshot();
    const offer = (await items(store, id)).find((i) => i.role === 'relocation');
    assert.strictEqual(offer !== undefined, true, 'no relocation offer was raised');
    return offer!;
  }

  /** A session that has already accepted a move into a fresh tree. */
  async function relocatedSession() {
    const live = await liveSession();
    const offer = await addWorktree(
      live.manager, live.store, live.provider, live.id, '../t/a');
    await live.manager.relocate(live.id, offer.id, true);
    return { ...live, root: '/repo' };
  }

  test('worktree add, accept, send — the seed rides the first message', async () => {
    const { manager, store, provider, id } = await liveSession();
    const offer = await addWorktree(manager, store, provider, id, '../t/a');
    assert.strictEqual(offer.role === 'relocation' && offer.state, 'pending');

    await manager.relocate(id, offer.id, true);

    const moved = manager.get(id)!;
    assert.strictEqual(moved.state.cwd.endsWith('a'), true);
    const settledOffer = await store.find(id, offer.id);
    assert.strictEqual(
      settledOffer?.role === 'relocation' && settledOffer.state, 'moved');

    moved.send('now implement it');
    await settle();
    const first = provider.sent[provider.sent.length - 1].text;
    assert.strictEqual(first.includes('already happened'), true);
    assert.strictEqual(first.includes('plan the feature'), true);
    assert.strictEqual(first.endsWith('now implement it'), true);
  });

  test('a second send in the same tree carries no seed', async () => {
    const { manager, provider, id } = await relocatedSession();
    manager.get(id)!.send('one');
    await settle();
    manager.get(id)!.send('two');
    await settle();
    assert.strictEqual(provider.sent[provider.sent.length - 1].text, 'two');
  });

  test('moving back to a visited tree resumes rather than seeding', async () => {
    const { manager, store, provider, id, root } = await relocatedSession();
    const moved = manager.get(id)!;
    moved.state.resumeTokens[`fake:${path.resolve(root)}`] = 'root-token';

    // A second offer, this one naming the tree the session started in.
    const back: TranscriptItem = {
      id: 'r-back', ts: Date.now(), role: 'relocation',
      path: path.resolve(root), state: 'pending',
    };
    store.append(id, back);
    await manager.relocate(id, back.id, true);

    assert.strictEqual(manager.get(id)!.state.cwd, path.resolve(root));
    assert.strictEqual(provider.lastStart!.resumeToken, 'root-token');
    assert.strictEqual(manager.get(id)!.pendingSeedText, undefined);
  });

  test('declining leaves the session where it is and never seeds', async () => {
    const { manager, store, provider, id } = await liveSession();
    const before = manager.get(id)!.state.cwd;
    const offer = await addWorktree(manager, store, provider, id, '../t/b');

    await manager.relocate(id, offer.id, false);
    assert.strictEqual(manager.get(id)!.state.cwd, before);
    assert.strictEqual(manager.get(id)!.pendingSeedText, undefined);

    manager.get(id)!.send('carry on');
    await settle();
    assert.strictEqual(provider.sent[provider.sent.length - 1].text, 'carry on');
  });
});
