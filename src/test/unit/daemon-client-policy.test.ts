import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from '../../daemon-client/discover';
import { acquireSpawnLock } from '../../daemon-client/spawn-lock';
import { decideAttach } from '../../daemon-client/version-policy';
import { writeDaemonInfo } from '../../daemon/daemon-info';

suite('daemon client policy', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-dcp-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const info = (pid: number) => ({ pid, endpoint: 'e', token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 });
  const lockFile = () => path.join(dir, 'daemon.lock');

  test('discover returns a live daemon and ignores a dead pid', async () => {
    await writeDaemonInfo(dir, info(111));
    assert.strictEqual((await discover(dir, () => true))?.pid, 111);
    assert.strictEqual(await discover(dir, () => false), undefined);
  });

  test('discover is undefined when there is no daemon.json', async () => {
    assert.strictEqual(await discover(dir), undefined);
  });

  test('only one of two concurrent callers gets the spawn lock', async () => {
    const [a, b] = await Promise.all([acquireSpawnLock(dir), acquireSpawnLock(dir)]);
    assert.strictEqual([a, b].filter(Boolean).length, 1);
    await (a ?? b)?.();
    assert.strictEqual(typeof (await acquireSpawnLock(dir)), 'function');
  });

  test('a lock held by a dead pid, or older than staleMs, is taken over', async () => {
    await fs.writeFile(lockFile(), JSON.stringify({ pid: 999, at: Date.now() }));
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { pidAlive: () => false })), 'function');
    await fs.writeFile(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { staleMs: 30_000, pidAlive: () => true })), 'function');
  });

  test('an unparsable or empty lock file counts as no live owner', async () => {
    await fs.writeFile(lockFile(), '');
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { pidAlive: () => true })), 'function');
    await fs.writeFile(lockFile(), '{not json');
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { pidAlive: () => true })), 'function');
  });

  test('a fresh lock held by a live pid is refused', async () => {
    await fs.writeFile(lockFile(), JSON.stringify({ pid: 999, at: Date.now() }));
    assert.strictEqual(await acquireSpawnLock(dir, { pidAlive: () => true }), undefined);
  });

  test('release is idempotent and never deletes a lock someone else took over', async () => {
    const release = await acquireSpawnLock(dir);
    assert.strictEqual(typeof release, 'function');
    await release?.();
    await release?.();
    assert.strictEqual(await fs.access(lockFile()).then(() => true, () => false), false);

    const stale = await acquireSpawnLock(dir);
    await fs.writeFile(lockFile(), JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    await stale?.();
    assert.strictEqual(await fs.access(lockFile()).then(() => true, () => false), true);
  });

  test('version policy: equal attaches, older daemon is replaced, newer is never killed', () => {
    assert.strictEqual(decideAttach(1, 1), 'attach');
    assert.strictEqual(decideAttach(1, 2), 'replace');
    assert.strictEqual(decideAttach(3, 2), 'refuse-newer');
  });
});
