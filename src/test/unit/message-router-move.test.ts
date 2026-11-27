import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import type { MoveService } from '../../host/sync/move-service';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, MovePanel } from '../../protocol/messages';

async function rig() {
  const sent: HostToWebview[] = [];
  const manager = new SessionManager(new TranscriptStore(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-router-move-'))), new Map(), () => {});
  const router = new MessageRouter(manager, (m) => sent.push(m), '/tmp');
  return { sent, manager, router };
}

const panel: MovePanel = {
  id: 'r1', mode: 'move', checkouts: [{ root: '/w', branch: 'main', main: true }], defaultRoot: '/w', branch: 'main',
  thread: 'restarted', ownerName: 'PC-desk', lastSeenAt: 1,
};

suite('MessageRouter move', () => {
  test('a device without sync answers the move panel as unavailable', async () => {
    const { sent, router } = await rig();
    await router.handle({ t: 'request-move-panel', id: 'r1' });
    const reply = sent.find((m) => m.t === 'move-panel');
    assert.deepStrictEqual(reply?.t === 'move-panel' && [reply.panel.mode, reply.panel.reason], ['unavailable', 'Sync is not set up on this device.']);
  });

  test('the panel, a move and a take over reach the service, and every status comes back', async () => {
    const { sent, manager, router } = await rig();
    const calls: string[] = [];
    manager.setMoveService({
      panel: async () => panel,
      moveHere: async (id: string, _t: unknown, opts: { cancelTurn: boolean }, on: (s: unknown) => void) => {
        calls.push(`move:${id}:${opts.cancelTurn}`);
        on({ state: 'waiting', step: 'reply' });
        on({ state: 'done', sessionId: id, thread: 'restarted' });
      },
      takeOver: async (id: string, _t: unknown, on: (s: unknown) => void) => { calls.push(`take:${id}`); on({ state: 'failed', reason: 'no' }); },
    } as unknown as MoveService);
    await router.handle({ t: 'request-move-panel', id: 'r1' });
    await router.handle({ t: 'move-session', id: 'r1', target: { root: '/w' }, cancelTurn: true });
    await router.handle({ t: 'take-over-session', id: 'r1', target: { createWorktree: 'feat/x' } });
    assert.deepStrictEqual(calls, ['move:r1:true', 'take:r1']);
    assert.deepStrictEqual(sent.filter((m) => m.t === 'move-panel').length, 1);
    assert.deepStrictEqual(sent.flatMap((m) => (m.t === 'move-status' ? [m.status.state] : [])), ['waiting', 'done', 'failed']);
  });

  test('a service that throws becomes a failed status, never a rejection', async () => {
    const { sent, manager, router } = await rig();
    manager.setMoveService({ moveHere: async () => { throw new Error('boom'); } } as unknown as MoveService);
    await router.handle({ t: 'move-session', id: 'r1', target: { root: '/w' }, cancelTurn: false });
    const status = sent.find((m) => m.t === 'move-status');
    assert.strictEqual(status?.t === 'move-status' && status.status.state, 'failed');
  });
});
