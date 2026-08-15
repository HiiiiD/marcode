import type { SessionRef } from '../../protocol/messages';

/**
 * What picking a row means. Discriminated so the menu machinery can stay
 * ignorant of it: a new source adds an arm here and its own module, and
 * nothing in this file changes.
 *
 * The file arm is deliberately absent — tagging a file in the session's cwd
 * is a planned source, not a built one, and an unused arm would be a claim
 * the menu cannot honour yet.
 */
export type MentionPayload =
  | { kind: 'session-ref'; ref: SessionRef }
  | { kind: 'action'; action: 'handoff' };

/**
 * One row in the `@` menu, contributed by a source module.
 *
 * `baseToken` is the source's own idea of how the row reads in the box,
 * without the `@` and without any collision suffix — a session contributes
 * `refactor-store:plan`, a file source would contribute its path. It is also
 * what `filterMentions` searches alongside the label, which is what makes a
 * path-shaped token searchable by path with no change to this module.
 */
export interface MentionOption {
  id: string;
  label: string;
  hint: string;
  /** Heading this row belongs under. Sources supply their own. */
  group: string;
  baseToken: string;
  payload: MentionPayload;
}

/**
 * A mention the composer holds while the message is being written. `token`
 * is the literal text in the box; it never reaches the wire — it exists so a
 * user who deletes the token deletes the mention with it (see pruneMentions).
 */
export interface PendingMention { token: string; payload: MentionPayload }

/**
 * The active `@` query and where it starts, or `undefined` for "no menu".
 *
 * Unlike the `/` menu this triggers anywhere a word can start, because a
 * mention belongs inside a sentence rather than instead of one. An `@`
 * glued to the previous character is not a trigger, which is what keeps email
 * addresses and npm scopes from opening it.
 */
export function mentionQuery(
  text: string, caret: number,
): { query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) { return undefined; }
  if (start > 0 && !/\s/.test(before[start - 1])) { return undefined; }
  const query = before.slice(start + 1);
  if (/\s/.test(query)) { return undefined; }
  return { query, start };
}

/** Rows matching `query` on either their label or their base token. */
export function filterMentions(options: MentionOption[], query: string): MentionOption[] {
  if (query.length === 0) { return options; }
  const needle = query.toLowerCase();
  return options.filter((o) =>
    o.label.toLowerCase().includes(needle) || o.baseToken.toLowerCase().includes(needle));
}

/**
 * The literal token for a row, unique against `taken`.
 *
 * Two rows can share a base token — every session starts as `Untitled`, and
 * two directories can hold the same filename — and a duplicate would make
 * `pruneMentions` unable to tell which mention the user deleted.
 */
export function tokenFor(option: MentionOption, taken: string[]): string {
  const base = `@${option.baseToken}`;
  if (!taken.includes(base)) { return base; }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) { return candidate; }
  }
}

/** Replaces the `@query` span with `token`, leaving the caret after it. */
export function spliceMention(
  text: string, start: number, caret: number, token: string,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, start)}${token}${text.slice(caret)}`,
    caret: start + token.length,
  };
}

/** The mentions whose tokens are still present in the text. */
export function pruneMentions(text: string, pending: PendingMention[]): PendingMention[] {
  return pending.filter((p) => text.includes(p.token));
}

/**
 * The session references among `pending`, in order.
 *
 * The composer sends `SessionRef[]` on the wire, and only some payload kinds
 * are references — an action row is a gesture, not a reference, and a future
 * file row will carry a path rather than a session id.
 */
export function sessionRefsOf(pending: PendingMention[]): SessionRef[] {
  return pending
    .filter((p) => p.payload.kind === 'session-ref')
    .map((p) => (p.payload as { kind: 'session-ref'; ref: SessionRef }).ref);
}
