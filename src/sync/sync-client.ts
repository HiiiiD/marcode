import { randomBytes } from 'node:crypto';
import type { DeviceRow, ServedRecord, SyncEvent } from './api-types';
import type { SyncCredentials } from './credentials';
import {
  decryptRecord, encryptRecord, generateDeviceKeys, generateSyncKey, seal, unseal, unwrapWithSecret, wrapWithSecret,
} from './crypto';
import { readEvents } from './event-stream';
import { decodePairingCode, encodePairingCode } from './pairing-code';
import { checkServerUrl } from './server-url';

export type { SyncCredentials } from './credentials';
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface PulledRecord { deviceId: string; seq: number; recordId: string; payload?: unknown; unreadable?: true }

const ENVELOPE_VERSION = 1;
const PAIRING_TTL_SEC = 900;
const PUSH_ATTEMPTS = 3;
const ROTATE_ATTEMPTS = 5;

type Fetch = typeof fetch;
type Reply = { ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string };

const fail = <T>(error: string): Result<T> => ({ ok: false, error });

async function request(
  doFetch: Fetch, server: string, method: string, route: string, body?: unknown, token?: string,
): Promise<Reply> {
  let res: Response;
  try {
    res = await doFetch(`${server}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Cannot reach ${server}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON error page */ }
  if (res.status === 401) { return { ok: false, error: 'This device was revoked or is unknown to the sync server.' }; }
  if (res.status >= 400 && res.status !== 409) {
    return { ok: false, error: `Sync server answered ${res.status}: ${typeof json.error === 'string' ? json.error : res.statusText}` };
  }
  return { ok: true, status: res.status, json };
}

function keysPayload(syncKeys: SyncCredentials['syncKeys']): Buffer {
  return Buffer.from(JSON.stringify({ syncKeys }));
}

export class SyncClient {
  private creds: SyncCredentials;
  private readonly doFetch: Fetch;
  private readonly random: () => number;

  constructor(creds: SyncCredentials, opts: { fetch?: Fetch; random?: () => number } = {}) {
    this.creds = { ...creds, syncKeys: [...creds.syncKeys] };
    this.doFetch = opts.fetch ?? fetch;
    this.random = opts.random ?? Math.random;
  }

  get credentials(): SyncCredentials { return this.creds; }

  static async enroll(server: string, bootstrapCode: string, name: string): Promise<Result<SyncCredentials>> {
    const url = checkServerUrl(server);
    if (!url.ok) { return fail(url.reason); }
    const keys = generateDeviceKeys();
    const reply = await request(fetch, url.base, 'POST', '/v1/bootstrap', { code: bootstrapCode, name, publicKey: keys.publicKey });
    if (!reply.ok) { return reply; }
    const creds: SyncCredentials = {
      server: url.base, deviceId: String(reply.json.deviceId), deviceName: name, token: String(reply.json.token),
      keys, syncKeys: [{ epoch: 1, key: generateSyncKey() }],
    };
    const put = await request(fetch, url.base, 'PUT', '/v1/keys/1',
      { sealed: { [creds.deviceId]: seal(Buffer.from(creds.syncKeys[0].key), keys.publicKey) } }, creds.token);
    if (!put.ok) { return put; }
    return { ok: true, value: creds };
  }

  static async join(server: string, pairingCode: string, name: string): Promise<Result<SyncCredentials>> {
    const url = checkServerUrl(server);
    if (!url.ok) { return fail(url.reason); }
    const code = decodePairingCode(pairingCode);
    if (!code) { return fail('That pairing code is not valid. Copy it again from the device that made it.'); }
    const keys = generateDeviceKeys();
    const reply = await request(fetch, url.base, 'POST', `/v1/pairings/${code.pairingId.toString('hex')}/claim`, { name, publicKey: keys.publicKey });
    if (!reply.ok) { return reply; }
    const plain = unwrapWithSecret(String(reply.json.wrapped), code.secret);
    if (!plain) { return fail('The pairing payload could not be decrypted; the code may have been mistyped.'); }
    const { syncKeys } = JSON.parse(plain.toString()) as { syncKeys: SyncCredentials['syncKeys'] };
    const creds: SyncCredentials = {
      server: url.base, deviceId: String(reply.json.deviceId), deviceName: name, token: String(reply.json.token), keys, syncKeys,
    };
    const client = new SyncClient(creds);
    const healed = await client.sealOwn();
    return healed.ok ? { ok: true, value: client.credentials } : healed;
  }

  private call(method: string, route: string, body?: unknown): Promise<Reply> {
    return request(this.doFetch, this.creds.server, method, route, body, this.creds.token);
  }

  private async sealOwn(): Promise<Result<void>> {
    for (const { epoch, key } of this.creds.syncKeys) {
      const reply = await this.call('POST', `/v1/keys/${epoch}/sealed`, { sealed: { [this.creds.deviceId]: seal(Buffer.from(key), this.creds.keys.publicKey) } });
      if (!reply.ok) { return reply; }
    }
    return { ok: true, value: undefined };
  }

  async createPairing(): Promise<Result<{ code: string; expiresAt: number }>> {
    const refreshed = await this.refreshKeys();
    if (!refreshed.ok) { return refreshed; }
    const pairingId = randomBytes(8);
    const secret = randomBytes(16);
    const reply = await this.call('POST', '/v1/pairings', {
      pairingId: pairingId.toString('hex'), wrapped: wrapWithSecret(keysPayload(this.creds.syncKeys), secret), ttlSec: PAIRING_TTL_SEC,
    });
    if (!reply.ok) { return reply; }
    return { ok: true, value: { code: encodePairingCode(pairingId, secret), expiresAt: Date.now() + PAIRING_TTL_SEC * 1000 } };
  }

  async devices(): Promise<Result<DeviceRow[]>> {
    const reply = await this.call('GET', '/v1/devices');
    return reply.ok ? { ok: true, value: reply.json.devices as DeviceRow[] } : reply;
  }

  private async keyState(): Promise<Result<{ keys: Array<{ epoch: number; sealed: string }>; holders: Array<{ epoch: number; deviceIds: string[] }> }>> {
    const reply = await this.call('GET', '/v1/keys');
    return reply.ok ? { ok: true, value: reply.json as never } : reply;
  }

  async refreshKeys(): Promise<Result<SyncCredentials>> {
    const state = await this.keyState();
    if (!state.ok) { return state; }
    const known = new Map(this.creds.syncKeys.map((k) => [k.epoch, k.key]));
    for (const { epoch, sealed } of state.value.keys) {
      if (known.has(epoch)) { continue; }
      const key = unseal(sealed, this.creds.keys);
      if (key) { known.set(epoch, key.toString()); }
    }
    this.creds = { ...this.creds, syncKeys: [...known].sort((a, b) => a[0] - b[0]).map(([epoch, key]) => ({ epoch, key })) };
    return { ok: true, value: this.creds };
  }

  async healKeys(): Promise<Result<number>> {
    const refreshed = await this.refreshKeys();
    if (!refreshed.ok) { return refreshed; }
    const [devices, state] = await Promise.all([this.devices(), this.keyState()]);
    if (!devices.ok) { return devices; }
    if (!state.ok) { return state; }
    const active = devices.value.filter((d) => d.revokedAt === undefined);
    let added = 0;
    for (const { epoch, key } of this.creds.syncKeys) {
      const holders = new Set(state.value.holders.find((h) => h.epoch === epoch)?.deviceIds ?? []);
      const sealed: Record<string, string> = {};
      for (const d of active) { if (!holders.has(d.deviceId)) { sealed[d.deviceId] = seal(Buffer.from(key), d.publicKey); } }
      if (Object.keys(sealed).length === 0) { continue; }
      const reply = await this.call('POST', `/v1/keys/${epoch}/sealed`, { sealed });
      if (!reply.ok) { return reply; }
      added += Object.keys(sealed).length;
    }
    return { ok: true, value: added };
  }

  /** Revokes a device, then rotates so records written from now on use a key it never had. */
  async revoke(deviceId: string): Promise<Result<SyncCredentials>> {
    const reply = await this.call('POST', `/v1/devices/${deviceId}/revoke`);
    if (!reply.ok) { return reply; }
    for (let attempt = 0; attempt < ROTATE_ATTEMPTS; attempt++) {
      const refreshed = await this.refreshKeys();
      if (!refreshed.ok) { return refreshed; }
      const [devices, state] = await Promise.all([this.devices(), this.keyState()]);
      if (!devices.ok) { return devices; }
      if (!state.ok) { return state; }
      const revoked = new Set(devices.value.filter((d) => d.revokedAt !== undefined).map((d) => d.deviceId));
      const newestOnServer = state.value.holders.reduce((m, h) => Math.max(m, h.epoch), 0);
      const newestHolders = state.value.holders.find((h) => h.epoch === newestOnServer)?.deviceIds ?? [];
      // Someone else rotated first: adopt their epoch if no revoked device can read it.
      const mine = this.creds.syncKeys.some((k) => k.epoch === newestOnServer);
      if (attempt > 0 && mine && !newestHolders.some((id) => revoked.has(id))) { return { ok: true, value: this.creds }; }
      const epoch = Math.max(newestOnServer, ...this.creds.syncKeys.map((k) => k.epoch)) + 1;
      const key = generateSyncKey();
      const sealed: Record<string, string> = {};
      for (const d of devices.value) { if (d.revokedAt === undefined) { sealed[d.deviceId] = seal(Buffer.from(key), d.publicKey); } }
      const put = await this.call('PUT', `/v1/keys/${epoch}`, { sealed });
      if (!put.ok) { return put; }
      if (put.status !== 409) {
        this.creds = { ...this.creds, syncKeys: [...this.creds.syncKeys, { epoch, key }] };
        return { ok: true, value: this.creds };
      }
    }
    return fail('Could not agree on a new sync key with the other devices; try revoking again.');
  }

  async push(payloads: unknown[]): Promise<Result<Array<{ recordId: string; seq: number }>>> {
    const { epoch, key } = this.creds.syncKeys[this.creds.syncKeys.length - 1];
    const records = payloads.map((payload) => {
      const recordId = randomBytes(16).toString('hex');
      const plain = Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, payload }));
      return { recordId, epoch, ...encryptRecord(plain, key, { deviceId: this.creds.deviceId, recordId, epoch }) };
    });
    let last: Reply = { ok: false, error: 'not sent' };
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
      last = await this.call('POST', '/v1/records', { records });
      if (last.ok) { return { ok: true, value: last.json.assigned as Array<{ recordId: string; seq: number }> }; }
      if (!last.error.startsWith('Cannot reach')) { break; }
    }
    return last.ok ? fail('unreachable') : last;
  }

  async pull(deviceId: string, afterSeq: number, limit = 500): Promise<Result<PulledRecord[]>> {
    const reply = await this.call('GET', `/v1/streams/${encodeURIComponent(deviceId)}?after=${afterSeq}&limit=${limit}`);
    if (!reply.ok) { return reply; }
    const rows = reply.json.records as ServedRecord[];
    if (rows.some((r) => !this.creds.syncKeys.some((k) => k.epoch === r.epoch))) { await this.refreshKeys(); }
    return { ok: true, value: rows.map((r) => this.open(deviceId, r)) };
  }

  private open(deviceId: string, r: ServedRecord): PulledRecord {
    const base = { deviceId, seq: r.seq, recordId: r.recordId };
    const key = this.creds.syncKeys.find((k) => k.epoch === r.epoch)?.key;
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
    const reply = await this.call('GET', '/v1/streams');
    return reply.ok ? { ok: true, value: reply.json.streams as Array<{ deviceId: string; lastSeq: number }> } : reply;
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
        try {
          const res = await this.doFetch(`${this.creds.server}/v1/events`, {
            headers: { authorization: `Bearer ${this.creds.token}` }, signal: abort.signal,
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
            });
          }
        } catch { /* reconnect below */ }
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
