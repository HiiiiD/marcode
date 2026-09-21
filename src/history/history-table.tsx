import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HistoryRow } from './history-row';
import type { HistoryGroups } from './history-rows';

function GroupLabel({ label }: { label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="bg-muted/40 py-1 font-medium text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  );
}

export function HistoryTable({ groups }: { groups: HistoryGroups }) {
  const { pinned, rest } = groups;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Session</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last updated</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pinned.length > 0 && <GroupLabel label="Pinned" />}
        {pinned.map((s) => <HistoryRow key={s.id} session={s} />)}
        {pinned.length > 0 && rest.length > 0 && <GroupLabel label="Sessions" />}
        {rest.map((s) => <HistoryRow key={s.id} session={s} />)}
      </TableBody>
    </Table>
  );
}
