import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('MessageRouter', () => {
  let dir: string;
  let sent: HostToWebview[];
  let manager: SessionManager;
  let router: MessageRouter;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-router-'));
    sent = [];
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
    router = new MessageRouter(manager, (m) => sent.push(m));
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('ready produces a hydrate carrying the catalog', async () => {
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.ok(hydrate);
    assert.strictEqual(hydrate.catalog.length, 1);
    assert.strictEqual(hydrate.catalog[0].id, 'fake');
    assert.deepStrictEqual(hydrate.sessions, []);
  });

  test('create-session then send drives a turn', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    sent.length = 0;

    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-patch' && m.id === id));
  });

  test('load-more emits session-prepend', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    for (let i = 0; i < 5; i++) {
      await router.handle({ t: 'send', id, text: `msg ${i}` });
      await settle();
    }
    const session = manager.get(id)!;
    const snap = await session.snapshot();
    sent.length = 0;

    await router.handle({ t: 'load-more', id, beforeItemId: snap.items[1].id });
    const prepend = sent.find((m) => m.t === 'session-prepend');
    assert.ok(prepend);
  });

  test('an unknown session id is ignored rather than thrown', async () => {
    await router.handle({ t: 'send', id: 'nope', text: 'hi' });
    await router.handle({ t: 'interrupt', id: 'nope' });
    assert.ok(true, 'no exception escaped the router');
  });

  test('create-session with an unknown providerId is ignored rather than thrown', async () => {
    await router.handle({ t: 'create-session', providerId: 'nope-provider', cwd: '/tmp' });
    assert.strictEqual(manager.summaries().length, 0);
    assert.ok(true, 'no exception escaped the router');
  });
});
