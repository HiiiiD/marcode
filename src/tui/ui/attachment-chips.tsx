import type { Attachment } from '../../protocol/messages';

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChips({ attachments, rejected }: { attachments: Attachment[]; rejected: string[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {attachments.map((a) => <text key={a.id} fg="cyan">{`+ ${a.name} (${size(a.bytes)})`}</text>)}
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
