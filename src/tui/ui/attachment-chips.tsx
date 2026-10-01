import { useTerminalDimensions } from '@opentui/react';
import type { Attachment } from '../../protocol/messages';
import { Tag } from './termcn/components/ui/tag';

// Each chip is a 3-row bordered box, so an uncapped band can push the composer off a short terminal;
// 12 rows are left for the pane border, title, composer and the "+N more" line.
const MAX_CHIPS = 4;
const chipCap = (rows: number) => Math.max(1, Math.min(MAX_CHIPS, Math.floor((rows - 12) / 3)));

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChips({ attachments, rejected }: { attachments: Attachment[]; rejected: string[] }) {
  const { height } = useTerminalDimensions();
  const cap = chipCap(height);
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {attachments.slice(0, cap).map((a) => <Tag key={a.id}>{`${a.name} (${size(a.bytes)})`}</Tag>)}
      </box>
      {attachments.length > cap ? <text fg="gray">{`+${attachments.length - cap} more`}</text> : null}
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
