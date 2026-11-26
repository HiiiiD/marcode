import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import type { SyncEvent } from '../../sync/api-types';
import { readCredentials, writeCredentials, credentialsPath } from '../../sync/credentials';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { admissionTag, encryptRecord, epochTag, generateDeviceKeys, generateSyncKey, seal } from '../../sync/crypto';
import { decodePairingCode, encodePairingCode } from '../../sync/pairing-code';
import { encodeCode } from '../../sync/pairing-code';
import { SyncClient, type SyncCredentials } from '../../sync/sync-client';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';

interface Rig { url: string; port: number; store: SyncStore; code: string; stopServer(): Promise<void>; restart(): Promise<void> }
const cleanups: Array<() => Promise<void>> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

async function rig(): Promise<Rig> {
  const store = new SyncStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-client-')), 's.sqlite'));
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  let server = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
  const port = Number(new URL(server.url).port);
  const r: Rig = {
    url: server.url, port, store, code: encodeCode('MRB', bytes),
    stopServer: () => server.close(),
    restart: async () => { server = await startSyncServer({ store, host: '127.0.0.1', port }); },
  };
  cleanups.push(async () => { await server.close(); store.close(); });
  return r;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) { throw new Error(result.error); }
  return result.value;
}

async function enrolled(r: Rig): Promise<SyncClient> {
  return new SyncClient(ok(await SyncClient.enroll(r.url, r.code, 'desk')));
}

async function joined(r: Rig, by: SyncClient, name: string): Promise<SyncClient> {
  const { code } = ok(await by.createPairing());
  return new SyncClient(ok(await SyncClient.join(r.url, code, name)));
}

const until = async (done: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) { throw new Error('timed out'); }
    await new Promise((res) => setTimeout(res, 10));
  }
};

suite('SyncClient', () => {
  test('enroll, pair and join leave both devices with the same keys', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const b = await joined(r, a, 'laptop');
    assert.deepStrictEqual(b.credentials.syncKeys, a.credentials.syncKeys);
    assert.deepStrictEqual(ok(await a.devices()).map((d) => d.name).sort(), ['desk', 'laptop']);
  });

  test('a pushed payload comes back decrypted on another device', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const b = await joined(r, a, 'laptop');
    ok(await a.push([{ x: 1 }, { x: 2 }]));
    const pulled = ok(await b.pull(a.credentials.deviceId, 0));
    assert.deepStrictEqual(pulled.map((p) => p.payload), [{ x: 1 }, { x: 2 }]);
    assert.deepStrictEqual(pulled.map((p) => p.seq), [1, 2]);
  });

  test('two hosts sharing one device credentials both keep every record', async () => {
    const r = await rig();
    const a1 = await enrolled(r);
    const a2 = new SyncClient(a1.credentials);
    const b = await joined(r, a1, 'laptop');
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => a1.push([{ from: 'a1', i }])),
      ...Array.from({ length: 20 }, (_, i) => a2.push([{ from: 'a2', i }])),
    ]);
    const pulled = ok(await b.pull(a1.credentials.deviceId, 0, 500));
    assert.strictEqual(new Set(pulled.map((p) => JSON.stringify(p.payload))).size, 40);
  });

  test('a push whose reply was lost is retried and stored once', async () => {
    const r = await rig();
    const seed = await enrolled(r);
    let dropped = false;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!dropped && String(input).endsWith('/v1/records')) { dropped = true; throw new Error('socket hang up'); }
      return res;
    };
    const a = new SyncClient(seed.credentials, { fetch: lossy });
    ok(await a.push([{ x: 1 }, { x: 2 }]));
    assert.strictEqual(dropped, true);
    assert.deepStrictEqual(r.store.streams(), [{ deviceId: a.credentials.deviceId, lastSeq: 2 }]);
  });

  test('a tampered record and a newer-format record are unreadable, their neighbours are not', async () => {
    const r = await rig();
    const a = await enrolled(r);
    ok(await a.push([{ x: 1 }, { x: 2 }]));
    const { key, epoch } = a.credentials.syncKeys[a.credentials.syncKeys.length - 1];
    const v2 = encryptRecord(Buffer.from(JSON.stringify({ v: 2, payload: 'future' })), key, { deviceId: a.credentials.deviceId, recordId: 'future', epoch });
    r.store.append(a.credentials.deviceId, [{ recordId: 'future', epoch, ...v2 }]);
    const rows = r.store.read(a.credentials.deviceId, 0, 10);
    const flipped = Buffer.from(rows[0].ciphertext, 'base64');
    flipped[0] ^= 1;
    r.store.append(a.credentials.deviceId, [{ recordId: 'tampered', epoch, nonce: rows[0].nonce, ciphertext: flipped.toString('base64') }]);
    const pulled = ok(await a.pull(a.credentials.deviceId, 0));
    assert.deepStrictEqual(pulled.map((p) => (p.unreadable ? 'x' : p.payload)), [{ x: 1 }, { x: 2 }, 'x', 'x']);
  });

  test('revoking rotates the key; a later device reads new records; the revoked one is refused', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const b = await joined(r, a, 'laptop');
    ok(await a.revoke(b.credentials.deviceId));
    assert.deepStrictEqual(a.credentials.syncKeys.map((k) => k.epoch), [1, 2]);
    const c = await joined(r, a, 'tower');
    ok(await a.push([{ after: 'rotation' }]));
    assert.deepStrictEqual(ok(await c.pull(a.credentials.deviceId, 0)).map((p) => p.payload), [{ after: 'rotation' }]);
    const refused = await b.devices();
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(!refused.ok && /revoked/i.test(refused.error), true);
  });

  test('two devices revoking at once still converge on one newest key', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const b = await joined(r, a, 'laptop');
    const c = await joined(r, a, 'tower');
    const d = await joined(r, a, 'nas');
    await Promise.all([a.revoke(c.credentials.deviceId), b.revoke(d.credentials.deviceId)]);
    ok(await a.healKeys());
    ok(await b.healKeys());
    const newest = (x: SyncClient) => x.credentials.syncKeys[x.credentials.syncKeys.length - 1];
    assert.deepStrictEqual(newest(a), newest(b));
    ok(await a.push([{ from: 'a' }]));
    ok(await b.push([{ from: 'b' }]));
    assert.deepStrictEqual(ok(await b.pull(a.credentials.deviceId, 0)).map((p) => p.payload), [{ from: 'a' }]);
    assert.deepStrictEqual(ok(await a.pull(b.credentials.deviceId, 0)).map((p) => p.payload), [{ from: 'b' }]);
    const holders = r.store.holders().find((h) => h.epoch === newest(a).epoch)!.deviceIds;
    assert.strictEqual(holders.includes(c.credentials.deviceId) || holders.includes(d.credentials.deviceId), false);
  });

  test('follow hears appends and survives a server restart', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const b = await joined(r, a, 'laptop');
    const seen: SyncEvent[] = [];
    const follower = b.follow((e) => seen.push(e));
    cleanups.push(async () => follower.stop());
    await until(() => seen.some((e) => e.type === 'connection' && e.state === 'open'));
    ok(await a.push([{ x: 1 }]));
    await until(() => seen.some((e) => e.type === 'appended'));
    await r.stopServer();
    await until(() => seen.some((e) => e.type === 'connection' && e.state === 'retrying'));
    await r.restart();
    const opens = () => seen.filter((e) => e.type === 'connection' && e.state === 'open').length;
    await until(() => opens() >= 2);
    ok(await a.push([{ x: 2 }]));
    await until(() => seen.filter((e) => e.type === 'appended').length >= 2);
  });

  test('a public http server address is refused before any request', async () => {
    const res = await SyncClient.enroll('http://sync.example.com', 'MRB-X', 'desk');
    assert.strictEqual(res.ok, false);
  });
});

suite('sync credentials', () => {
  test('round-trip, and the file is private to its owner', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-home-'));
    const creds: SyncCredentials = {
      server: 'https://s', deviceId: 'd', deviceName: 'desk', token: 't',
      keys: { publicKey: 'p', privateKey: 'k' }, syncKeys: [{ epoch: 1, key: 'x' }],
    };
    await writeCredentials(home, creds);
    assert.deepStrictEqual(await readCredentials(home), creds);
    if (process.platform !== 'win32') {
      assert.strictEqual((await fs.stat(credentialsPath(home))).mode & 0o777, 0o600);
    }
  });
});

async function silentServer(mode: 'never-respond' | 'idle-stream'): Promise<string> {
  const server = createServer((req, res) => {
    if (mode === 'idle-stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise((res) => server.close(() => res(undefined))); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const fakeCreds = (server: string): SyncCredentials => ({
  server, deviceId: 'd', deviceName: 'desk', token: 't', keys: generateDeviceKeys(), syncKeys: [{ epoch: 1, key: generateSyncKey() }],
});

suite('SyncClient against a hostile or broken server', () => {
  test('an old sealed key relabelled as a new epoch is not adopted', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const blob = r.store.keysFor(a.credentials.deviceId)[0].sealed;
    r.store.createEpoch(2, { [a.credentials.deviceId]: blob }, 'tag');
    ok(await a.refreshKeys());
    assert.deepStrictEqual(a.credentials.syncKeys.map((k) => k.epoch), [1]);
  });

  test('a key epoch the server made up is not adopted', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const serverKey = generateSyncKey();
    const id = a.credentials.deviceId;
    r.store.createEpoch(2, { [id]: seal(Buffer.from(serverKey), a.credentials.keys.publicKey, `epoch:2:device:${id}`) }, epochTag(generateSyncKey(), 2, serverKey));
    ok(await a.refreshKeys());
    assert.deepStrictEqual(a.credentials.syncKeys.map((k) => k.epoch), [1]);
  });

  test('a device row the server added on its own gets no keys', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const laptop = await joined(r, a, 'laptop');
    const evil = r.store.addDevice('evil', generateDeviceKeys().publicKey, 'evil-token-hash');
    ok(await a.healKeys());
    ok(await a.revoke(laptop.credentials.deviceId));
    assert.deepStrictEqual(r.store.keysFor(evil.deviceId), []);
  });

  test('an admitted device with a malformed public key is skipped, not thrown on', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const bad = r.store.addDevice('bad', 'not-a-key', 'bad-token-hash');
    const { epoch, key } = a.credentials.syncKeys[0];
    r.store.setAdmission(bad.deviceId, epoch, admissionTag(key, bad.deviceId, 'not-a-key'));
    assert.strictEqual((await a.healKeys()).ok, true);
    assert.strictEqual((await a.rotateKey()).ok, true);
  });

  test('enroll survives a failed key upload, and healing uploads it later', async () => {
    const r = await rig();
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/v1/keys/1') && init?.method === 'PUT') { throw new Error('connection reset'); }
      return fetch(input, init);
    };
    const creds = ok(await SyncClient.enroll(r.url, r.code, 'desk', { fetch: flaky }));
    assert.deepStrictEqual(r.store.holders(), []);
    ok(await new SyncClient(creds).healKeys());
    assert.deepStrictEqual(r.store.holders(), [{ epoch: 1, deviceIds: [creds.deviceId] }]);
  });

  test('joining with a mistyped secret leaves no live device behind', async () => {
    const r = await rig();
    const a = await enrolled(r);
    const { code } = ok(await a.createPairing());
    const wrong = encodePairingCode(decodePairingCode(code)!.pairingId, randomBytes(16));
    assert.strictEqual((await SyncClient.join(r.url, wrong, 'laptop')).ok, false);
    assert.deepStrictEqual(r.store.devices().filter((d) => d.revokedAt === undefined).map((d) => d.name), ['desk']);
  });

  test('a server that never answers times a request out', async () => {
    const url = await silentServer('never-respond');
    const client = new SyncClient(fakeCreds(url), { timeoutMs: 200 });
    const started = Date.now();
    assert.strictEqual((await client.devices()).ok, false);
    assert.strictEqual(Date.now() - started < 2000, true);
  });

  test('an event stream that goes silent is dropped and retried', async () => {
    const url = await silentServer('idle-stream');
    const seen: SyncEvent[] = [];
    const follower = new SyncClient(fakeCreds(url), { idleMs: 200 }).follow((e) => seen.push(e));
    cleanups.push(async () => follower.stop());
    await until(() => seen.some((e) => e.type === 'connection' && e.state === 'retrying'), 3000);
  });
});

