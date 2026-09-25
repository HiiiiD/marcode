import type { TranscriptItem } from '../protocol/messages';
import { extractiveDigest, indexLine } from './digest';

/** The extractive one-liner. Kept for the memory-off history path. */
export function digestSession(items: TranscriptItem[]): string {
  const digest = extractiveDigest(items, 0);
  return digest ? indexLine(digest) : '';
}
