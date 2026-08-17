import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileText, ImageIcon, X } from 'lucide-react';
import type { Attachment } from '../../protocol/messages';
import { previewUriOf } from '../lib/attachment-preview';
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
          <AttachmentChip
            attachment={attachment}
            onRemove={() => post({
              t: 'attach-remove', id: pane.summary.id, attachmentId: attachment.id,
            })}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * One file, named and sized.
 *
 * `onRemove` is optional because the same chip serves a draft and a record: a
 * sent turn shows what it carried and nothing about it can still be taken
 * back, so the control is absent rather than disabled — there is no state in
 * which it could become live again.
 *
 * The name truncates rather than wraps: at 300px a long filename would push
 * the removal control off the chip, and the full path is on the title.
 */
export function AttachmentChip({
  attachment, onRemove,
}: { attachment: Attachment; onRemove?: () => void }) {
  const preview = previewUriOf(attachment);

  return (
    <span
      className={cn(
        'flex max-w-48 items-center gap-1 rounded-md border border-border',
        'bg-muted py-0.5 text-xs',
        onRemove ? 'pl-1.5 pr-0.5' : 'px-1.5',
      )}
      title={`${attachment.path} · ${sizeOf(attachment)}`}
    >
      {preview
        ? (
          // The thumbnail replaces the icon rather than joining it: at this
          // size the image is the identity, and a generic glyph beside it
          // would say only what the picture already says. Square-cropped so a
          // row of chips keeps one rhythm whatever the source aspect ratio.
          <img
            src={preview}
            alt={attachment.name}
            className="size-4 shrink-0 rounded-[2px] object-cover"
          />
        )
        : attachment.kind === 'image'
          ? <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          : <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="truncate">{attachment.name}</span>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-4 shrink-0"
          aria-label={`Remove ${attachment.name}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </span>
  );
}

function sizeOf(attachment: Attachment): string {
  const kb = attachment.bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
