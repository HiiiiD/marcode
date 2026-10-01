import type { Attachment } from '../../protocol/messages';
import { Tag } from './termcn/components/ui/tag';

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChips({ attachments, rejected }: { attachments: Attachment[]; rejected: string[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {attachments.map((a) => <Tag key={a.id}>{`${a.name} (${size(a.bytes)})`}</Tag>)}
      </box>
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
