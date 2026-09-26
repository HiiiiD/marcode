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

suite('MessageRouter always-allow', () => {
  let dir: string;
  let provider: FakeProvider;
  let manager: SessionManager;
  let router: MessageRouter;
  let n: number;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-router-aa-'));
    n = 0;
    provider = new FakeProvider(() => [
      { kind: 'permission', id: `r${++n}`, tool: { kind: 'command', label: 'Bash', command: 'ls' } },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const sent: HostToWebview[] = [];
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
    router = new MessageRouter(manager, (m) => sent.push(m), '/tmp');
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('permission-decision with always makes the next matching request auto-allowed', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'send', id, text: 'one' });
    await settle();
    await router.handle({
      t: 'permission-decision', id, requestId: 'r1', decision: { allow: true }, always: true,
    });
    await settle();
    await router.handle({ t: 'send', id, text: 'two' });
    await settle();
    assert.deepStrictEqual(provider.decisions.get('r2'), { allow: true });
  });

  test('permission-decision without always leaves the next request pending', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'send', id, text: 'one' });
    await settle();
    await router.handle({ t: 'permission-decision', id, requestId: 'r1', decision: { allow: true } });
    await settle();
    await router.handle({ t: 'send', id, text: 'two' });
    await settle();
    assert.strictEqual(provider.decisions.has('r2'), false);
  });
});
