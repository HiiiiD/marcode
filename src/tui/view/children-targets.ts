import { childrenRows } from '../../client-core/children-rows';
import type { SessionId, SessionSummary } from '../../protocol/messages';

export interface ChildTarget {
  /** Null for a parent that no longer exists: shown, never opened. */
  id: SessionId | null;
  label: string;
}

/** The rows of the branches dialog: where this session came from, then what branched off it. */
export function childTargets(summary: SessionSummary, roster: SessionSummary[]): ChildTarget[] {
  const targets: ChildTarget[] = [];
  if (summary.parentId) {
    const parent = roster.find((s) => s.id === summary.parentId);
    targets.push(parent
      ? { id: parent.id, label: `↑ Branched from ${parent.title}` }
      : { id: null, label: '↑ Branched from a deleted chat' });
  }
  for (const row of childrenRows(summary.children)) {
    targets.push({ id: row.id, label: `${row.badge} · ${row.title}${row.status === 'idle' ? '' : ` · ${row.status}`}` });
  }
  return targets;
}
