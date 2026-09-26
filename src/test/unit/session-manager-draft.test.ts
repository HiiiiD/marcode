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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-draft-'));
  const store = new TranscriptStore(dir);
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(store, providers, (m) => sent.push(m));
  await manager.init();
  return { store, sent, providers, manager };
}

suite('SessionManager drafts', () => {
  test('setDraft stores text, leaves updatedAt alone and fans nothing out', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    const before = manager.summaries().find((s) => s.id === id)!.updatedAt;
    sent.length = 0;
    manager.setDraft(id, 'half a thought');
    const after = manager.summaries().find((s) => s.id === id)!;
    assert.strictEqual(after.draft, 'half a thought');
    assert.strictEqual(after.updatedAt, before);
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });

  test('an empty draft clears the field', async () => {
    const { manager } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    manager.setDraft(id, 'x');
    manager.setDraft(id, '');
    assert.strictEqual('draft' in manager.summaries().find((s) => s.id === id)!, false);
    await manager.dispose();
  });

  test('a draft survives close and a restart', async () => {
    const { store, providers, manager } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    session.send('Keep me around');
    manager.setDraft(id, 'unsent');
    await manager.close(id);
    await manager.dispose();
    const again = new SessionManager(store, providers, () => {});
    await again.init();
    assert.strictEqual(again.summaries().find((s) => s.id === id)!.draft, 'unsent');
    await again.dispose();
  });

  test('unknown id is ignored', async () => {
    const { manager } = await rig();
    manager.setDraft('nope', 'x');
    await manager.dispose();
  });
});
