import type { ClientFrame, ClientKind, ServerFrame } from '../protocol/daemon-wire';

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_CHARS = 64 * 1024 * 1024;

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** After a throw the decoder is spent; the caller must close the connection. */
export class LineDecoder {
  private pending: string[] = [];
  private pendingLen = 0;

  constructor(private readonly maxChars = MAX_LINE_CHARS) {}

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf('\n');
    while (nl !== -1) {
      const piece = chunk.slice(start, nl);
      const line = this.pending.length === 0 ? piece : this.pending.join('') + piece;
      this.pending = [];
      this.pendingLen = 0;
      if (line.length > this.maxChars) { throw new Error('line too long'); }
      if (line !== '') { lines.push(line); }
      start = nl + 1;
      nl = chunk.indexOf('\n', start);
    }
    const rest = chunk.slice(start);
    if (rest !== '') {
      this.pending.push(rest);
      this.pendingLen += rest.length;
      if (this.pendingLen > this.maxChars) { throw new Error('line too long'); }
    }
    return lines;
  }
}

const CLIENT_KINDS: readonly string[] = ['sidebar', 'review', 'fleet', 'history', 'tui'] satisfies ClientKind[];

/** Token and version are checked separately, so their failures get their own reject reasons. */
export function isHelloShape(h: Extract<ClientFrame, { f: 'hello' }>): boolean {
  return Array.isArray(h.roots) && h.roots.every((r) => typeof r === 'string')
    && CLIENT_KINDS.includes(h.clientKind)
    && typeof h.defaultCwd === 'string'
    && typeof h.appVersion === 'string';
}

export function parseFrame(line: string): { f: string } | undefined {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'object' && v !== null && typeof (v as { f?: unknown }).f === 'string') {
      return v as { f: string };
    }
  } catch { /* garbage is a closed connection, decided by the caller */ }
  return undefined;
}
