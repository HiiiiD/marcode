import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileText, ImageIcon, X } from 'lucide-react';
import type { Attachment } from '../../protocol/messages';
import type { PaneState } from '../reducer';
import { useStore } from '../store';

/** The files the next turn will carry, each with its own removal action. */
export function AttachmentChips({ pane }: { pane: PaneState }) {
  const { post } = useStore();
  if (pane.attachments.length === 0) { return null; }

  return (
    <ul
      data-testid="attachment-chips"
      aria-label="Attachments"
      className="flex min-w-0 flex-wrap gap-1"
    >
      {pane.attachments.map((attachment) => (
        <li key={attachment.id}>
          <span
            className={cn(
              'flex max-w-48 items-center gap-1 rounded-md border border-border',
              'bg-muted py-0.5 pl-1.5 pr-0.5 text-xs',
            )}
            title={`${attachment.path} · ${sizeOf(attachment)}`}
          >
            {attachment.kind === 'image'
              ? <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              : <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="truncate">{attachment.name}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4 shrink-0"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => post({
                t: 'attach-remove', id: pane.summary.id, attachmentId: attachment.id,
              })}
            >
              <X />
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function sizeOf(attachment: Attachment): string {
  const kb = attachment.bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
