import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { approveSpawn } from '../../host/subagent/host-approval';
import { resolveSpawn } from '../../host/self-control/spawn-support';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import { describeInput, describeTool } from '../../webview/components/tool-render';

const spawn = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: 'bypass' as const, cwd, includeEditorContext: undefined,
});
const tick = async () => { for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); } };

suite('host approval', () => {
  let dir: string;
  let manager: SessionManager;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-hostappr-'));
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(() => [])]]);
    manager = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('a spawn approval parks as a pending card and resolves with the user decision', async () => {
    const s = await manager.create('fake', dir);
    const outcome = approveSpawn(s, spawn(dir), 'rm everything');
    await tick();
    assert.strictEqual(s.state.status, 'awaiting-approval');
    const [pending] = (await s.snapshot()).pending;
    assert.strictEqual(pending.tool.kind, 'spawn');
    s.respondToPermission(pending.requestId, { allow: true });
    assert.deepStrictEqual(await outcome, { ok: true });
  });

  test('a denial carries the reason and approveSpawn reports it', async () => {
    const s = await manager.create('fake', dir);
    const outcome = approveSpawn(s, spawn(dir), 'x');
    await tick();
    const [pending] = (await s.snapshot()).pending;
    s.respondToPermission(pending.requestId, { allow: false, reason: 'too risky' });
    const r = await outcome;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(!r.ok && r.error.includes('too risky'), true);
  });

  test('interrupting while pending denies and clears waiting', async () => {
    const s = await manager.create('fake', dir);
    const outcome = approveSpawn(s, spawn(dir), 'x');
    await tick();
    await s.interrupt();
    assert.strictEqual((await outcome).ok, false);
    assert.notStrictEqual(s.state.status, 'awaiting-approval');
  });

  test('a requester that cannot ask is a denial, never a silent allow', async () => {
    const r = await approveSpawn(undefined, spawn(dir), 'x');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(!r.ok && r.error.includes('bypass'), true);
  });

  test('the spawn card renders cwd, mode and the full prompt', () => {
    const tool = { kind: 'spawn' as const, label: 'Spawn', cwd: '/w', mode: 'bypass', prompt: 'do the thing' };
    assert.strictEqual(describeTool(tool).primary.includes('bypass'), true);
    const blocks = describeInput(tool);
    assert.strictEqual(blocks.some((b) => b.kind === 'lines' && b.text === 'do the thing'), true);
    assert.strictEqual(blocks.some((b) => b.kind === 'path' && b.path === '/w'), true);
  });

  const catalog = () => ({
    catalog: () => [{ id: 'fake', models: [{ id: 'm' }], permissionModes: [{ id: 'default' }, { id: 'bypass' }] }],
  });

  test('resolveSpawn flags an explicit bypass for approval', () => {
    const r = resolveSpawn(catalog(), undefined, { provider: 'fake', mode: 'bypass', cwd: path.resolve('/w') });
    assert.strictEqual(r.ok && r.needsApproval, 'bypass');
    assert.strictEqual(r.ok && r.spawn.mode, 'bypass');
  });

  test('resolveSpawn still drops an inherited bypass without asking', () => {
    const from = { id: 's', name: 'n', providerId: 'fake', model: 'm', permissionMode: 'bypass', status: 'idle', cwd: '/w' };
    const r = resolveSpawn(catalog(), from as never, { cwd: path.resolve('/w') });
    assert.strictEqual(r.ok && r.needsApproval, undefined);
    assert.strictEqual(r.ok && r.spawn.mode, undefined);
  });
});
