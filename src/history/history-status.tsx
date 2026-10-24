import { CircleAlertIcon, CircleIcon, LoaderCircleIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionSummary } from '../protocol/messages';

export function HistoryStatus({ session }: { session: SessionSummary }) {
  const { status, waitingOn } = session;
  const waiting = status === 'awaiting-approval';
  const question = waiting && waitingOn === 'question';
  const label = waiting
    ? question ? 'Waiting for answer' : 'Waiting for approval'
    : status === 'running' ? 'Running' : status === 'error' ? 'Error' : 'Idle';
  const Icon = waiting
    ? question ? MessageCircleQuestionIcon : ShieldQuestionIcon
    : status === 'running' ? LoaderCircleIcon : status === 'error' ? CircleAlertIcon : CircleIcon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        status === 'error' ? 'text-destructive' : waiting ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
