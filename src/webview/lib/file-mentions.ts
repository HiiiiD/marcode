import type { FileRef } from '../../protocol/messages';
import type { MentionOption, PendingMention } from './mention-menu';

/**
 * What a file row from this source means. `ref` travels verbatim into the
 * `'send'` message — see `FileRef` for why a file mention never becomes an
 * attachment.
 */
export type FileMentionPayload = { kind: 'file-ref'; ref: FileRef };

/**
 * The rows the file source contributes to the `@` menu, one per result the
 * host answered `file-search` with — see `mention-menu.ts`'s doc comment,
 * which named this exact module before it existed.
 *
 * `baseToken` is the path, not the name: two files can share a basename, and
 * the path is also what the host resolves the mention against, so the token
 * the user sees in the box is the same string that gets read off disk.
 */
export function fileMentions(files: FileRef[]): MentionOption<FileMentionPayload>[] {
  return files.map((file) => ({
    id: file.path,
    label: file.name,
    hint: directoryOf(file.path),
    group: 'Files',
    baseToken: file.path,
    payload: { kind: 'file-ref', ref: file },
  }));
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * The file references among `pending`, in order. Mirrors `sessionRefsOf`.
 *
 * Generic over `P`, the same way `sessionRefsOf` is: the composer's pending
 * array holds every source's payload in one union (`SessionMentionPayload |
 * FileMentionPayload`), and `Extract` is what lets this function narrow its
 * own arm out of that union without the two source modules importing each
 * other's payload types.
 */
export function fileRefsOf<P extends { kind: string }>(
  pending: PendingMention<P>[],
): FileRef[] {
  return pending
    .filter((p): p is PendingMention<Extract<P, FileMentionPayload>> => p.payload.kind === 'file-ref')
    .map((p) => p.payload.ref);
}
