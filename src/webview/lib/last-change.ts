import { useRef } from 'react';
import type { TranscriptItem } from '../../protocol/messages';

/** Silence this long on a running turn or worker is worth saying out loud: it is working, or it is stuck, and the UI cannot tell which. */
export const QUIET_AFTER_MS = 60_000;

/** Changes whenever the item visibly progresses: more text, more thinking, another child, a child settling. */
export function activitySignature(item: TranscriptItem | undefined): string {
  if (!item) { return ''; }
  const parts: Array<string | number> = [item.id, item.role];
  if (item.role === 'assistant') { parts.push(item.text.length, item.thinking?.length ?? 0); }
  if (item.role === 'tool') {
    parts.push(item.state);
    for (const child of item.children ?? []) { parts.push(child.id, child.role === 'tool' ? child.state : '', child.role === 'assistant' ? child.text.length : 0); }
  }
  return parts.join('|');
}

/**
 * Client-side clock of the last time each signature changed. Item timestamps
 * are creation times, so a long message or one slow tool would read as silence
 * on a healthy run; a change in the live item is the real activity signal.
 * First sight counts as a change, so a reload restarts the clock.
 */
export function useLastChanges(entries: ReadonlyArray<{ id: string; signature: string }>): ReadonlyMap<string, number> {
  const seen = useRef(new Map<string, { signature: string; at: number }>());
  const now = Date.now();
  const live = new Set<string>();
  for (const { id, signature } of entries) {
    live.add(id);
    const prev = seen.current.get(id);
    if (!prev || prev.signature !== signature) { seen.current.set(id, { signature, at: now }); }
  }
  for (const id of seen.current.keys()) { if (!live.has(id)) { seen.current.delete(id); } }
  return new Map([...seen.current].map(([id, v]) => [id, v.at]));
}

export function useLastChange(signature: string): number {
  return useLastChanges([{ id: 'only', signature }]).get('only') ?? Date.now();
}
