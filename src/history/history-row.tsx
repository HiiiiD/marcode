import { PinIcon, PinOffIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { formatWhen } from './format-when';
import { useStore } from './store';
import type { SessionSummary } from '../protocol/messages';

export function HistoryRow({ session }: { session: SessionSummary }) {
  const { post } = useStore();
  const pinned = session.pinned === true;
  const summary = session.summary?.text || session.title;

  return (
    <TableRow>
      <TableCell className="min-w-40 align-top font-medium">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate">{session.title}</span>
          {session.archived && <Badge variant="secondary">Archived</Badge>}
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-nowrap text-muted-foreground">
        {`${session.providerId} · ${session.model}`}
      </TableCell>
      <TableCell className="align-top whitespace-nowrap tabular-nums text-muted-foreground">
        {formatWhen(session.createdAt)}
      </TableCell>
      <TableCell className="align-top whitespace-nowrap tabular-nums text-muted-foreground">
        {formatWhen(session.updatedAt)}
      </TableCell>
      <TableCell className="min-w-64 align-top text-muted-foreground">
        <p className="line-clamp-2 whitespace-normal" title={summary}>{summary}</p>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${session.name}`}
            onClick={() => post({ t: 'set-pinned', id: session.id, pinned: !pinned })}
          >
            {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Open ${session.name}`}
            onClick={() => post({ t: 'focus-session', id: session.id })}
          >
            Open
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
