import type { TranscriptItem } from '../protocol/messages';
import { formatElapsed } from './subagent-window';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/** Silence this long on a running turn or worker is worth saying out loud: it is working, or it is stuck, and the UI cannot tell which. */
export const QUIET_AFTER_MS = 60_000;

export type WorkerState = 'needs-you' | 'quiet' | 'running' | 'failed' | 'done';

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
 * The last time each signature changed. Item timestamps are creation times, so a long message or one slow tool
 * would read as silence on a healthy run; a change in the live item is the real activity signal. First sight counts
 * as a change, so a reload restarts the clock.
 */
export class LastChangeClock {
  private readonly seen = new Map<string, { signature: string; at: number }>();

  observe(entries: ReadonlyArray<{ id: string; signature: string }>, now: number): ReadonlyMap<string, number> {
    const live = new Set<string>();
    for (const { id, signature } of entries) {
      live.add(id);
      const prev = this.seen.get(id);
      if (!prev || prev.signature !== signature) { this.seen.set(id, { signature, at: now }); }
    }
    for (const id of this.seen.keys()) { if (!live.has(id)) { this.seen.delete(id); } }
    return new Map([...this.seen].map(([id, v]) => [id, v.at]));
  }
}

/** How long a running worker has gone without visibly progressing; 0 when it is not running. */
export function quietFor(item: ToolItem, now: number, changedAt: number): number {
  return item.state === 'running' ? Math.max(0, now - changedAt) : 0;
}

export function workerState(item: ToolItem, blocked: boolean, now: number, changedAt: number): WorkerState {
  if (blocked) { return 'needs-you'; }
  if (item.state === 'running') { return quietFor(item, now, changedAt) >= QUIET_AFTER_MS ? 'quiet' : 'running'; }
  return item.state === 'ok' ? 'done' : 'failed';
}

export function statusWords(state: WorkerState, quietMs: number): string {
  switch (state) {
    case 'needs-you': return 'Needs you';
    case 'quiet': return `Quiet for ${formatElapsed(quietMs)}`;
    case 'running': return 'Running';
    case 'failed': return 'Failed';
    case 'done': return 'Done';
  }
}

/** Why a worker failed, or undefined when it did not. */
export function workerFailure(item: ToolItem, state: WorkerState): string | undefined {
  if (state !== 'failed') { return undefined; }
  return item.output?.kind === 'text' ? item.output.text : 'The worker stopped before returning a result.';
}

/** A message's time of day. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
