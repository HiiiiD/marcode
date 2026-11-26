import type { SessionDigest } from '../memory/digest';
import { FETCH_WINDOW } from '../memory/fts/fts-memory-store';
import type { SessionRecord } from '../memory/types';
import type { TranscriptItem } from '../protocol/messages';

export type MemoryPayload =
  | {
      type: 'memory'; sessionId: string; projectId: string; relCwd: string; providerId: string; title: string;
      closedAt: number; digest: SessionDigest; text: string; items: TranscriptItem[];
    }
  | { type: 'memory-withdraw'; sessionId: string };

export const MEMORY_TEXT_CAP = 200 * 1024;
// Keeps a record's ciphertext (base64 of the plaintext plus a tag) under the server's 1 MiB record limit.
export const MEMORY_PAYLOAD_CAP = 512 * 1024;
const FIELD_CAP = 4 * 1024;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function trimStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') { return value.length > max ? `${value.slice(0, max)}…` : value; }
  if (Array.isArray(value)) { return value.map((v) => trimStrings(v, max)); }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v, max)]));
  }
  return value;
}

export function memoryPayload(input: {
  record: SessionRecord; projectId: string; relCwd: string; digest: SessionDigest;
}): MemoryPayload | undefined {
  const { record, digest } = input;
  const text = record.items.map((i) => ('text' in i ? i.text : '')).filter((t) => t.length > 0).join('\n').slice(0, MEMORY_TEXT_CAP);
  const base = {
    type: 'memory' as const, sessionId: record.sessionId, projectId: input.projectId, relCwd: input.relCwd,
    providerId: record.providerId, title: digest.title, closedAt: record.closedAt, digest, text,
  };
  let items = record.items.slice(0, FETCH_WINDOW);
  if (bytes({ ...base, items }) > MEMORY_PAYLOAD_CAP) { items = trimStrings(items, FIELD_CAP) as TranscriptItem[]; }
  while (items.length > 0 && bytes({ ...base, items }) > MEMORY_PAYLOAD_CAP) { items = items.slice(0, -1); }
  const payload = { ...base, items };
  return bytes(payload) > MEMORY_PAYLOAD_CAP ? undefined : payload;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isDigest(v: unknown): v is SessionDigest {
  return isRecord(v) && typeof v.title === 'string' && typeof v.request === 'string' && typeof v.outcome === 'string'
    && Array.isArray(v.filesEdited) && (v.source === 'extractive' || v.source === 'llm')
    && typeof v.summarizerVersion === 'number' && typeof v.forUpdatedAt === 'number';
}

export function parseMemoryPayload(value: unknown): MemoryPayload | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') { return undefined; }
  if (value.type === 'memory-withdraw') { return { type: 'memory-withdraw', sessionId: value.sessionId }; }
  if (value.type !== 'memory') { return undefined; }
  const ok = typeof value.projectId === 'string' && typeof value.relCwd === 'string' && typeof value.providerId === 'string'
    && typeof value.title === 'string' && typeof value.closedAt === 'number' && isDigest(value.digest)
    && typeof value.text === 'string' && Array.isArray(value.items);
  return ok ? value as MemoryPayload : undefined;
}

export function isShareableProject(projectId: string | undefined, excluded: string[]): projectId is string {
  return projectId !== undefined && !projectId.startsWith('local:') && !excluded.includes(projectId);
}
