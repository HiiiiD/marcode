import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimLease, isStale, readLease, STALE_MS, type LeaseDeps } from '../../host/lease';

function deps(over: Partial<LeaseDeps> = {}): LeaseDeps {
  return { now: () => 1_000_000, pidAlive: () => true, machine: 'm1', ...over };
}

suite('lease', () => {
  let dir: string;
  let file: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-lease-'));
    file = path.join(dir, 's1.lock');
  });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('the first claim wins and a second host sees who owns it', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    assert.strictEqual(a.ok, true);
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(b.ok, false);
    if (!b.ok) { assert.strictEqual(b.owner.host, 'vscode'); assert.strictEqual(b.owner.instance, 'A'); }
  });

  test('two hosts in one process are still different owners', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(b.ok, false);
  });

  test('re-claiming with the same instance is idempotent', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    assert.strictEqual((await claimLease(file, { host: 'vscode', instance: 'A' }, deps())).ok, true);
  });

  test('a lease with an old heartbeat is stale and can be taken over', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ now: () => 0 }));
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ now: () => STALE_MS + 1 }));
    assert.strictEqual(b.ok, true);
    assert.strictEqual((await readLease(file))?.instance, 'B');
  });

  test('a dead pid on this machine is stale immediately', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ pidAlive: () => false }));
    assert.strictEqual(b.ok, true);
  });

  test('a dead-looking pid on another machine is not trusted', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ machine: 'other' }));
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ pidAlive: () => false }));
    assert.strictEqual(b.ok, false);
  });

  test('a corrupt lease file is treated as no owner', async () => {
    await fs.writeFile(file, '{not json');
    assert.strictEqual((await claimLease(file, { host: 'tui', instance: 'B' }, deps())).ok, true);
  });

  test('beat refreshes the heartbeat, and reports false once the lease was taken', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ now: () => 100 }));
    if (!a.ok) { throw new Error('expected a claim'); }
    assert.strictEqual(await a.lease.beat(), true);
    await fs.rm(file);
    await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(await a.lease.beat(), false);
  });

  test('release removes only our own lease', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    if (!a.ok) { throw new Error('expected a claim'); }
    await fs.rm(file);
    await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    await a.lease.release();
    assert.strictEqual((await readLease(file))?.instance, 'B');
  });

  const busy = async (): Promise<string> => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };

  test('a transient read error never steals a live lease', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    await assert.rejects(claimLease(file, { host: 'tui', instance: 'B' }, deps({ readFile: busy })));
    assert.strictEqual((await readLease(file))?.instance, 'A');
  });

  test('a transient read error during a heartbeat is not a lost lease', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ readFile: busy }));
    if (!a.ok) { throw new Error('expected a claim'); }
    await assert.rejects(a.lease.beat());
    assert.strictEqual((await readLease(file))?.instance, 'A');
  });

  test('isStale is a pure function of heartbeat, pid and machine', () => {
    const info = { pid: 1, host: 'tui' as const, instance: 'x', machine: 'm1', heartbeat: 0 };
    assert.strictEqual(isStale(info, deps({ now: () => STALE_MS })), false);
    assert.strictEqual(isStale(info, deps({ now: () => STALE_MS + 1 })), true);
  });
});
