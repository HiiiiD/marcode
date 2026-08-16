import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Attachment, AttachmentKind } from '../providers/types';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING = 10;

const IMAGE_EXT = new Map<string, string>([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

/**
 * Kind is decided by mediaType when the clipboard supplied one, and by
 * extension otherwise. Deliberately not by sniffing magic bytes: the only
 * consumer of `kind` is which provider payload an attachment becomes, and a
 * file the user believes is a PNG should travel as one even if it is not —
 * the backend's own error is a better report than a silent reclassification.
 */
function kindOf(name: string, mediaType?: string): { kind: AttachmentKind; mediaType?: string } {
  if (mediaType?.startsWith('image/')) { return { kind: 'image', mediaType }; }
  const guessed = IMAGE_EXT.get(path.extname(name).toLowerCase());
  return guessed ? { kind: 'image', mediaType: guessed } : { kind: 'file' };
}

/**
 * The one thing that mints an `Attachment`.
 *
 * A sibling of TranscriptStore: same rootDir, no `vscode` import, so it unit
 * tests outside the extension host. Pasted bytes are written here because a
 * screenshot has no path of its own; a picked or dropped file is referenced
 * where it already lives, since a file the user already has on disk is
 * already durable and copying it would only create a second thing to keep in
 * sync.
 */
export class AttachmentStore {
  private counter = 0;

  constructor(private readonly rootDir: string) {}

  private dirFor(sessionId: string): string {
    return path.join(this.rootDir, 'attachments', sessionId);
  }

  async savePaste(
    sessionId: string,
    input: { name: string; mediaType?: string; base64: string },
  ): Promise<Attachment | { error: string }> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.base64, 'base64');
    } catch {
      return { error: 'That paste was not readable.' };
    }
    if (bytes.byteLength === 0) { return { error: 'That paste was empty.' }; }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { error: 'Attachments are limited to 10 MB.' };
    }

    const { kind, mediaType } = kindOf(input.name, input.mediaType);
    const id = this.nextId();
    const dir = this.dirFor(sessionId);
    const file = path.join(dir, `${id}${path.extname(input.name) || extFor(mediaType)}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      // Atomic, matching TranscriptStore.writeAtomic: a partial write lands on
      // a temp file and the destination is only ever swapped in whole.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
    } catch (err) {
      return { error: `Could not save that attachment: ${(err as Error).message}` };
    }
    return { id, path: file, name: input.name, kind, mediaType, bytes: bytes.byteLength };
  }

  async adopt(sessionId: string, paths: string[]): Promise<{ attachments: Attachment[]; rejected: string[] }> {
    const attachments: Attachment[] = [];
    const rejected: string[] = [];
    for (const p of paths) {
      let size: number;
      try {
        const stat = await fs.stat(p);
        if (!stat.isFile()) { rejected.push(p); continue; }
        size = stat.size;
      } catch {
        rejected.push(p);
        continue;
      }
      if (size > MAX_ATTACHMENT_BYTES) { rejected.push(p); continue; }
      const name = path.basename(p);
      const { kind, mediaType } = kindOf(name);
      attachments.push({ id: this.nextId(), path: p, name, kind, mediaType, bytes: size });
    }
    return { attachments, rejected };
  }

  /** Reaps a deleted session's pasted files. Best effort: a failure here must not fail the delete. */
  async remove(sessionId: string): Promise<void> {
    await fs.rm(this.dirFor(sessionId), { recursive: true, force: true }).catch(() => {});
  }

  private nextId(): string {
    this.counter += 1;
    return `a${Date.now().toString(36)}${this.counter}`;
  }
}

function extFor(mediaType?: string): string {
  for (const [ext, mt] of IMAGE_EXT) { if (mt === mediaType) { return ext; } }
  return '';
}
