import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import type { SyncService } from '../../host/sync/sync-service';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SyncPanel } from '../../protocol/messages';

async function rig() {
  const sent: HostToWebview[] = [];
  const manager = new SessionManager(new TranscriptStore(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-router-sync-'))), new Map(), () => {});
  const router = new MessageRouter(manager, (m) => sent.push(m), '/tmp');
  return { sent, manager, router };
}

const panels = (sent: HostToWebview[]) => sent.flatMap((m) => (m.t === 'sync-panel' ? [m.panel] : []));

suite('MessageRouter sync', () => {
  test('every sync request reaches the service; interim and final panels come back', async () => {
    const { sent, manager, router } = await rig();
    const seen: string[] = [];
    const final: SyncPanel = { state: 'unpaired', defaultName: 'desk' };
    manager.setSyncService({
      status: () => 'ok',
      handle: async (msg: { t: string }, interim: (p: SyncPanel) => void) => { seen.push(msg.t); interim({ ...final, busy: true }); return final; },
    } as unknown as SyncService);
    const messages = [
      { t: 'sync-open' }, { t: 'sync-refresh' }, { t: 'sync-setup', server: 's', code: 'c', name: 'n' },
      { t: 'sync-join', server: 's', code: 'c', name: 'n' }, { t: 'sync-pair' }, { t: 'sync-revoke', deviceId: 'd' },
      { t: 'sync-leave' }, { t: 'sync-forget' }, { t: 'sync-project', path: '/p', choice: 'own' },
    ] as const;
    for (const msg of messages) { await router.handle(msg); }
    assert.deepStrictEqual(seen, messages.map((m) => m.t));
    assert.strictEqual(panels(sent).length, messages.length * 2);
    assert.deepStrictEqual(panels(sent).slice(0, 2), [{ ...final, busy: true }, final]);
  });

  test('without a sync service the dialog says sync is unavailable', async () => {
    const { sent, router } = await rig();
    await router.handle({ t: 'sync-open' });
    const panel = panels(sent)[0];
    assert.strictEqual(panel.state, 'unpaired');
    assert.strictEqual(panel.state === 'unpaired' && panel.error?.message, 'Sync is not available in this window.');
  });

  test('hydrate carries the sync status', async () => {
    const { sent, manager, router } = await rig();
    manager.setSyncService({ status: () => 'offline', handle: async () => ({ state: 'unpaired', defaultName: 'x' }) } as unknown as SyncService);
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate');
    assert.strictEqual(hydrate?.t === 'hydrate' && hydrate.syncStatus, 'offline');
  });
});
