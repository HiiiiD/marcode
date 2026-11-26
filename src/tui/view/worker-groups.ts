import { groupOf } from '../../client-core/subagent-groups';
import type { TranscriptRow } from './transcript-rows';

type ToolRow = Extract<TranscriptRow, { kind: 'tool' }>;

/** The team row's own id: the first worker keeps its id for its member row. */
export const teamRowId = (groupId: string): string => `group:${groupId}`;

const groupOfRow = (row: TranscriptRow | undefined): string | undefined =>
  row?.kind === 'tool' ? groupOf(row.item) : undefined;

/**
 * Folds consecutive hosted workers of one `spawn_collaborators` call into a team row, the way the panel does; an
 * opened team lists its workers as rows of their own under it, so each one can be selected and acted on.
 */
export function foldWorkerGroups(rows: TranscriptRow[], isOpen: (teamId: string, members: ToolRow[]) => boolean): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const gid = groupOfRow(rows[i]);
    if (gid === undefined) { out.push(rows[i]); continue; }
    const members: ToolRow[] = [];
    while (i < rows.length && groupOfRow(rows[i]) === gid) { members.push(rows[i] as ToolRow); i++; }
    i--;
    if (members.length === 1) { out.push(members[0]); continue; }
    const id = teamRowId(gid);
    out.push({ kind: 'workers', id, items: members.map((m) => m.item) });
    if (isOpen(id, members)) { out.push(...members.map((m): ToolRow => ({ ...m, member: true }))); }
  }
  return out;
}
