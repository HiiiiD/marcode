import type { EffortLevel, PermissionMode, ProviderInfo, SessionSummary } from '../protocol/messages';
import { findModel } from '../shared/model-catalog';

export interface RecentCombo {
  providerId: string;
  model: string;
  effort?: EffortLevel;
  mode: PermissionMode;
}

const keyOf = (c: RecentCombo) => `${c.providerId}\u0000${c.model}\u0000${c.effort ?? ''}\u0000${c.mode}`;

/**
 * The last few distinct model + effort + mode triples the user actually
 * created sessions with, newest first.
 *
 * Read off the roster rather than stored: every session already carries the
 * three values it was created with, so "recent" needs no extra state to keep
 * in step, and it survives a reload for free. A triple whose provider or
 * model has left the catalog is skipped — offering it would create against
 * something the host cannot run.
 */
export function recentCombos(
  sessions: readonly SessionSummary[], catalog: readonly ProviderInfo[], limit = 4,
): RecentCombo[] {
  const seen = new Set<string>();
  const out: RecentCombo[] = [];
  const newestFirst = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  for (const s of newestFirst) {
    if (s.kind === 'subagent' || s.kind === 'side') { continue; }
    const provider = catalog.find((p) => p.id === s.providerId);
    const model = provider ? findModel(provider.models, s.model) : undefined;
    if (!provider || !model) { continue; }
    const combo: RecentCombo = {
      providerId: provider.id, model: model.id, mode: s.permissionMode,
      ...(s.effort && model.effort?.levels.includes(s.effort) ? { effort: s.effort } : {}),
    };
    const key = keyOf(combo);
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(combo);
    if (out.length === limit) { break; }
  }
  return out;
}
