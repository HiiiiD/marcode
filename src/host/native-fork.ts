import type { SessionState, TranscriptItem } from '../protocol/messages';
import type { AgentProvider } from '../providers/types';
import { lifecycleDebug } from '../shared/lifecycle-debug';
import { threadKey } from '../shared/thread-key';
import { withTimeout } from '../shared/with-timeout';

export interface NativeForkPlan { turnIndex?: number }

/**
 * Where in the provider's thread a copy of `all.slice(0, copied)` ends, or
 * `undefined` when it ends mid-turn: the provider can only cut at a turn
 * boundary, and a native fork that kept more than the copied transcript shows
 * would put words in the fork's mouth.
 */
export function planNativeFork(all: TranscriptItem[], copied: number): NativeForkPlan | undefined {
  if (copied === 0) { return undefined; }
  const next = all[copied];
  if (next === undefined) { return {}; }
  if (next.role !== 'user') { return undefined; }
  const turnIndex = all.slice(0, copied).filter((i) => i.role === 'user').length - 1;
  return turnIndex >= 0 ? { turnIndex } : undefined;
}

/**
 * Asks the provider to branch `source`'s thread. Never throws: every way of
 * not getting a token (no hook, busy source, no token, decline, error,
 * timeout) is `undefined`, and the caller seeds instead.
 */
export async function nativeFork(
  provider: AgentProvider, source: SessionState, plan: NativeForkPlan, timeoutMs: number,
): Promise<{ key: string; token: string } | undefined> {
  if (!provider.forkThread || source.status !== 'idle') { return undefined; }
  const key = threadKey(provider.id, provider.threadScope, source.cwd);
  const resumeToken = source.resumeTokens[key];
  if (!resumeToken) { return undefined; }
  try {
    const result = await withTimeout(
      provider.forkThread({
        resumeToken, cwd: source.cwd,
        ...(plan.turnIndex !== undefined ? { turnIndex: plan.turnIndex } : {}),
      }),
      timeoutMs, 'fork timed out',
    );
    return result ? { key, token: result.resumeToken } : undefined;
  } catch (err) {
    lifecycleDebug('session.fork-fallback', {
      id: source.id, providerId: provider.id, reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
