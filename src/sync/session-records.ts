import type { SessionState, TranscriptItem } from '../protocol/messages';
import { FIELD_CAP, MEMORY_PAYLOAD_CAP } from './memory-records';
import { bytes, trimStrings } from './payload-size';

const HOST_ONLY = [
  'owner', 'children', 'subagents', 'backgroundTasks', 'backgroundCommands', 'queued', 'waitingOn',
  'pinned', 'summary', 'open', 'draft', 'remote',
] as const;

export type PublishedState = Omit<SessionState, typeof HOST_ONLY[number]>;
export type TranscriptOp = { op: 'append' | 'replace'; item: TranscriptItem };
export type SessionOpsPayload = { type: 'session-ops'; v: 1; sessionId: string; rev: number; ops: TranscriptOp[] };
export type SessionPayload =
  | { type: 'session-meta'; v: 1; sessionId: string; projectId: string; relCwd: string; branch?: string; state: PublishedState }
  | SessionOpsPayload
  | { type: 'session-delete'; v: 1; sessionId: string };

const SESSION_TYPES = new Set(['session-meta', 'session-ops', 'session-delete']);

export function publishedState(state: SessionState): PublishedState {
  const copy: Record<string, unknown> = { ...state };
  for (const key of HOST_ONLY) { delete copy[key]; }
  return copy as PublishedState;
}

/** Splits ops into records that each fit the payload cap; an item too big alone has its strings trimmed. */
export function opsPayloads(sessionId: string, firstRev: number, ops: TranscriptOp[]): SessionOpsPayload[] {
  const records: SessionOpsPayload[] = [];
  let current: TranscriptOp[] = [];
  const make = (list: TranscriptOp[]): SessionOpsPayload => ({ type: 'session-ops', v: 1, sessionId, rev: firstRev + records.length, ops: list });
  for (const raw of ops) {
    const op = bytes(make([raw])) > MEMORY_PAYLOAD_CAP ? trimStrings(raw, FIELD_CAP) as TranscriptOp : raw;
    if (current.length > 0 && bytes(make([...current, op])) > MEMORY_PAYLOAD_CAP) {
      records.push(make(current));
      current = [];
    }
    current.push(op);
  }
  if (current.length > 0) { records.push(make(current)); }
  return records;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOp = (v: unknown): boolean => isRecord(v) && (v.op === 'append' || v.op === 'replace') && isRecord(v.item) && typeof v.item.id === 'string';

export function parseSessionPayload(value: unknown): SessionPayload | { newerFormat: true } | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !SESSION_TYPES.has(value.type)) { return undefined; }
  if (typeof value.sessionId !== 'string' || value.sessionId === '') { return undefined; }
  if (value.v !== 1) { return typeof value.v === 'number' && value.v > 1 ? { newerFormat: true } : undefined; }
  switch (value.type) {
    case 'session-delete': return { type: 'session-delete', v: 1, sessionId: value.sessionId };
    case 'session-ops':
      return typeof value.rev === 'number' && Array.isArray(value.ops) && value.ops.every(isOp) ? value as SessionOpsPayload : undefined;
    default: {
      const ok = typeof value.projectId === 'string' && typeof value.relCwd === 'string'
        && (value.branch === undefined || typeof value.branch === 'string')
        && isRecord(value.state) && value.state.id === value.sessionId && typeof value.state.providerId === 'string';
      return ok ? value as SessionPayload : undefined;
    }
  }
}
