export const CHUNK_BYTES = 256 * 1024;

export type MoveRequestPayload = { type: 'move-request'; v: 1; sessionId: string; requestId: string; to: string; cancelTurn: boolean };
export type MoveReplyPayload =
  | { type: 'move-reply'; v: 1; sessionId: string; requestId: string; ok: true; lastRev: number; thread?: { generation: number; bytes: number } }
  | { type: 'move-reply'; v: 1; sessionId: string; requestId: string; ok: false; reason: string };
interface Chunk { v: 1; sessionId: string; generation: number; offset: number; total: number; data: string }
export type ThreadChunkPayload = Chunk & { type: 'thread-chunk'; providerId: string; name: string };
export type AttachmentChunkPayload = Chunk & { type: 'attachment'; attachmentId: string; name: string; mime: string };
export type MovePayload = MoveRequestPayload | MoveReplyPayload | ThreadChunkPayload | AttachmentChunkPayload;

type ChunkMeta<P> = Omit<P, 'v' | 'offset' | 'total' | 'data'>;

/** `bytes` from `fromOffset` on, in chunks of `CHUNK_BYTES`: each fits a record once base64'd. */
export function chunkFile(meta: ChunkMeta<ThreadChunkPayload>, bytes: Buffer, fromOffset: number): ThreadChunkPayload[];
export function chunkFile(meta: ChunkMeta<AttachmentChunkPayload>, bytes: Buffer, fromOffset: number): AttachmentChunkPayload[];
export function chunkFile<P extends ThreadChunkPayload | AttachmentChunkPayload>(meta: ChunkMeta<P>, bytes: Buffer, fromOffset: number): P[] {
  const chunks: P[] = [];
  for (let offset = fromOffset; offset < bytes.length; offset += CHUNK_BYTES) {
    const data = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES)).toString('base64');
    chunks.push({ ...meta, v: 1, offset, total: bytes.length, data } as P);
  }
  return chunks;
}

/** The newest generation's bytes, once every byte up to its `total` has arrived; otherwise `undefined`. */
export function assemble(chunks: Array<{ generation: number; offset: number; total: number; data: string }>): Buffer | undefined {
  if (chunks.length === 0) { return undefined; }
  const generation = Math.max(...chunks.map((c) => c.generation));
  const mine = chunks.filter((c) => c.generation === generation).sort((a, b) => a.offset - b.offset);
  const total = Math.max(...mine.map((c) => c.total));
  const parts: Buffer[] = [];
  let at = 0;
  for (const c of mine) {
    if (c.offset > at) { return undefined; }
    const data = Buffer.from(c.data, 'base64');
    if (c.offset + data.length > at) { parts.push(data.subarray(at - c.offset)); at = c.offset + data.length; }
  }
  return at >= total ? Buffer.concat(parts).subarray(0, total) : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TYPES = new Set(['move-request', 'move-reply', 'thread-chunk', 'attachment']);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseMovePayload(value: unknown): MovePayload | { newerFormat: true } | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !TYPES.has(value.type) || !str(value.sessionId)) { return undefined; }
  if (value.v !== 1) { return typeof value.v === 'number' && value.v > 1 ? { newerFormat: true } : undefined; }
  const chunk = int(value.generation) && int(value.offset) && int(value.total) && typeof value.data === 'string';
  switch (value.type) {
    case 'move-request':
      return str(value.requestId) && str(value.to) && typeof value.cancelTurn === 'boolean' ? value as MoveRequestPayload : undefined;
    case 'move-reply':
      if (!str(value.requestId)) { return undefined; }
      if (value.ok === true) { return int(value.lastRev) ? value as MoveReplyPayload : undefined; }
      return value.ok === false && typeof value.reason === 'string' ? value as MoveReplyPayload : undefined;
    case 'thread-chunk':
      return chunk && str(value.providerId) && str(value.name) ? value as unknown as ThreadChunkPayload : undefined;
    default:
      return chunk && str(value.attachmentId) && str(value.name) && typeof value.mime === 'string' ? value as unknown as AttachmentChunkPayload : undefined;
  }
}
