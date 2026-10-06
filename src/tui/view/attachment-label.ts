import type { Attachment } from '../../protocol/messages';

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const attachmentLabel = (a: Attachment): string => `${a.name} (${size(a.bytes)})`;
