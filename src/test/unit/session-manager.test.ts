import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager', () => {
  let dir: string;
  let store: TranscriptStore;
  let sent: HostToWebview[];
  let providers: Map<string, AgentProvider>;
  let manager: SessionManager;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-manager-'));
    store = new TranscriptStore(dir);
    sent = [];
    providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    manager = new SessionManager(store, providers, (m) => sent.push(m));
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('create adds a session and announces the roster', async () => {
    const session = await manager.create('fake', '/tmp');
    assert.strictEqual(manager.summaries().length, 1);
    assert.strictEqual(manager.get(session.state.id), session);
    assert.ok(sent.some((m) => m.t === 'sessions-changed'));
  });

  test('patches reach visible sessions only', async () => {
    const a = await manager.create('fake', '/tmp');
    const b = await manager.create('fake', '/tmp');
    await manager.setVisible([a.state.id]);
    sent.length = 0;

    a.send('hello');
    b.send('hello');
    await settle();

    const patched = sent.filter((m) => m.t === 'session-patch') as
      Extract<HostToWebview, { t: 'session-patch' }>[];
    assert.ok(patched.length > 0);
    assert.ok(patched.every((m) => m.id === a.state.id),
      'no patch should be emitted for the hidden session');
  });

  test('status is announced for hidden sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    await manager.setVisible([]);
    sent.length = 0;

    a.send('hello');
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-status' && m.id === a.state.id));
  });

  test('setVisible emits a snapshot for newly visible sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    a.send('hello');
    await settle();
    sent.length = 0;

    await manager.setVisible([a.state.id]);
    const snaps = sent.filter((m) => m.t === 'session-snapshot');
    assert.strictEqual(snaps.length, 1);
  });

  test('close archives and keeps the transcript; remove deletes it', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    a.send('hello');
    await settle();

    await manager.close(id);
    assert.strictEqual(manager.get(id), undefined, 'closed session is not live');
    const summary = manager.summaries().find((s) => s.id === id);
    assert.strictEqual(summary?.archived, true);
    const kept = await store.tail(id);
    assert.ok(kept.items.length > 0, 'transcript survives close');

    await manager.remove(id);
    assert.strictEqual(manager.summaries().find((s) => s.id === id), undefined);
    const gone = await store.tail(id);
    assert.strictEqual(gone.items.length, 0);
  });

  test('init restores sessions and layout from the index', async () => {
    const a = await manager.create('fake', '/tmp');
    manager.setLayout({
      orientation: 'horizontal',
      panes: [{ sessionId: a.state.id, size: 100 }],
    });
    await manager.dispose();

    const fresh = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await fresh.init();
    assert.strictEqual(fresh.summaries().length, 1);
    assert.strictEqual(fresh.layout().orientation, 'horizontal');
    assert.strictEqual(fresh.get(a.state.id), undefined,
      'restored sessions are not live until opened');
    await fresh.dispose();
  });

  test('open revives an archived session as live', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    await manager.close(id);

    const revived = await manager.open(id);
    assert.strictEqual(revived.state.archived, false);
    assert.strictEqual(manager.get(id), revived);
  });
});
