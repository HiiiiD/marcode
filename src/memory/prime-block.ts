import type { MemoryHit } from './types';

const MAX_TERMS = 12;
const MAX_HITS = 3;
const MIN_TERM_LENGTH = 4;
// Measured on a 5-session store: a real match scored ~4, a single shared common word ~1.4. bm25 is corpus-relative, so retune if noise creeps in.
export const MIN_SCORE = 2.5;

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'would', 'could', 'should', 'there', 'their',
  'what', 'when', 'where', 'which', 'about', 'into', 'than', 'then', 'them', 'they', 'your',
  'please', 'want', 'need', 'make', 'just', 'also', 'like', 'some', 'more', 'been', 'does',
]);

/** Distinct content words of a prompt, in first-seen order, for an OR-style recall query. */
export function queryTermsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < MIN_TERM_LENGTH || STOPWORDS.has(raw)) { continue; }
    seen.add(raw);
    if (seen.size === MAX_TERMS) { break; }
  }
  return [...seen];
}

/** The block prepended to a fresh session's first message, or undefined when nothing is worth saying. */
export function buildMemoryBlock(hits: MemoryHit[]): string | undefined {
  const keep = hits.filter((h) => h.score >= MIN_SCORE).slice(0, MAX_HITS);
  if (keep.length === 0) { return undefined; }
  const lines = keep.map((h) => `- ${h.snippet} (sessionId=${h.sessionId} itemId=${h.itemId})`);
  return [
    '<marcode-memory>',
    'Earlier Marcode sessions in this workspace that may relate to this task. '
      + 'Call marcode__recall_fetch with a sessionId/itemId to read one; ignore them if unrelated.',
    ...lines,
    '</marcode-memory>',
  ].join('\n');
}
