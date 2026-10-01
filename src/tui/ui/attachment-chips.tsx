import type { Attachment } from '../../protocol/messages';
import { Tag } from './termcn/components/ui/tag';

// Each chip is a 3-row bordered box, so an uncapped band can push the composer off a short terminal.
const MAX_CHIPS = 4;

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChips({ attachments, rejected }: { attachments: Attachment[]; rejected: string[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {attachments.slice(0, MAX_CHIPS).map((a) => <Tag key={a.id}>{`${a.name} (${size(a.bytes)})`}</Tag>)}
      </box>
      {attachments.length > MAX_CHIPS ? <text fg="gray">{`+${attachments.length - MAX_CHIPS} more`}</text> : null}
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
