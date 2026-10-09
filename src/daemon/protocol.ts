import type { ClientFrame, ServerFrame } from '../protocol/daemon-wire';

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export class LineDecoder {
  private tail = '';

  push(chunk: string): string[] {
    this.tail += chunk;
    const parts = this.tail.split('\n');
    this.tail = parts.pop() ?? '';
    if (this.tail.length > MAX_LINE_BYTES) { throw new Error('line too long'); }
    return parts.filter((l) => l !== '');
  }
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
