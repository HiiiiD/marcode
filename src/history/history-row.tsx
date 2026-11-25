import { useState } from 'react';
import { ChevronRightIcon, PinIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatWhen } from './format-when';
import { TipButton } from './tip-button';
import { HistoryStatus } from './history-status';
import { useStore } from './store';
import type { SessionSummary } from '../protocol/messages';

export function HistoryRow({ session }: { session: SessionSummary }) {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const pinned = session.pinned === true;
  const waiting = session.status === 'awaiting-approval';
  const summary = session.summary?.text || session.title;

  return (
    <>
      <TableRow className={cn(waiting && 'bg-attention/10 hover:bg-attention/15')}>
        <TableCell className="w-8 align-top">
          <TipButton
            tip={open ? 'Collapse' : 'Expand'}
            label={`${open ? 'Collapse' : 'Expand'} ${session.name}`}
            expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChevronRightIcon aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          </TipButton>
        </TableCell>
        <TableCell className="w-full max-w-0 align-top whitespace-normal">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span className="truncate font-medium">{session.name}</span>
            <HistoryStatus session={session} />
          </div>
          <div className="truncate text-muted-foreground">{session.title}</div>
          <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground/80">
            <span>{`${session.providerId} · ${session.model}`}</span>
            <span>{formatWhen(session.updatedAt)}</span>
          </div>
        </TableCell>
        <TableCell className="align-top">
          <div className="flex items-center justify-end gap-1">
            {(session.status === 'running' || session.status === 'awaiting-approval') && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`Stop ${session.name}`}
                disabled={session.owner !== undefined}
                title={session.owner ? 'Stop this session in its owning host' : undefined}
                onClick={() => post({ t: 'interrupt', id: session.id })}
              >
                Stop
              </Button>
            )}
            {state.memory?.enabled && (
              <TipButton
                tip="Re-summarize"
                label={`Re-summarize ${session.name}`}
                onClick={() => post({ t: 'memory-resummarize', id: session.id })}
              >
                <RefreshCwIcon aria-hidden />
              </TipButton>
            )}
            <TipButton
              tip={pinned ? 'Unpin' : 'Pin'}
              label={`${pinned ? 'Unpin' : 'Pin'} ${session.name}`}
              onClick={() => post({ t: 'set-pinned', id: session.id, pinned: !pinned })}
            >
              <PinIcon aria-hidden className={cn(pinned ? 'fill-current' : 'text-muted-foreground')} />
            </TipButton>
            <Button
              variant={session.open ? 'ghost' : 'outline'}
              size="sm"
              aria-label={`${session.open ? 'Opened' : 'Open'} ${session.name}`}
              disabled={session.open === true}
              onClick={() => post({ t: 'focus-session', id: session.id })}
            >
              {session.open ? 'Opened' : 'Open'}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={2} className="whitespace-normal pb-3 pt-0">
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
