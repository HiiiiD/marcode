import type { DeviceRow } from './api-types';
import type { SyncCredentials } from './credentials';
import { seal, unseal, verifyAdmission, verifyEpoch } from './crypto';

export type SyncKey = SyncCredentials['syncKeys'][number];
export const GENESIS_TAG = 'genesis';

export const sealLabel = (epoch: number, deviceId: string): string => `epoch:${epoch}:device:${deviceId}`;

export const newestKey = (keys: SyncKey[]): SyncKey => keys[keys.length - 1];

/**
 * Epochs the server offers, accepted in order and only when each is tagged with the key of the
 * epoch before it: the server can relay a new epoch, never invent one.
 */
export function acceptEpochs(
  creds: SyncCredentials, offered: Array<{ epoch: number; sealed: string; tag: string }>,
): SyncKey[] {
  const known = new Map(creds.syncKeys.map((k) => [k.epoch, k.key]));
  for (const { epoch, sealed, tag } of [...offered].sort((a, b) => a.epoch - b.epoch)) {
    if (known.has(epoch)) { continue; }
    const previous = known.get(epoch - 1);
    if (!previous) { continue; }
    const key = unseal(sealed, creds.keys, sealLabel(epoch, creds.deviceId))?.toString();
    if (key && verifyEpoch(previous, epoch, key, tag)) { known.set(epoch, key); }
  }
  return [...known].sort((a, b) => a[0] - b[0]).map(([epoch, key]) => ({ epoch, key }));
}

/** A row is ours when a key holder admitted it; a row the server added on its own never is. */
export function isAdmitted(device: DeviceRow, keys: SyncKey[], selfId: string): boolean {
  if (device.deviceId === selfId) { return true; }
  if (!device.admission) { return false; }
  const key = keys.find((k) => k.epoch === device.admission!.epoch)?.key;
  return key !== undefined && verifyAdmission(key, device.deviceId, device.publicKey, device.admission.tag);
}

/** `undefined` when the row's public key is unusable, so one bad row never stops the rest. */
export function trySeal(key: string, device: DeviceRow, epoch: number): string | undefined {
  try { return seal(Buffer.from(key), device.publicKey, sealLabel(epoch, device.deviceId)); } catch { return undefined; }
}
