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
 * How a colliding token is disambiguated, and — read as a pattern — how a
 * token can be extended by one.
 *
 * These two have to agree, which is why they sit together: `tokenFor` appends
 * the suffix and `tokenPresent` is the only thing entitled to decide that a
 * token is in the text. A bare `text.includes(token)` is not, because
 * `@a:plan` is a substring of `@a:plan-2` — deleting the first of two
 * colliding tokens would leave both references attached and send a payload the
 * user removed.
 */
const collisionSuffix = (n: number) => `-${n}`;
const CONTINUES_TOKEN = /^-\d/;

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
    const candidate = `${base}${collisionSuffix(n)}`;
    if (!taken.includes(candidate)) { return candidate; }
  }
}

/**
 * Whether `token` stands in `text` as itself, rather than only as the opening
 * of a longer token the collision suffix produced.
 */
export function tokenPresent(text: string, token: string): boolean {
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (!CONTINUES_TOKEN.test(text.slice(at + token.length))) { return true; }
  }
  return false;
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
  return pending.filter((p) => tokenPresent(text, p.token));
}
