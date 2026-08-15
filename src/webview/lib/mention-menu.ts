/**
 * One row in the `@` menu, contributed by a source module.
 *
 * `baseToken` is the source's own idea of how the row reads in the box,
 * without the `@` and without any collision suffix — a session contributes
 * `refactor-store:plan`, a file source would contribute its path. It is also
 * what `filterMentions` searches alongside the label, which is what makes a
 * path-shaped token searchable by path with no change to this module.
 *
 * `P` is the payload type this source contributes. The machinery is generic
 * over it so a new source can add a new payload arm beside this one without
 * touching the menu, and functions that narrow the payload move to that
 * source's module.
 */
export interface MentionOption<P> {
  id: string;
  label: string;
  hint: string;
  /** Heading this row belongs under. Sources supply their own. */
  group: string;
  baseToken: string;
  payload: P;
}

/**
 * A mention the composer holds while the message is being written. `token`
 * is the literal text in the box; it never reaches the wire — it exists so a
 * user who deletes the token deletes the mention with it (see pruneMentions).
 */
export interface PendingMention<P> { token: string; payload: P }

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
export function filterMentions<P>(options: MentionOption<P>[], query: string): MentionOption<P>[] {
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
export function tokenFor<P>(option: MentionOption<P>, taken: string[]): string {
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
export function pruneMentions<P>(text: string, pending: PendingMention<P>[]): PendingMention<P>[] {
  return pending.filter((p) => text.includes(p.token));
}
