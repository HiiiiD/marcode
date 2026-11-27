import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { deviceLabel } from '../client-core/device-label';
import { HistoryRow } from './history-row';
import type { DeviceGroup, HistoryGroups } from './history-rows';

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <TableRow>
      <TableCell colSpan={3} className="bg-muted/40 py-1 text-xs font-medium text-muted-foreground">
        {label}
        <span className="ml-2 tabular-nums">{count}</span>
      </TableCell>
    </TableRow>
  );
}

function DeviceRows({ group }: { group: DeviceGroup }) {
  return (
    <>
      <GroupLabel label={deviceLabel(group)} count={group.sessions.length} />
      {group.newerFormat && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={3} className="whitespace-normal text-xs text-muted-foreground">
            {`A newer Marcode on ${group.deviceName} wrote data this one can't read; update.`}
          </TableCell>
        </TableRow>
      )}
      {group.sessions.map((s) => <HistoryRow key={s.id} session={s} />)}
    </>
  );
}

export function HistoryTable({ groups }: { groups: HistoryGroups }) {
  const { pinned, rest, devices } = groups;
  return (
    <Table>
      <TableBody>
        {pinned.length > 0 && <GroupLabel label="Pinned" count={pinned.length} />}
        {pinned.map((s) => <HistoryRow key={s.id} session={s} />)}
        {(pinned.length > 0 || devices.length > 0) && rest.length > 0 && <GroupLabel label="Sessions" count={rest.length} />}
        {rest.map((s) => <HistoryRow key={s.id} session={s} />)}
        {devices.map((g) => <DeviceRows key={g.deviceId} group={g} />)}
      </TableBody>
    </Table>
  );
}
