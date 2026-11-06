import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

suite('subagent kind', () => {
  let dir: string;
  let manager: SessionManager;
  let sent: HostToWebview[];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subkind-'));
    sent = [];
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }])]]);
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('a subagent is absent from summaries() but resolvable by lookup()', async () => {
    const parent = await manager.create('fake', dir);
    const child = await manager.create('fake', dir, undefined, undefined, undefined, undefined, true, parent.state.id, 'subagent');
    assert.strictEqual(manager.summaries().some((s) => s.id === child.state.id), false);
    assert.strictEqual(manager.summaries().some((s) => s.id === parent.state.id), true);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).some((s) => s.id === child.state.id), true);
    assert.strictEqual(manager.lookup(child.state.id)?.parentId, parent.state.id);
    assert.strictEqual(manager.isSubagent(child.state.id), true);
    assert.strictEqual(manager.isSubagent(parent.state.id), false);
  });

  test('a subagent never enters the visible set', async () => {
    const child = await manager.create('fake', dir, undefined, undefined, undefined, undefined, true, undefined, 'subagent');
    await manager.setVisible([child.state.id]);
    assert.deepStrictEqual(manager.visibleIds(), []);
  });

  test('a normal session is unaffected', async () => {
    const s = await manager.create('fake', dir);
    await manager.setVisible([s.state.id]);
    assert.deepStrictEqual(manager.visibleIds(), [s.state.id]);
    assert.strictEqual(manager.summaries().find((x) => x.id === s.state.id)?.kind, undefined);
  });

  test('sessions-changed never lists a subagent', async () => {
    const child = await manager.create('fake', dir, undefined, undefined, undefined, undefined, true, undefined, 'subagent');
    await manager.setVisible([]);
    const lists = sent.filter((m) => m.t === 'sessions-changed') as Extract<HostToWebview, { t: 'sessions-changed' }>[];
    assert.strictEqual(lists.some((m) => m.sessions.some((x) => x.id === child.state.id)), false);
  });
});
