import * as fs from 'node:fs';
import type { Attachment } from './types';

/**
 * The prompt text a non-image attachment contributes.
 *
 * Images contribute nothing here: they go to the backend as a native image
 * input, and naming them in the text as well would tell the model to read a
 * file it can already see.
 */
export function attachmentLines(attachments: Attachment[] | undefined): string {
  const files = (attachments ?? []).filter((attachment) => attachment.kind !== 'image');
  if (files.length === 0) { return ''; }
  const lines = files.map((attachment) => `- ${attachment.path}`).join('\n');
  return `\n\nAttached files:\n${lines}`;
}

export function imageAttachments(attachments: Attachment[] | undefined): Attachment[] {
  return (attachments ?? []).filter((attachment) => attachment.kind === 'image');
}

/** Base64 for an image attachment, or undefined if it has gone since it was attached. */
export function readBase64(attachment: Attachment): string | undefined {
  try {
    return fs.readFileSync(attachment.path).toString('base64');
  } catch {
    return undefined;
  }
}
