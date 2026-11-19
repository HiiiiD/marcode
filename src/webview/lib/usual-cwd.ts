import type { SessionSummary } from '../../protocol/messages';

/** The working directory most of the roster runs in; a pane in any other one is worth naming. */
export function usualCwd(sessions: readonly SessionSummary[]): string | undefined {
  const counts = new Map<string, number>();
  for (const s of sessions) { counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1); }
  let best: string | undefined;
  let max = 0;
  for (const [cwd, n] of counts) {
    if (n > max) { best = cwd; max = n; }
  }
  return best;
}
