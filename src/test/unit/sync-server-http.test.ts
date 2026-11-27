import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { encodeCode } from '../../sync/pairing-code';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';
import { generateDeviceKeys } from '../../sync/crypto';

const PK = generateDeviceKeys().publicKey;

interface Rig { url: string; store: SyncStore; code: string; clock: { now: number }; close(): Promise<void> }
const rigs: Rig[] = [];

async function rig(): Promise<Rig> {
  const clock = { now: 1_000_000 };
  const store = new SyncStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-http-')), 's.sqlite'), () => clock.now);
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  const server = await startSyncServer({ store, host: '127.0.0.1', port: 0, now: () => clock.now });
  const r = { url: server.url, store, code: encodeCode('MRB', bytes), clock, close: async () => { await server.close(); store.close(); } };
  rigs.push(r);
  return r;
}

teardown(async () => { while (rigs.length) { await rigs.pop()!.close(); } });

async function call(r: Rig, method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${r.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function enroll(r: Rig): Promise<{ deviceId: string; token: string }> {
  const res = await call(r, 'POST', '/v1/bootstrap', { code: r.code, name: 'desk', publicKey: PK });
  assert.strictEqual(res.status, 200);
  return res.json;
}

async function second(r: Rig, token: string): Promise<{ deviceId: string; token: string }> {
  await call(r, 'POST', '/v1/pairings', { pairingId: 'p-second', wrapped: 'blob', ttlSec: 600 }, token);
  return (await call(r, 'POST', '/v1/pairings/p-second/claim', { name: 'laptop', publicKey: PK })).json;
}

async function* events(r: Rig, token: string, signal: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${r.url}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal });
  const reader = res.body!.getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { return; }
    buffer += Buffer.from(value).toString();
    let at: number;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (!frame.startsWith(':')) { yield frame; }
    }
  }
}

suite('sync server HTTP', () => {
  test('info reports enrollment, and the bootstrap code works exactly once', async () => {
    const r = await rig();
    assert.deepStrictEqual((await call(r, 'GET', '/v1/info')).json, { apiVersion: 1, enrolled: false });
    assert.strictEqual((await call(r, 'POST', '/v1/bootstrap', { code: encodeCode('MRB', randomBytes(16)), name: 'x', publicKey: PK })).status, 403);
    await enroll(r);
    assert.strictEqual((await call(r, 'POST', '/v1/bootstrap', { code: r.code, name: 'x', publicKey: PK })).status, 403);
    assert.deepStrictEqual((await call(r, 'GET', '/v1/info')).json, { apiVersion: 1, enrolled: true });
  });

  test('authenticated routes refuse a missing or unknown token', async () => {
    const r = await rig();
    await enroll(r);
    assert.strictEqual((await call(r, 'GET', '/v1/devices')).status, 401);
    assert.strictEqual((await call(r, 'GET', '/v1/devices', undefined, 'nope')).status, 401);
  });

  test('a pairing is claimed once and not after it expires', async () => {
    const r = await rig();
    const a = await enroll(r);
    assert.strictEqual((await call(r, 'POST', '/v1/pairings', { pairingId: 'p1', wrapped: 'blob', ttlSec: 600 }, a.token)).status, 204);
    const claim = await call(r, 'POST', '/v1/pairings/p1/claim', { name: 'laptop', publicKey: PK });
    assert.strictEqual(claim.status, 200);
    assert.strictEqual(claim.json.wrapped, 'blob');
    assert.strictEqual(typeof claim.json.token, 'string');
    assert.strictEqual((await call(r, 'POST', '/v1/pairings/p1/claim', { name: 'evil', publicKey: PK })).status, 410);
    await call(r, 'POST', '/v1/pairings', { pairingId: 'p2', wrapped: 'blob', ttlSec: 900 }, a.token);
    r.clock.now += 901_000;
    assert.strictEqual((await call(r, 'POST', '/v1/pairings/p2/claim', { name: 'late', publicKey: PK })).status, 410);
    assert.strictEqual((await call(r, 'POST', '/v1/pairings', { pairingId: 'p3', wrapped: 'b', ttlSec: 5000 }, a.token)).status, 400);
  });

  test('records get server seqs, and a retried push is stored once', async () => {
    const r = await rig();
    const a = await enroll(r);
    const rec = (id: string) => ({ recordId: id, epoch: 1, nonce: 'n', ciphertext: 'c' });
    const first = await call(r, 'POST', '/v1/records', { records: [rec('r1'), rec('r2')] }, a.token);
    assert.deepStrictEqual(first.json.assigned.map((x: { seq: number }) => x.seq), [1, 2]);
    const retry = await call(r, 'POST', '/v1/records', { records: [rec('r1'), rec('r2'), rec('r3')] }, a.token);
    assert.deepStrictEqual(retry.json.assigned.map((x: { seq: number }) => x.seq), [1, 2, 3]);
    const page = await call(r, 'GET', `/v1/streams/${a.deviceId}?after=1&limit=10`, undefined, a.token);
    assert.deepStrictEqual(page.json.records.map((x: { seq: number }) => x.seq), [2, 3]);
    assert.deepStrictEqual((await call(r, 'GET', '/v1/streams', undefined, a.token)).json.streams, [{ deviceId: a.deviceId, lastSeq: 3 }]);
  });

  test('a body over the request limit is answered with 413, not a dropped connection', async () => {
    const r = await rig();
    const a = await enroll(r);
    const records = Array.from({ length: 10 }, (_, i) => ({ recordId: `r${i}`, epoch: 1, nonce: 'n', ciphertext: 'x'.repeat(900 * 1024) }));
    assert.strictEqual((await call(r, 'POST', '/v1/records', { records }, a.token)).status, 413);
  });

  test('an oversized record is refused with 413', async () => {
    const r = await rig();
    const a = await enroll(r);
    const big = { recordId: 'big', epoch: 1, nonce: 'n', ciphertext: 'x'.repeat(2 * 1024 * 1024) };
    assert.strictEqual((await call(r, 'POST', '/v1/records', { records: [big] }, a.token)).status, 413);
  });

  test('key epochs are create-only, and blobs can be added for missing devices', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    assert.strictEqual((await call(r, 'PUT', '/v1/keys/1', { sealed: { [a.deviceId]: 'sa' }, tag: 'genesis' }, a.token)).status, 204);
    assert.strictEqual((await call(r, 'PUT', '/v1/keys/1', { sealed: { [a.deviceId]: 'other' }, tag: 'genesis' }, a.token)).status, 409);
    assert.strictEqual((await call(r, 'POST', '/v1/keys/7/sealed', { sealed: { [b.deviceId]: 'sb' } }, a.token)).status, 404);
    assert.strictEqual((await call(r, 'POST', '/v1/keys/1/sealed', { sealed: { [b.deviceId]: 'sb' } }, a.token)).status, 204);
    const keysB = await call(r, 'GET', '/v1/keys', undefined, b.token);
    assert.deepStrictEqual(keysB.json.keys, [{ epoch: 1, sealed: 'sb', tag: 'genesis' }]);
    assert.deepStrictEqual(keysB.json.holders, [{ epoch: 1, deviceIds: [a.deviceId, b.deviceId].sort() }]);
  });

  test('another device hears an append on its event stream', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    const abort = new AbortController();
    const stream = events(r, b.token, abort.signal);
    const opened = stream.next();
    await new Promise((res) => setTimeout(res, 50));
    await call(r, 'POST', '/v1/records', { records: [{ recordId: 'r1', epoch: 1, nonce: 'n', ciphertext: 'c' }] }, a.token);
    const frame = (await opened).value as string;
    assert.strictEqual(frame.includes('event: appended'), true);
    assert.strictEqual(frame.includes(`"deviceId":"${a.deviceId}"`), true);
    abort.abort();
  });

  test('a device with an open event stream is online, and goes offline with a devices event when it closes', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    const online = async (): Promise<boolean | undefined> =>
      ((await call(r, 'GET', '/v1/devices', undefined, a.token)).json.devices as Array<{ deviceId: string; online?: boolean }>)
        .find((d) => d.deviceId === b.deviceId)?.online;
    assert.strictEqual(await online(), false);
    const watchA = new AbortController();
    const aFrames = events(r, a.token, watchA.signal);
    const cameOnline = aFrames.next();
    await new Promise((res) => setTimeout(res, 50));
    const bAbort = new AbortController();
    const bStream = events(r, b.token, bAbort.signal);
    void bStream.next().catch(() => undefined);
    await new Promise((res) => setTimeout(res, 80));
    assert.strictEqual(await online(), true);
    assert.strictEqual(((await cameOnline).value as string).includes('event: devices'), true);
    r.clock.now += 5000;
    const next = aFrames.next();
    bAbort.abort();
    const frame = (await Promise.race([next, new Promise((res) => setTimeout(() => res({ value: 'timeout' }), 1000))]) as { value: string }).value;
    assert.strictEqual(frame.includes('event: devices'), true);
    assert.strictEqual(await online(), false);
    const row = ((await call(r, 'GET', '/v1/devices', undefined, a.token)).json.devices as Array<{ deviceId: string; lastSeenAt: number }>)
      .find((d) => d.deviceId === b.deviceId)!;
    assert.strictEqual(row.lastSeenAt >= r.clock.now, true);
    watchA.abort();
  });

  test('a device stays online while one of its two streams is still open', async () => {
    const r = await rig();
    const a = await enroll(r);
    const one = new AbortController();
    const two = new AbortController();
    void events(r, a.token, one.signal).next().catch(() => undefined);
    void events(r, a.token, two.signal).next().catch(() => undefined);
    await new Promise((res) => setTimeout(res, 80));
    one.abort();
    await new Promise((res) => setTimeout(res, 80));
    const me = ((await call(r, 'GET', '/v1/devices', undefined, a.token)).json.devices as Array<{ online?: boolean }>)[0];
    assert.strictEqual(me.online, true);
    two.abort();
  });

  test('owner claims are compare-and-swap: one winner per epoch', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    const first = await call(r, 'PUT', '/v1/owners/k1', { epoch: 1, expect: 0, baseRev: 4 }, a.token);
    assert.deepStrictEqual([first.status, first.json.deviceId, first.json.epoch, first.json.baseRev], [200, a.deviceId, 1, 4]);
    const stale = await call(r, 'PUT', '/v1/owners/k1', { epoch: 1, expect: 0, baseRev: 0 }, b.token);
    assert.deepStrictEqual([stale.status, stale.json.deviceId, stale.json.epoch], [409, a.deviceId, 1]);
    assert.strictEqual((await call(r, 'PUT', '/v1/owners/k1', { epoch: 5, expect: 1, baseRev: 0 }, b.token)).status, 400);
    const racers = await Promise.all([a.token, b.token].map((t) => call(r, 'PUT', '/v1/owners/k2', { epoch: 1, expect: 0, baseRev: 0 }, t)));
    assert.deepStrictEqual(racers.map((x) => x.status).sort(), [200, 409]);
    const list = (await call(r, 'GET', '/v1/owners', undefined, b.token)).json.owners as Array<{ key: string }>;
    assert.deepStrictEqual(list.map((o) => o.key).sort(), ['k1', 'k2']);
  });

  test('another device hears an owners event when a claim lands', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    const abort = new AbortController();
    const stream = events(r, b.token, abort.signal);
    const next = stream.next();
    await new Promise((res) => setTimeout(res, 50));
    await call(r, 'PUT', '/v1/owners/k1', { epoch: 1, expect: 0, baseRev: 0 }, a.token);
    assert.strictEqual(((await next).value as string).includes('event: owners'), true);
    abort.abort();
  });

  test('a revoked device is refused everywhere and its event stream ends', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    const stream = events(r, b.token, new AbortController().signal);
    const ended = (async () => { for await (const _ of stream) { /* drain */ } return true; })();
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual((await call(r, 'POST', `/v1/devices/${b.deviceId}/revoke`, undefined, a.token)).status, 204);
    assert.strictEqual(await Promise.race([ended, new Promise((res) => setTimeout(() => res(false), 1000))]), true);
    assert.strictEqual((await call(r, 'GET', '/v1/devices', undefined, b.token)).status, 401);
    assert.strictEqual((await call(r, 'GET', '/v1/events', undefined, b.token)).status, 401);
  });

  test('a malformed claim or bootstrap does not spend the one-time secret', async () => {
    const r = await rig();
    const bad = await call(r, 'POST', '/v1/bootstrap', { code: r.code, name: 'desk', publicKey: 'not-a-key' });
    assert.strictEqual(bad.status, 400);
    const a = await enroll(r);
    await call(r, 'POST', '/v1/pairings', { pairingId: 'p1', wrapped: 'blob', ttlSec: 600 }, a.token);
    assert.strictEqual((await call(r, 'POST', '/v1/pairings/p1/claim', {})).status, 400);
    assert.strictEqual((await call(r, 'POST', '/v1/pairings/p1/claim', { name: 'laptop', publicKey: PK })).status, 200);
  });

  test('a pairing made by a device that was then revoked cannot be claimed', async () => {
    const r = await rig();
    const a = await enroll(r);
    const b = await second(r, a.token);
    await call(r, 'POST', '/v1/pairings', { pairingId: 'p-thief', wrapped: 'blob', ttlSec: 600 }, b.token);
    await call(r, 'POST', `/v1/devices/${b.deviceId}/revoke`, undefined, a.token);
    assert.strictEqual((await call(r, 'POST', '/v1/pairings/p-thief/claim', { name: 'thief', publicKey: PK })).status, 410);
  });
});
