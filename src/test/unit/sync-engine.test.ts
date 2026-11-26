import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { SyncEngine } from '../../host/sync/sync-engine';
import type { SessionDigest } from '../../memory/digest';
import { RemoteMemory } from '../../memory/remote-memory';
import { readCredentials, removeCredentials, writeCredentials } from '../../sync/credentials';
import { encryptRecord } from '../../sync/crypto';
import type { MemoryPayload } from '../../sync/memory-records';
import { encodeCode } from '../../sync/pairing-code';
import { SyncClient } from '../../sync/sync-client';
import { SyncState } from '../../sync/sync-state';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

const until = async (done: () => boolean | Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) { if (Date.now() > deadline) { throw new Error('timed out'); } await new Promise((r) => setTimeout(r, 20)); }
};

interface Device { home: string; deviceId: string; state: SyncState; remote: RemoteMemory; engine(): SyncEngine }

async function world() {
  const store = new SyncStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-engine-srv-')), 's.sqlite'));
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  let server = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
  const url = server.url;
  const port = Number(new URL(url).port);
  let up = true;
  cleanups.push(async () => { if (up) { await server.close(); } store.close(); });

  const device = async (creds: Awaited<ReturnType<typeof SyncClient.enroll>>): Promise<Device> => {
    if (!creds.ok) { throw new Error(creds.error); }
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-engine-home-'));
    await writeCredentials(home, creds.value);
    const state = new SyncState(path.join(home, 'sync', 'state.sqlite'));
    const remote = new RemoteMemory(path.join(home, 'sync', 'remote-memory.sqlite'));
    cleanups.push(() => { state.close(); remote.close(); });
    const engine = () => {
      const e = new SyncEngine({ home, hostKind: 'tui', state, remote, pollMs: 60_000, claimRetryMs: 50, clientOptions: { timeoutMs: 2000 } });
      cleanups.push(() => e.dispose());
      return e;
    };
    return { home, deviceId: creds.value.deviceId, state, remote, engine };
  };
  const a = await device(await SyncClient.enroll(url, encodeCode('MRB', bytes), 'desk'));
  const join = async (name: string) => {
    const code = await new SyncClient((await readCredentials(a.home))!).createPairing();
    if (!code.ok) { throw new Error(code.error); }
    return device(await SyncClient.join(url, code.value.code, name));
  };
  return {
    store, url, a, join,
    stop: async () => { up = false; await server.close(); },
    restart: async () => { server = await startSyncServer({ store, host: '127.0.0.1', port }); up = true; },
  };
}

const digest: SessionDigest = { title: 'Zebra migration', request: 'zebra', outcome: 'done', filesEdited: [], source: 'llm', summarizerVersion: 1, forUpdatedAt: 5 };
const memory = (sessionId: string, text = 'zebra migration plan'): MemoryPayload => ({
  type: 'memory', sessionId, projectId: 'github.com/a/b', relCwd: '.', providerId: 'claude', title: digest.title, closedAt: 9, digest, text,
  items: [{ id: `${sessionId}-u1`, ts: 0, role: 'user', text }],
});
const found = async (d: Device, q = 'zebra') => (await d.remote.search(q, { projectId: 'github.com/a/b', limit: 2000 })).map((h) => h.sessionId);

suite('SyncEngine', function () {
  // Real server round trips and the engine's 2 s push tick.
  this.timeout(30_000);

  test("another device's memory arrives, and a withdraw removes it", async () => {
    const w = await world();
    const b = await w.join('laptop');
    w.a.state.enqueue(memory('s1'));
    const ea = w.a.engine(); ea.start();
    const eb = b.engine(); eb.start();
    await until(async () => (await found(b)).includes('s1'));
    assert.strictEqual((await b.remote.getDigest('s1'))?.title, 'Zebra migration');
    w.a.state.enqueue({ type: 'memory-withdraw', sessionId: 's1' });
    await until(async () => !(await found(b)).includes('s1'));
  });

  test('a device paired later pages through everything', async () => {
    const w = await world();
    for (let i = 0; i < 1200; i++) { w.a.state.enqueue(memory(`s${i}`, `zebra number ${i}`)); }
    const ea = w.a.engine(); ea.start();
    await until(() => w.a.state.outboxSize() === 0, 30_000);
    const b = await w.join('laptop');
    const eb = b.engine(); eb.start();
    await until(() => eb.stats().applied === 1200, 30_000);
    assert.strictEqual((await found(b, 'number')).includes('s0'), true);
  });

  test('unreadable and unknown records are skipped and passed', async () => {
    const w = await world();
    const b = await w.join('laptop');
    const creds = (await readCredentials(w.a.home))!;
    const { epoch, key } = creds.syncKeys[creds.syncKeys.length - 1];
    const future = encryptRecord(Buffer.from(JSON.stringify({ v: 1, payload: { type: 'future', sessionId: 'x' } })), key, { deviceId: creds.deviceId, recordId: 'future', epoch });
    w.store.append(creds.deviceId, [{ recordId: 'future', epoch, ...future }, { recordId: 'junk', epoch, nonce: future.nonce, ciphertext: Buffer.from('garbage').toString('base64') }]);
    w.a.state.enqueue(memory('s1'));
    const ea = w.a.engine(); ea.start();
    const eb = b.engine(); eb.start();
    await until(async () => (await found(b)).includes('s1'));
    assert.strictEqual(eb.stats().skipped, 2);
  });

  test('a withdraw made while the server is down is delivered when it is back', async () => {
    const w = await world();
    const b = await w.join('laptop');
    w.a.state.enqueue(memory('s1'));
    const ea = w.a.engine(); ea.start();
    const eb = b.engine(); eb.start();
    await until(async () => (await found(b)).includes('s1'));
    await w.stop();
    w.a.state.enqueue({ type: 'memory-withdraw', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(w.a.state.outboxSize(), 1);
    await w.restart();
    await until(() => w.a.state.outboxSize() === 0);
    await until(async () => !(await found(b)).includes('s1'));
  });

  test('an oversized record is dropped and the ones behind it still arrive', async () => {
    const w = await world();
    const b = await w.join('laptop');
    w.a.state.enqueue({ ...memory('big'), text: 'q'.repeat(3 * 1024 * 1024) });
    w.a.state.enqueue(memory('s1'));
    const ea = w.a.engine(); ea.start();
    const eb = b.engine(); eb.start();
    await until(async () => (await found(b)).includes('s1'));
    assert.strictEqual(ea.stats().skipped, 1);
    assert.strictEqual(w.a.state.outboxSize(), 0);
  });

  test('a key rotated by a revoke is used for the very next record', async () => {
    const w = await world();
    const c = await w.join('tower');
    const ea = w.a.engine(); ea.start();
    await until(() => ea.stats().holding);
    const rotated = await new SyncClient((await readCredentials(w.a.home))!).revoke(c.deviceId);
    assert.strictEqual(rotated.ok, true);
    if (rotated.ok) { await writeCredentials(w.a.home, rotated.value); }
    w.a.state.enqueue(memory('after'));
    await until(() => w.a.state.outboxSize() === 0);
    const rows = w.store.read(w.a.deviceId, 0, 10);
    assert.strictEqual(rows.at(-1)?.epoch, 2);
  });

  test('without credentials the engine stops', async () => {
    const w = await world();
    const ea = w.a.engine(); ea.start();
    await until(() => ea.stats().holding);
    await removeCredentials(w.a.home);
    w.a.state.enqueue(memory('s1'));
    await until(() => !ea.stats().holding);
  });

  test('one engine per machine, and another takes over when it goes', async () => {
    const w = await world();
    const first = w.a.engine(); first.start();
    const second = w.a.engine(); second.start();
    await until(() => first.stats().holding || second.stats().holding);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(first.stats().holding && second.stats().holding, false);
    const holder = first.stats().holding ? first : second;
    const other = holder === first ? second : first;
    await holder.dispose();
    await until(() => other.stats().holding);
  });

  test('a restarted engine resumes from its cursors', async () => {
    const w = await world();
    const b = await w.join('laptop');
    w.a.state.enqueue(memory('s1'));
    const ea = w.a.engine(); ea.start();
    const eb = b.engine(); eb.start();
    await until(() => eb.stats().applied === 1);
    await eb.dispose();
    w.a.state.enqueue(memory('s2'));
    await until(() => w.a.state.outboxSize() === 0);
    const again = b.engine(); again.start();
    await until(async () => (await found(b)).includes('s2'));
    assert.strictEqual(again.stats().applied, 1);
  });
});
