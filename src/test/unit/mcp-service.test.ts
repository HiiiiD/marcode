import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { McpChangeLog } from '../../host/mcp/change-log';
import { MCP_STATUS_TIMEOUT_MS, McpService } from '../../host/mcp/mcp-service';
import { resolveRepoRoot } from '../../host/mcp/repo-root';
import { MCP_POLL_BUDGET_MS, settledMcpStatus } from '../../providers/claude/claude-provider';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, McpServerSpec } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

const SPEC: McpServerSpec = { name: 'blender', transport: 'stdio', command: 'uv', args: ['run', 'blender-mcp'], env: {} };

suite('McpService', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) { await fs.rm(dirs.pop()!, { recursive: true, force: true }); }
  });

  async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-mcp-svc-'));
    dirs.push(dir);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-mcp-cwd-'));
    dirs.push(cwd);
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    provider.mcpStatus = [{ name: 'shadcn', state: 'connected', toolCount: 2, origin: 'repo' }];
    provider.mcpLoadedAt = 1000;
    const emitted: HostToWebview[] = [];
    const manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), (m) => { emitted.push(m); });
    managers.push(manager);
    await manager.init();
    const opened: string[] = [];
    const handle = (msg: Parameters<typeof manager.mcpService.handle>[0]) =>
      manager.mcpService.handle(msg, (url) => { opened.push(url); });
    return { manager, provider, cwd, emitted, handle, opened };
  }

  test('open pushes live status through session-mcp and answers with capabilities and targets', async () => {
    const { manager, provider, cwd, emitted, handle } = await setup();
    const s = await manager.create('fake', cwd);
    await manager.setVisible([s.state.id]);
    const panel = await handle({ t: 'mcp-open', id: s.state.id });
    assert.deepStrictEqual(panel.capabilities, provider.mcpConfig.capabilities);
    assert.strictEqual(panel.targets?.repo && 'path' in panel.targets.repo, true);
    assert.deepStrictEqual(panel.pending, []);
    const pushed = emitted.filter((m) => m.t === 'session-mcp').map((m) => m.t === 'session-mcp' ? m.servers.map((x) => x.name) : []);
    assert.deepStrictEqual(pushed[pushed.length - 1], ['shadcn']);
  });

  test('add records a pending change visible to another session in the same repo', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    const b = await manager.create('fake', cwd);
    const after = await handle({ t: 'mcp-add', id: a.state.id, scope: 'repo', server: SPEC });
    assert.strictEqual(after.error, undefined);
    assert.deepStrictEqual(after.pending, [{ name: 'blender', origin: 'repo', change: 'added' }]);
    const other = await handle({ t: 'mcp-open', id: b.state.id });
    assert.deepStrictEqual(other.pending, [{ name: 'blender', origin: 'repo', change: 'added' }]);
    assert.strictEqual(provider.mcpWrites.length, 1);
  });

  test('a session that has not loaded config yet shows no pending change', async () => {
    const { manager, provider, cwd, handle } = await setup();
    provider.mcpLoadedAt = undefined;
    const a = await manager.create('fake', cwd);
    const panel = await handle({ t: 'mcp-add', id: a.state.id, scope: 'repo', server: SPEC });
    assert.deepStrictEqual(panel.pending, []);
  });

  test('store rejection becomes panel.error and nothing throws', async () => {
    const { manager, provider, cwd, handle } = await setup();
    provider.mcpFail = 'disk full';
    const a = await manager.create('fake', cwd);
    const panel = await handle({ t: 'mcp-add', id: a.state.id, scope: 'global', server: SPEC });
    assert.strictEqual(panel.error, 'disk full');
    const next = await handle({ t: 'mcp-open', id: a.state.id });
    assert.strictEqual(next.error, undefined);
  });

  test('a foreign session gets a read-only panel that says why', async () => {
    const { manager, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    manager.isForeign = () => true;
    const panel = await handle({ t: 'mcp-open', id: a.state.id });
    assert.deepStrictEqual([panel.capabilities, panel.readOnly], [null, 'This session is open in another window.']);
  });

  test('foreign session add is refused', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    manager.isForeign = () => true;
    const panel = await handle({ t: 'mcp-add', id: a.state.id, scope: 'repo', server: SPEC });
    assert.strictEqual(panel.error, 'This session is open in another window.');
    assert.strictEqual(provider.mcpWrites.length, 0);
  });

  test('remove records a removed change', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    const panel = await handle({ t: 'mcp-remove', id: a.state.id, name: 'shadcn', origin: 'repo' });
    assert.deepStrictEqual(panel.pending, [{ name: 'shadcn', origin: 'repo', change: 'removed' }]);
  });

  test('reconnect on a per-server capability calls the run', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    await handle({ t: 'mcp-reconnect', id: a.state.id, name: 'shadcn' });
    assert.deepStrictEqual(provider.mcpReconnects, ['shadcn']);
    assert.strictEqual(provider.starts.length, 1);
  });

  test('reconnect on a restart capability restarts the session', async () => {
    const { manager, provider, cwd, handle } = await setup();
    provider.mcpConfig.capabilities.reconnect = 'restart';
    const a = await manager.create('fake', cwd);
    await handle({ t: 'mcp-reconnect', id: a.state.id, name: 'shadcn' });
    await settle();
    assert.deepStrictEqual(provider.mcpReconnects, []);
    assert.strictEqual(provider.starts.length, 2);
  });

  test('sign-in opens the authorization url', async () => {
    const { manager, cwd, handle, opened } = await setup();
    const a = await manager.create('fake', cwd);
    await handle({ t: 'mcp-sign-in', id: a.state.id, name: 'shadcn' });
    assert.deepStrictEqual(opened, ['https://auth.example/shadcn']);
  });

  test('restart-session rebuilds and clears pending once the new run has loaded', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    await handle({ t: 'mcp-add', id: a.state.id, scope: 'repo', server: SPEC });
    provider.mcpLoadedAt = Number.MAX_SAFE_INTEGER;
    const panel = await handle({ t: 'restart-session', id: a.state.id });
    await settle();
    assert.strictEqual(provider.starts.length, 2);
    assert.deepStrictEqual(panel.pending, []);
    assert.strictEqual(panel.restarting, false);
  });

  test('the host refuses an invalid name even if the client did not check', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    const panel = await handle({ t: 'mcp-add', id: a.state.id, scope: 'repo', server: { ...SPEC, name: 'bad]name' } });
    assert.strictEqual(typeof panel.error, 'string');
    assert.strictEqual(provider.mcpWrites.length, 0);
  });

  test('two restarts at once build one new run, not two', async () => {
    const { manager, provider, cwd } = await setup();
    const a = await manager.create('fake', cwd);
    // A real git spawn per call would let the second land after the first finished: a legitimate second restart.
    const service = new McpService(manager, new McpChangeLog(), 1000, async (c) => c);
    await Promise.all([
      service.handle({ t: 'restart-session', id: a.state.id }, () => {}),
      service.handle({ t: 'restart-session', id: a.state.id }, () => {}),
    ]);
    await settle();
    assert.strictEqual(provider.starts.length, 2);
  });

  test('a repo-root lookup that throws becomes panel.error, not a rejection', async () => {
    const { manager, cwd } = await setup();
    const a = await manager.create('fake', cwd);
    const service = new McpService(manager, new McpChangeLog(), 1000, async () => { throw new Error('git exploded'); });
    const panel = await service.handle({ t: 'mcp-open', id: a.state.id }, () => {});
    assert.strictEqual(panel.error, 'git exploded');
  });

  test('restart of a foreign session says why instead of doing nothing', async () => {
    const { manager, provider, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    manager.isForeign = () => true;
    const panel = await handle({ t: 'restart-session', id: a.state.id });
    assert.strictEqual(panel.error, 'This session is open in another window.');
    assert.strictEqual(provider.starts.length, 1);
  });

  test('a second restart mid-rebuild says already restarting, not not running', async () => {
    let live = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new FakeProvider(() => []);
    const host = {
      get: () => (live ? ({ configLoadedAt: () => undefined } as never) : undefined),
      mcpContext: () => ({ cwd: '/x', provider }),
      isForeign: () => false,
      restart: async () => { live = false; await gate; live = true; },
    };
    const service = new McpService(host, new McpChangeLog(), 1000, async (c) => c);
    const first = service.handle({ t: 'restart-session', id: 's' }, () => {});
    await settle();
    const second = await service.handle({ t: 'restart-session', id: 's' }, () => {});
    assert.strictEqual(second.error, 'This session is already restarting.');
    release();
    await first;
  });

  test('restart of a session with no live run says it is not running', async () => {
    const { manager, cwd, handle } = await setup();
    const a = await manager.create('fake', cwd);
    manager.get = () => undefined;
    const panel = await handle({ t: 'restart-session', id: a.state.id });
    assert.strictEqual(panel.error, "This session isn't running.");
  });

  test('unknown session answers an empty read-only panel', async () => {
    const { handle } = await setup();
    const panel = await handle({ t: 'mcp-open', id: 'nope' });
    assert.deepStrictEqual([panel.capabilities, panel.targets, panel.pending.length], [null, null, 0]);
  });
});

suite('resolveRepoRoot', () => {
  test('outside a repo answers the cwd itself', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-norepo-'));
    try {
      assert.strictEqual(await resolveRepoRoot(dir), dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite('MCP status budgets', () => {
  test('the probe poll gives up well before the service times out', () => {
    assert.strictEqual(typeof MCP_POLL_BUDGET_MS, 'number');
    assert.strictEqual(MCP_POLL_BUDGET_MS + 3000 <= MCP_STATUS_TIMEOUT_MS, true);
  });

  test('a probe still pending when the budget runs out answers its pending rows', async () => {
    let asks = 0;
    const query = { mcpServerStatus: async () => { asks++; return [{ name: 'slow', status: 'pending' }]; } };
    const started = Date.now();
    const servers = await settledMcpStatus(query as never, 200, 20);
    assert.strictEqual(Date.now() - started < 1000, true);
    assert.deepStrictEqual(servers, [{ name: 'slow', status: 'pending' }]);
    assert.strictEqual(asks > 1, true);
  });
});

suite('McpChangeLog', () => {
  test('a # in the file path does not leak a per-repo change to another repo', () => {
    const log = new McpChangeLog();
    log.record({ file: '/x/a#b/.claude.json', scope: '/repoA' }, 'a', 'repo-private', 'removed', 10);
    assert.deepStrictEqual(log.pendingFor([{ file: '/x/a#b/.claude.json', scope: '/repoB' }], 5), []);
    assert.deepStrictEqual(
      log.pendingFor([{ file: '/x/a#b/.claude.json', scope: '/repoA' }], 5),
      [{ name: 'a', origin: 'repo-private', change: 'removed' }],
    );
  });

  test('treats E:\\x and e:\\x as the same file on win32', function () {
    if (process.platform !== 'win32') { this.skip(); }
    const log = new McpChangeLog();
    log.record({ file: 'E:\\x\\.mcp.json' }, 'a', 'repo', 'added', 10);
    assert.deepStrictEqual(log.pendingFor([{ file: 'e:/x/.mcp.json' }], 5), [{ name: 'a', origin: 'repo', change: 'added' }]);
  });

  test('changes older than the load are not pending', () => {
    const log = new McpChangeLog();
    log.record({ file: '/x/.mcp.json' }, 'a', 'repo', 'added', 10);
    assert.deepStrictEqual(log.pendingFor([{ file: '/x/.mcp.json' }], 20), []);
    assert.deepStrictEqual(log.pendingFor([{ file: '/x/.mcp.json' }], undefined), []);
  });

  test('add then remove of the same name cancels out', () => {
    const log = new McpChangeLog();
    log.record({ file: '/x/.mcp.json' }, 'a', 'repo', 'added', 10);
    log.record({ file: '/x/.mcp.json' }, 'a', 'repo', 'removed', 11);
    assert.deepStrictEqual(log.pendingFor([{ file: '/x/.mcp.json' }], 5), []);
  });
});
