import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import { connectOrSpawn, type ConnectOptions } from '../../daemon-client/connect-or-spawn';
import { acquireSpawnLock } from '../../daemon-client/spawn-lock';
import { defaultHostConfig } from '../../host/host-config';

suite('daemon client: spawn lock lifetime', function () {
  this.timeout(30000);
  let dir: string;
  let daemons: RunningDaemon[];
  const lockFile = () => path.join(dir, 'daemon.lock');
  const opts = (spawn: () => Promise<void>, timeoutMs?: number): ConnectOptions => ({
    workspaceDir: dir, clientKind: 'tui', roots: [dir], defaultCwd: dir,
    identity: { protocolVersion: 1, appVersion: '9.9.9' }, hooks: {}, spawn, timeoutMs,
  });

  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dcl-lock-')); daemons = []; });
  teardown(async () => {
    for (const d of daemons) { await d.stop(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a spawn that never answers in time keeps the lock, so a second client cannot spawn a rival', async () => {
    const r = await connectOrSpawn(opts(async () => {}, 500));
    assert.strictEqual(r.kind, 'fallback');
    assert.strictEqual(fs.existsSync(lockFile()), true);
    assert.strictEqual(await acquireSpawnLock(dir), undefined);
  });

  test('a successful attach releases the lock', async () => {
    const r = await connectOrSpawn(opts(async () => {
      daemons.push(await runDaemon({
        workspaceDir: dir, appVersion: '9.9.9', initialRoots: [dir], idleMsOverride: 600_000,
        config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      }));
    }));
    if (r.kind === 'attached') { r.client.close(); }
    assert.strictEqual(r.kind, 'attached');
    assert.strictEqual(fs.existsSync(lockFile()), false);
  });

  test('a spawn that throws releases the lock: nothing is booting', async () => {
    const r = await connectOrSpawn(opts(async () => { throw new Error('no binary'); }));
    assert.strictEqual(r.kind === 'fallback' && r.reason, 'spawn-failed');
    assert.strictEqual(fs.existsSync(lockFile()), false);
  });
});
