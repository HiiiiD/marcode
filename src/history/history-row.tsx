import { useState } from 'react';
import { ChevronRightIcon, PinIcon, PinOffIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatWhen } from './format-when';
import { useStore } from './store';
import type { SessionSummary } from '../protocol/messages';

export function HistoryRow({ session }: { session: SessionSummary }) {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const pinned = session.pinned === true;
  const summary = session.summary?.text || session.title;

  return (
    <>
      <TableRow>
        <TableCell className="w-8 align-middle">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${session.name}`}
            onClick={() => setOpen(!open)}
          >
            <ChevronRightIcon aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          </Button>
        </TableCell>
        <TableCell className="min-w-40 align-middle font-medium">
          <span className="truncate">{session.title}</span>
        </TableCell>
        <TableCell className="align-middle whitespace-nowrap text-muted-foreground">
          {`${session.providerId} · ${session.model}`}
        </TableCell>
        <TableCell className="align-middle whitespace-nowrap tabular-nums text-muted-foreground">
          {formatWhen(session.updatedAt)}
        </TableCell>
        <TableCell className="align-middle">
          <div className="flex items-center justify-end gap-1">
            {state.memory?.enabled && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Re-summarize ${session.name}`}
                onClick={() => post({ t: 'memory-resummarize', id: session.id })}
              >
                <RefreshCwIcon aria-hidden />
              </Button>
            )}
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
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={4} className="whitespace-normal pb-3 pt-0">
            <p className="text-muted-foreground">{summary}</p>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {`Created ${formatWhen(session.createdAt)}`}
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
