import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { AgentEvent } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager.restart', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function setup(script: (text: string) => AgentEvent[] = () => [
    { kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' },
  ]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-restart-'));
    dirs.push(dir);
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(script);
    const manager = new SessionManager(store, new Map<string, AgentProvider>([['fake', provider]]), () => {});
    managers.push(manager);
    await manager.init();
    const session = await manager.create('fake', '/repo');
    session.send('hello');
    await settle();
    return { manager, session, provider, store };
  }

  test('restart rebuilds the run on the same resume token and never calls moveThread', async () => {
    const { manager, session, provider, store } = await setup();
    const id = session.state.id;
    await manager.restart(id);
    await settle();

    assert.strictEqual(provider.starts.length, 2);
    assert.strictEqual(provider.starts[1].resumeToken, 'fake-session-1');
    assert.strictEqual(provider.moveThreadCalls.length, 0);
    assert.strictEqual(manager.get(id) !== session, true);
    const { items } = await store.tail(id, 50);
    const last = items[items.length - 1];
    assert.deepStrictEqual([last.role, last.role === 'switch' ? last.kind : '', last.role === 'switch' ? last.text : ''],
      ['switch', 'restart', 'Session restarted to apply MCP changes']);
  });

  test('restart interrupts a running turn first', async () => {
    const { manager, session, provider } = await setup(() => [{ kind: 'text', delta: 'still going' }]);
    assert.strictEqual(session.state.status, 'running');
    await manager.restart(session.state.id);
    await settle();
    assert.strictEqual(provider.interrupted.length, 1);
    assert.strictEqual(provider.starts.length, 2);
  });

  test('restart is a no-op for a foreign session', async () => {
    const { manager, session, provider } = await setup();
    manager.isForeign = () => true;
    await manager.restart(session.state.id);
    assert.strictEqual(provider.starts.length, 1);
  });

  test('restart of an unknown session does nothing', async () => {
    const { manager, provider } = await setup();
    await manager.restart('nope');
    assert.strictEqual(provider.starts.length, 1);
  });
});
