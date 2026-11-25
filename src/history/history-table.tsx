import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { HistoryRow } from './history-row';
import type { HistoryGroups } from './history-rows';

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <TableRow>
      <TableCell colSpan={3} className="bg-muted/40 py-1 text-xs font-medium text-muted-foreground">
        {label}
        <span className="ml-1.5 tabular-nums">{count}</span>
      </TableCell>
    </TableRow>
  );
}

export function HistoryTable({ groups }: { groups: HistoryGroups }) {
  const { pinned, rest } = groups;
  return (
    <Table>
      <TableBody>
        {pinned.length > 0 && <GroupLabel label="Pinned" count={pinned.length} />}
        {pinned.map((s) => <HistoryRow key={s.id} session={s} />)}
        {pinned.length > 0 && rest.length > 0 && <GroupLabel label="Sessions" count={rest.length} />}
        {rest.map((s) => <HistoryRow key={s.id} session={s} />)}
      </TableBody>
    </Table>
  );
}
