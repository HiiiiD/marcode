import { randomBytes } from 'node:crypto';
import type { DeviceRow, ServedRecord, SyncEvent } from './api-types';
import type { SyncCredentials } from './credentials';
import {
  admissionTag, decryptRecord, encryptRecord, epochTag, generateDeviceKeys, generateSyncKey, unwrapWithSecret, wrapWithSecret,
} from './crypto';
import { readEvents } from './event-stream';
import { isUnreachable, request, type Reply } from './http';
import { acceptEpochs, GENESIS_TAG, isAdmitted, newestKey, trySeal, type SyncKey } from './keyring';
import { decodePairingCode, encodePairingCode } from './pairing-code';
import { checkServerUrl } from './server-url';

export type { SyncCredentials } from './credentials';
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
/** `missingKey`: sealed under an epoch this device does not hold yet, unlike a tampered record it may become readable. */
export interface PulledRecord { deviceId: string; seq: number; recordId: string; payload?: unknown; unreadable?: true; missingKey?: true }
export interface SyncClientOptions { fetch?: typeof fetch; random?: () => number; timeoutMs?: number; idleMs?: number }

const ENVELOPE_VERSION = 1;
const PAIRING_TTL_SEC = 900;
const PUSH_ATTEMPTS = 3;
const ROTATE_ATTEMPTS = 5;
// The server pings every 25 s; three missed pings means the connection is dead even if TCP never said so.
const IDLE_MS = 75_000;

type KeyState = { keys: Array<{ epoch: number; sealed: string; tag: string }>; holders: Array<{ epoch: number; deviceIds: string[] }> };

const fail = <T>(error: string): Result<T> => ({ ok: false, error });
const asResult = <T>(reply: Reply, value: (json: Record<string, unknown>) => T): Result<T> =>
  (reply.ok ? { ok: true, value: value(reply.json) } : reply);

async function guarded<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await work(); } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
}

export class SyncClient {
  private creds: SyncCredentials;
  private readonly doFetch: typeof fetch;
  private readonly random: () => number;
  private readonly timeoutMs?: number;
  private readonly idleMs: number;

  constructor(creds: SyncCredentials, opts: SyncClientOptions = {}) {
    this.creds = { ...creds, syncKeys: [...creds.syncKeys] };
    this.doFetch = opts.fetch ?? fetch;
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  get credentials(): SyncCredentials { return this.creds; }

  /**
   * The bootstrap code is spent once the server answers, so the credentials come back even when a
   * later step fails: `healKeys` finishes the key upload and admission on the next run.
   */
  static enroll(server: string, bootstrapCode: string, name: string, opts: SyncClientOptions = {}): Promise<Result<SyncCredentials>> {
    return guarded(async () => {
      const url = checkServerUrl(server);
      if (!url.ok) { return fail(url.reason); }
      const keys = generateDeviceKeys();
      const reply = await request(opts.fetch ?? fetch, url.base, 'POST', '/v1/bootstrap', {
        body: { code: bootstrapCode, name, publicKey: keys.publicKey }, timeoutMs: opts.timeoutMs,
      });
      if (!reply.ok) { return reply; }
      const client = new SyncClient({
        server: url.base, deviceId: String(reply.json.deviceId), deviceName: name, token: String(reply.json.token),
        keys, syncKeys: [{ epoch: 1, key: generateSyncKey() }],
      }, opts);
      await client.healKeys();
      return { ok: true, value: client.credentials };
    });
  }

  static join(server: string, pairingCode: string, name: string, opts: SyncClientOptions = {}): Promise<Result<SyncCredentials>> {
    return guarded(async () => {
      const url = checkServerUrl(server);
      if (!url.ok) { return fail(url.reason); }
      const code = decodePairingCode(pairingCode);
      if (!code) { return fail('That pairing code is not valid. Copy it again from the device that made it.'); }
      const keys = generateDeviceKeys();
      const reply = await request(opts.fetch ?? fetch, url.base, 'POST', `/v1/pairings/${code.pairingId.toString('hex')}/claim`, {
        body: { name, publicKey: keys.publicKey }, timeoutMs: opts.timeoutMs,
      });
      if (!reply.ok) { return reply; }
      const client = new SyncClient({
        server: url.base, deviceId: String(reply.json.deviceId), deviceName: name, token: String(reply.json.token), keys, syncKeys: [],
      }, opts);
      const syncKeys = SyncClient.unwrapKeys(String(reply.json.wrapped), code.secret);
      if (!syncKeys) {
        // The claim already created a device; a code mistyped in its secret half must not leave it live.
        await client.call('POST', `/v1/devices/${client.creds.deviceId}/revoke`);
        return fail('The pairing code did not unlock the keys; it was probably mistyped. Make a new one with `marcode sync pair`.');
      }
      client.creds = { ...client.creds, syncKeys };
      await client.healKeys();
      return { ok: true, value: client.credentials };
    });
  }

  private static unwrapKeys(wrapped: string, secret: Buffer): SyncKey[] | undefined {
    const plain = unwrapWithSecret(wrapped, secret);
    if (!plain) { return undefined; }
    try {
      const { syncKeys } = JSON.parse(plain.toString()) as { syncKeys?: unknown };
      return Array.isArray(syncKeys) && syncKeys.length > 0 ? syncKeys as SyncKey[] : undefined;
    } catch {
      return undefined;
    }
  }

  private call(method: string, route: string, body?: unknown): Promise<Reply> {
    return request(this.doFetch, this.creds.server, method, route, { body, token: this.creds.token, timeoutMs: this.timeoutMs });
  }

  createPairing(): Promise<Result<{ code: string; expiresAt: number }>> {
    return guarded(async () => {
      const refreshed = await this.refreshKeys();
      if (!refreshed.ok) { return refreshed; }
      const pairingId = randomBytes(8);
      const secret = randomBytes(16);
      const reply = await this.call('POST', '/v1/pairings', {
        pairingId: pairingId.toString('hex'),
        wrapped: wrapWithSecret(Buffer.from(JSON.stringify({ syncKeys: this.creds.syncKeys })), secret),
        ttlSec: PAIRING_TTL_SEC,
      });
      return asResult(reply, () => ({ code: encodePairingCode(pairingId, secret), expiresAt: Date.now() + PAIRING_TTL_SEC * 1000 }));
    });
  }

  async devices(): Promise<Result<DeviceRow[]>> {
    return asResult(await this.call('GET', '/v1/devices'), (json) => json.devices as DeviceRow[]);
  }

  private async keyState(): Promise<Result<KeyState>> {
    return asResult(await this.call('GET', '/v1/keys'), (json) => json as unknown as KeyState);
  }

  refreshKeys(): Promise<Result<SyncCredentials>> {
    return guarded(async () => {
      const state = await this.keyState();
      if (!state.ok) { return state; }
      this.creds = { ...this.creds, syncKeys: acceptEpochs(this.creds, state.value.keys) };
      return { ok: true, value: this.creds };
    });
  }

  /**
   * Converges this device's view: admits itself if it is not yet, creates an epoch the server lacks
   * (an interrupted enroll), and seals every epoch it holds for admitted devices missing it.
   */
  healKeys(): Promise<Result<number>> {
    return guarded(async () => {
      const refreshed = await this.refreshKeys();
      if (!refreshed.ok) { return refreshed; }
      const [devices, state] = await Promise.all([this.devices(), this.keyState()]);
      if (!devices.ok) { return devices; }
      if (!state.ok) { return state; }
      const self = devices.value.find((d) => d.deviceId === this.creds.deviceId);
      if (self && !self.admission) {
        const { epoch, key } = newestKey(this.creds.syncKeys);
        await this.call('PUT', '/v1/devices/me/admission', { epoch, tag: admissionTag(key, self.deviceId, self.publicKey) });
      }
      const admitted = devices.value.filter((d) => d.revokedAt === undefined && isAdmitted(d, this.creds.syncKeys, this.creds.deviceId));
      let added = 0;
      for (const { epoch, key } of this.creds.syncKeys) {
        const holders = state.value.holders.find((h) => h.epoch === epoch);
        const sealed: Record<string, string> = {};
        for (const d of admitted) {
          if (holders?.deviceIds.includes(d.deviceId)) { continue; }
          const blob = trySeal(key, d, epoch);
          if (blob) { sealed[d.deviceId] = blob; }
        }
        if (Object.keys(sealed).length === 0) { continue; }
        const previous = this.creds.syncKeys.find((k) => k.epoch === epoch - 1);
        const reply = holders
          ? await this.call('POST', `/v1/keys/${epoch}/sealed`, { sealed })
          : await this.call('PUT', `/v1/keys/${epoch}`, { sealed, tag: previous ? epochTag(previous.key, epoch, key) : GENESIS_TAG });
        if (!reply.ok) { return reply; }
        added += Object.keys(sealed).length;
      }
      return { ok: true, value: added };
    });
  }

  /** Revoked devices that still hold the newest key: a revoke whose rotation never finished. */
  unfinishedRevokes(): Promise<Result<string[]>> {
    return guarded(async () => {
      const [devices, state] = await Promise.all([this.devices(), this.keyState()]);
      if (!devices.ok) { return devices; }
      if (!state.ok) { return state; }
      const newest = state.value.holders.reduce((m, h) => Math.max(m, h.epoch), 0);
      const holders = new Set(state.value.holders.find((h) => h.epoch === newest)?.deviceIds ?? []);
      return { ok: true, value: devices.value.filter((d) => d.revokedAt !== undefined && holders.has(d.deviceId)).map((d) => d.deviceId) };
    });
  }

  /** Revokes a device, then rotates so records written from now on use a key it never had. */
  revoke(deviceId: string): Promise<Result<SyncCredentials>> {
    return guarded(async () => {
      const reply = await this.call('POST', `/v1/devices/${deviceId}/revoke`);
      if (!reply.ok) { return reply; }
      return this.rotate(new Set());
    });
  }

  /** A fresh epoch for every admitted, active device; also how an interrupted revoke is finished. */
  rotateKey(): Promise<Result<SyncCredentials>> {
    return guarded(() => this.rotate(new Set()));
  }

  /** This device leaves: the others get a key it excludes itself from, then it revokes itself. */
  leave(): Promise<Result<void>> {
    return guarded(async () => {
      const rotated = await this.rotate(new Set([this.creds.deviceId]));
      if (!rotated.ok) { return rotated; }
      const reply = await this.call('POST', `/v1/devices/${this.creds.deviceId}/revoke`);
      return asResult(reply, () => undefined);
    });
  }

  private async rotate(exclude: Set<string>): Promise<Result<SyncCredentials>> {
    for (let attempt = 0; attempt < ROTATE_ATTEMPTS; attempt++) {
      const refreshed = await this.refreshKeys();
      if (!refreshed.ok) { return refreshed; }
      const [devices, state] = await Promise.all([this.devices(), this.keyState()]);
      if (!devices.ok) { return devices; }
      if (!state.ok) { return state; }
      const excluded = new Set([...exclude, ...devices.value.filter((d) => d.revokedAt !== undefined).map((d) => d.deviceId)]);
      const newestOnServer = state.value.holders.reduce((m, h) => Math.max(m, h.epoch), 0);
      const newestHolders = state.value.holders.find((h) => h.epoch === newestOnServer)?.deviceIds ?? [];
      const mine = this.creds.syncKeys.some((k) => k.epoch === newestOnServer);
      // Someone else rotated first: adopt their epoch if no excluded device can read it.
      if (attempt > 0 && mine && !newestHolders.some((id) => excluded.has(id))) { return { ok: true, value: this.creds }; }
      const previous = newestKey(this.creds.syncKeys);
      const epoch = Math.max(newestOnServer, previous.epoch) + 1;
      if (previous.epoch !== epoch - 1) { continue; }
      const key = generateSyncKey();
      const sealed: Record<string, string> = {};
      for (const d of devices.value) {
        if (excluded.has(d.deviceId) || !isAdmitted(d, this.creds.syncKeys, this.creds.deviceId)) { continue; }
        const blob = trySeal(key, d, epoch);
        if (blob) { sealed[d.deviceId] = blob; }
      }
      const put = await this.call('PUT', `/v1/keys/${epoch}`, { sealed, tag: epochTag(previous.key, epoch, key) });
      if (!put.ok) { return put; }
      if (put.status !== 409) {
        this.creds = { ...this.creds, syncKeys: [...this.creds.syncKeys, { epoch, key }] };
        return { ok: true, value: this.creds };
      }
    }
    return fail('Could not agree on a new sync key with the other devices; run `marcode sync revoke` again.');
  }

  push(payloads: unknown[]): Promise<Result<Array<{ recordId: string; seq: number }>>> {
    return this.pushRecords(payloads.map((payload) => ({ recordId: randomBytes(16).toString('hex'), payload })));
  }

  /** The caller owns the ids (an outbox row keeps its id across retries and across pushers), so each is stored once. */
  pushRecords(items: Array<{ recordId: string; payload: unknown }>): Promise<Result<Array<{ recordId: string; seq: number }>>> {
    return guarded(async () => {
      const { epoch, key } = newestKey(this.creds.syncKeys);
      const records = items.map(({ recordId, payload }) => {
        const plain = Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, payload }));
        return { recordId, epoch, ...encryptRecord(plain, key, { deviceId: this.creds.deviceId, recordId, epoch }) };
      });
      let reply: Reply = { ok: false, error: 'not sent' };
      for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
        reply = await this.call('POST', '/v1/records', { records });
        if (reply.ok || !isUnreachable(reply)) { break; }
      }
      return asResult(reply, (json) => json.assigned as Array<{ recordId: string; seq: number }>);
    });
  }

  pull(deviceId: string, afterSeq: number, limit = 500): Promise<Result<PulledRecord[]>> {
    return guarded(async () => {
      const reply = await this.call('GET', `/v1/streams/${encodeURIComponent(deviceId)}?after=${afterSeq}&limit=${limit}`);
      if (!reply.ok) { return reply; }
      const rows = reply.json.records as ServedRecord[];
      if (rows.some((r) => !this.creds.syncKeys.some((k) => k.epoch === r.epoch))) { await this.refreshKeys(); }
      return { ok: true, value: rows.map((r) => this.open(deviceId, r)) };
    });
  }

  private open(deviceId: string, r: ServedRecord): PulledRecord {
    const base = { deviceId, seq: r.seq, recordId: r.recordId };
    const key = this.creds.syncKeys.find((k) => k.epoch === r.epoch)?.key;
    if (!key) { return { ...base, unreadable: true, missingKey: true }; }
    const plain = key ? decryptRecord(r, key, { deviceId, recordId: r.recordId, epoch: r.epoch }) : undefined;
    if (!plain) { return { ...base, unreadable: true }; }
    try {
      const envelope = JSON.parse(plain.toString()) as { v?: unknown; payload?: unknown };
      return envelope.v === ENVELOPE_VERSION ? { ...base, payload: envelope.payload } : { ...base, unreadable: true };
    } catch {
      return { ...base, unreadable: true };
    }
  }

  async streams(): Promise<Result<Array<{ deviceId: string; lastSeq: number }>>> {
    return asResult(await this.call('GET', '/v1/streams'), (json) => json.streams as Array<{ deviceId: string; lastSeq: number }>);
  }

  /** Follows the server's event stream until `stop()`, reconnecting with capped, jittered backoff. */
  follow(onEvent: (e: SyncEvent) => void): { stop(): void } {
    let stopped = false;
    let abort: AbortController | undefined;
    let wake: (() => void) | undefined;
    const loop = async (): Promise<void> => {
      let failures = 0;
      while (!stopped) {
        abort = new AbortController();
        const current = abort;
        let idle: NodeJS.Timeout | undefined;
        const alive = () => { clearTimeout(idle); idle = setTimeout(() => { current.abort(); }, this.idleMs); };
        try {
          alive();
          const res = await this.doFetch(`${this.creds.server}/v1/events`, {
            headers: { authorization: `Bearer ${this.creds.token}` }, signal: current.signal,
          });
          if (res.status === 401) { onEvent({ type: 'connection', state: 'revoked' }); return; }
          if (res.ok && res.body) {
            failures = 0;
            onEvent({ type: 'connection', state: 'open' });
            await readEvents(res.body, (event, data) => {
              if (event === 'appended') {
                const parsed = JSON.parse(data) as { deviceId: string; lastSeq: number };
                onEvent({ type: 'appended', deviceId: parsed.deviceId, lastSeq: parsed.lastSeq });
              } else if (event === 'devices' || event === 'keys') {
                onEvent({ type: event });
                void this.healKeys();
              }
            }, alive);
          }
        } catch { /* reconnect below */ } finally { clearTimeout(idle); }
        if (stopped) { return; }
        onEvent({ type: 'connection', state: 'retrying' });
        const delay = Math.min(30_000, 500 * 2 ** failures) * (0.8 + 0.4 * this.random());
        failures++;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    };
    void loop();
    return { stop: () => { stopped = true; abort?.abort(); wake?.(); } };
  }
}
