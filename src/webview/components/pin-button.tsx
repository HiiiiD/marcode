import { PinIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePost } from '../store';
import type { SessionSummary } from '../../protocol/messages';

export function PinButton({ session, accessibleTitle }: {
  session: SessionSummary;
  accessibleTitle: string;
}) {
  const post = usePost();
  const pinned = session.pinned === true;
  const label = `${pinned ? 'Unpin' : 'Pin'} ${accessibleTitle}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className="shrink-0"
            onClick={() => post({ t: 'set-pinned', id: session.id, pinned: !pinned })}
          />
        )}
      >
        <PinIcon aria-hidden className={cn(pinned && 'fill-current')} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
