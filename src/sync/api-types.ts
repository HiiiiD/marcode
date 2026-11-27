export interface DeviceRow {
  deviceId: string;
  name: string;
  publicKey: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
  /** Whether the device holds an open event stream right now. */
  online?: boolean;
  /** An HMAC by a key holder over this row's id and public key; devices only ever seal keys to admitted rows. */
  admission?: { epoch: number; tag: string };
}

/** A record as a device pushes it: `recordId` is random per record, so a retried push is stored once. */
export interface WireRecord { recordId: string; epoch: number; nonce: string; ciphertext: string }

/** A record as the server serves it back, with the seq it assigned in that device's stream. */
export interface ServedRecord extends WireRecord { seq: number }

export type SyncEvent =
  | { type: 'appended'; deviceId: string; lastSeq: number }
  | { type: 'devices' }
  | { type: 'keys' }
  | { type: 'connection'; state: 'open' | 'retrying' | 'revoked' };
