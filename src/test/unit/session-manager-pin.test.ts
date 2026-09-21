import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { HostToWebview } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-pin-'));
  const store = new TranscriptStore(dir);
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(store, providers, (m) => sent.push(m));
  await manager.init();
  return { store, sent, providers, manager };
}

suite('SessionManager pinning', () => {
  test('setPinned flips the flag, emits sessions-changed, and leaves updatedAt alone', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    const before = manager.summaries().find((s) => s.id === id)!.updatedAt;
    sent.length = 0;
    manager.setPinned(id, true);
    const after = manager.summaries().find((s) => s.id === id)!;
    assert.strictEqual(after.pinned, true);
    assert.strictEqual(after.updatedAt, before);
    assert.strictEqual(sent.some((m) => m.t === 'sessions-changed'), true);
    await manager.dispose();
  });

  test('a pin survives close and a restart', async () => {
    const { store, providers, manager } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    // An empty session is discarded on restore, so it needs real content to come back.
    session.send('Keep me around');
    manager.setPinned(id, true);
    await manager.close(id);
    await manager.dispose();
    const again = new SessionManager(store, providers, () => {});
    await again.init();
    const restored = again.summaries().find((s) => s.id === id)!;
    assert.strictEqual(restored.pinned, true);
    assert.strictEqual(restored.archived, true);
    await again.dispose();
  });

  test('unknown id and no-op changes emit nothing', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    sent.length = 0;
    manager.setPinned('nope', true);
    manager.setPinned(session.state.id, false);
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });
});
