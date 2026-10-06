import { useTerminalDimensions } from '@opentui/react';
import type { Attachment } from '../../protocol/messages';
import { attachmentLabel } from '../view/attachment-label';
import { useTokens } from './tokens/tokens-provider';
import { Tag } from './termcn/components/ui/tag';
import { useTheme } from './termcn/hooks/use-theme';

// Each chip is a 3-row bordered box, so an uncapped band can push the composer off a short terminal;
// 12 rows are left for the pane border, title, composer and the "+N more" line.
const MAX_CHIPS = 4;
const chipCap = (rows: number) => Math.max(1, Math.min(MAX_CHIPS, Math.floor((rows - 12) / 3)));

export function AttachmentTag(props: { attachment: Attachment; active?: boolean; onOpen(): void }) {
  const theme = useTheme();
  return (
    <box onMouseDown={() => { props.onOpen(); }}>
      <Tag variant={props.active === false ? 'outline' : 'default'} {...(props.active ? { color: theme.colors.warning } : {})}>
        {attachmentLabel(props.attachment)}
      </Tag>
    </box>
  );
}

/** What a sent message shipped with; the cursor is the one Enter would open. */
export function SentAttachments(props: { attachments: Attachment[]; cursor: number | undefined; onOpen(a: Attachment): void }) {
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {props.attachments.map((a, i) => (
        <AttachmentTag key={a.id} attachment={a} active={i === props.cursor ? true : false} onOpen={() => { props.onOpen(a); }} />
      ))}
    </box>
  );
}

export function AttachmentChips({ attachments, rejected, onOpen }: { attachments: Attachment[]; rejected: string[]; onOpen(a: Attachment): void }) {
  const { height } = useTerminalDimensions();
  const cap = chipCap(height);
  const muted = useTokens()?.textMuted ?? 'gray';
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {attachments.slice(0, cap).map((a) => <AttachmentTag key={a.id} attachment={a} onOpen={() => { onOpen(a); }} />)}
      </box>
      {attachments.length > cap ? <text fg={muted}>{`+${attachments.length - cap} more`}</text> : null}
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
