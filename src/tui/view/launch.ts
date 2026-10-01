import { leafSessionIds } from '../../client-core/layout-tree';
import type { PaneLayout, ProviderInfo, SessionId, SessionSummary } from '../../protocol/messages';

export type LaunchPlan =
  | { kind: 'wait' }
  | { kind: 'resume'; sessionId: SessionId }
  | { kind: 'create'; providerId: string; model?: string; seed?: { text: string } }
  | { kind: 'empty'; pendingPrompt?: string };

export function launchPlan(a: {
  ready: boolean; probing: boolean; sessions: SessionSummary[]; catalog: ProviderInfo[];
  layout: PaneLayout; prompt?: string; forceNew: boolean;
}): LaunchPlan {
  if (!a.ready) { return { kind: 'wait' }; }
  const newest = [...a.sessions].sort((x, y) => y.updatedAt - x.updatedAt)[0];
  if (a.forceNew || a.prompt) {
    const provider = a.catalog.find((p) => p.id === newest?.providerId) ?? a.catalog[0];
    if (!provider) {
      if (a.probing) { return { kind: 'wait' }; }
      return a.prompt ? { kind: 'empty', pendingPrompt: a.prompt } : { kind: 'empty' };
    }
    return {
      kind: 'create', providerId: provider.id, model: provider.models[0]?.id,
      ...(a.prompt ? { seed: { text: a.prompt } } : {}),
    };
  }
  const known = new Set(a.sessions.map((s) => s.id));
  const focused = a.layout.focusedSessionId;
  if (focused && known.has(focused)) { return { kind: 'resume', sessionId: focused }; }
  const leaf = leafSessionIds(a.layout.root).find((id) => known.has(id));
  if (leaf) { return { kind: 'resume', sessionId: leaf }; }
  if (newest) { return { kind: 'resume', sessionId: newest.id }; }
  return a.catalog.length === 0 && a.probing ? { kind: 'wait' } : { kind: 'empty' };
}
