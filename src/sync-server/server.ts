import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceRow, WireRecord } from '../sync/api-types';
import { isDevicePublicKey } from '../sync/crypto';
import { decodeCode } from '../sync/pairing-code';
import { bearerOf, hashSecret, newToken } from './auth';
import { EventHub } from './sse';
import type { SyncStore } from './store';

export const SYNC_API_VERSION = 1;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024;
const MAX_PAGE = 500;
const MAX_PAIRING_TTL_SEC = 900;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); }
}

type Json = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) { resolve({}); return; }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { throw new Error('not an object'); }
        resolve(parsed as Json);
      } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v === '') { throw new HttpError(400, `${field} must be a non-empty string`); }
  return v;
};

const sealedMap = (v: unknown): Record<string, string> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { throw new HttpError(400, 'sealed must be an object'); }
  for (const blob of Object.values(v)) { str(blob, 'sealed blob'); }
  return v as Record<string, string>;
};

function records(v: unknown): WireRecord[] {
  if (!Array.isArray(v)) { throw new HttpError(400, 'records must be a list'); }
  return v.map((r: Json) => {
    const rec = { recordId: str(r?.recordId, 'recordId'), epoch: Number(r?.epoch), nonce: str(r?.nonce, 'nonce'), ciphertext: str(r?.ciphertext, 'ciphertext') };
    if (!Number.isInteger(rec.epoch) || rec.epoch < 1) { throw new HttpError(400, 'epoch must be a positive integer'); }
    if (rec.ciphertext.length > MAX_RECORD) { throw new HttpError(413, 'record too large'); }
    return rec;
  });
}

const publicDevice = ({ deviceId, name, publicKey, createdAt, lastSeenAt, revokedAt, admission }: DeviceRow): DeviceRow =>
  ({ deviceId, name, publicKey, createdAt, lastSeenAt, ...(revokedAt !== undefined ? { revokedAt } : {}), ...(admission ? { admission } : {}) });

/** Checked before any one-time secret is spent, so a malformed request cannot burn a code. */
function newDevice(body: Json): { name: string; publicKey: string } {
  const name = str(body.name, 'name');
  const publicKey = str(body.publicKey, 'publicKey');
  if (!isDevicePublicKey(publicKey)) { throw new HttpError(400, 'publicKey must be an X25519 public key'); }
  return { name, publicKey };
}

const epochOf = (v: string): number => {
  const epoch = Number(v);
  if (!Number.isInteger(epoch) || epoch < 1) { throw new HttpError(400, 'epoch must be a positive integer'); }
  return epoch;
};

export interface SyncServerOptions {
  store: SyncStore;
  host: string;
  port: number;
  now?: () => number;
  log?: (line: string) => void;
}

export async function startSyncServer(opts: SyncServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const hub = new EventHub();

  const authed = (req: IncomingMessage): DeviceRow => {
    const token = bearerOf(req.headers.authorization);
    const device = token ? store.deviceByTokenHash(hashSecret(token)) : undefined;
    if (!device) { throw new HttpError(401, 'unknown or revoked device'); }
    return device;
  };

  const issue = ({ name, publicKey }: { name: string; publicKey: string }): { deviceId: string; token: string } => {
    const token = newToken();
    const device = store.addDevice(name, publicKey, hashSecret(token));
    hub.emit('devices', {});
    return { deviceId: device.deviceId, token };
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const at = (...want: string[]) => want.length === parts.length && want.every((w, i) => w === '*' || w === parts[i]);
    if (parts[0] !== 'v1') { throw new HttpError(404, 'not found'); }

    if (method === 'GET' && at('v1', 'info')) { return { apiVersion: SYNC_API_VERSION, enrolled: store.enrolled() }; }

    if (method === 'POST' && at('v1', 'bootstrap')) {
      const body = await readBody(req);
      const device = newDevice(body);
      const bytes = decodeCode('MRB', str(body.code, 'code'), 16);
      if (!bytes || !store.takeBootstrap(hashSecret(bytes))) { throw new HttpError(403, 'bootstrap code is wrong or already used'); }
      return issue(device);
    }

    if (method === 'POST' && at('v1', 'pairings', '*', 'claim')) {
      const device = newDevice(await readBody(req));
      const claimed = store.claimPairing(parts[2]);
      if (claimed === 'gone') { throw new HttpError(410, 'pairing code expired or already used'); }
      return { ...issue(device), wrapped: claimed.wrapped };
    }

    const device = authed(req);

    if (method === 'GET' && at('v1', 'events')) { hub.open(device.deviceId, res); return undefined; }

    if (method === 'POST' && at('v1', 'pairings')) {
      const body = await readBody(req);
      const ttl = Number(body.ttlSec);
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_PAIRING_TTL_SEC) { throw new HttpError(400, `ttlSec must be 1..${MAX_PAIRING_TTL_SEC}`); }
      store.createPairing(str(body.pairingId, 'pairingId'), device.deviceId, str(body.wrapped, 'wrapped'), now() + ttl * 1000);
      return null;
    }

    if (method === 'GET' && at('v1', 'devices')) { return { devices: store.devices().map(publicDevice) }; }

    if (method === 'POST' && at('v1', 'devices', '*', 'revoke')) {
      if (!store.revoke(parts[2])) { throw new HttpError(404, 'no such active device'); }
      hub.closeDevice(parts[2]);
      hub.emit('devices', {});
      return null;
    }

    if (method === 'PUT' && at('v1', 'devices', 'me', 'admission')) {
      const body = await readBody(req);
      store.setAdmission(device.deviceId, epochOf(String(body.epoch)), str(body.tag, 'tag'));
      hub.emit('devices', {});
      return null;
    }

    if (method === 'PUT' && at('v1', 'keys', '*')) {
      const epoch = epochOf(parts[2]);
      const body = await readBody(req);
      if (!store.createEpoch(epoch, sealedMap(body.sealed), str(body.tag, 'tag'))) { throw new HttpError(409, 'epoch exists'); }
      hub.emit('keys', {});
      return null;
    }

    if (method === 'POST' && at('v1', 'keys', '*', 'sealed')) {
      if (!store.addSealed(epochOf(parts[2]), sealedMap((await readBody(req)).sealed))) { throw new HttpError(404, 'no such epoch'); }
      hub.emit('keys', {});
      return null;
    }

    if (method === 'GET' && at('v1', 'keys')) { return { keys: store.keysFor(device.deviceId), holders: store.holders() }; }

    if (method === 'POST' && at('v1', 'records')) {
      const assigned = store.append(device.deviceId, records((await readBody(req)).records));
      const lastSeq = assigned.reduce((m, a) => Math.max(m, a.seq), 0);
      if (assigned.length > 0) { hub.emit('appended', { deviceId: device.deviceId, lastSeq }, device.deviceId); }
      return { assigned };
    }

    if (method === 'GET' && at('v1', 'streams')) { return { streams: store.streams() }; }

    if (method === 'GET' && at('v1', 'streams', '*')) {
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit') ?? MAX_PAGE) || MAX_PAGE));
      const page = store.read(parts[2], after, limit).map(({ seq, recordId, epoch, nonce, ciphertext }) => ({ seq, recordId, epoch, nonce, ciphertext }));
      return { records: page };
    }

    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    route(req, res).then((body) => {
      if (res.headersSent) { return; }
      if (body === null) { res.writeHead(204).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) { opts.log?.(`sync-server: ${err instanceof Error ? err.message : String(err)}`); }
      if (res.headersSent) { res.end(); return; }
      const message = err instanceof HttpError ? err.message : 'internal error';
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      hub.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
