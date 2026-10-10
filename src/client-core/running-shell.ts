import type { ShellItem, TranscriptItem } from '../protocol/messages';

/** The command still running in a session, if any: what the pinned bar offers to cancel. */
export function runningShell(items: readonly TranscriptItem[]): ShellItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role === 'shell' && item.state === 'running') { return item; }
  }
  return undefined;
}
