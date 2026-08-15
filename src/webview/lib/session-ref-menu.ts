import type { RefKind, SessionId, SessionRef, SessionSummary } from '../../protocol/messages';

/** One row in the `@` menu. `handoff` is the only kind with no source session. */
export interface RefOption {
  id: string;
  label: string;
  hint: string;
  kind: RefKind | 'handoff';
  sessionId?: SessionId;
}

/**
 * A reference the composer holds while the message is being written. `token`
 * is the literal text in the box; it never reaches the wire — it exists so a
 * user who deletes the token deletes the reference with it (see pruneRefs).
 */
export interface PendingRef { token: string; ref: SessionRef }

const KINDS: { kind: RefKind; hint: string }[] = [
  { kind: 'message', hint: 'last reply' },
  { kind: 'plan', hint: 'last plan' },
];

/**
 * The active `@` query and where it starts, or `undefined` for "no menu".
 *
 * Unlike the `/` menu this triggers anywhere a word can start, because a
 * reference belongs inside a sentence rather than instead of one. An `@`
 * glued to the previous character is not a trigger, which is what keeps email
 * addresses and npm scopes from opening it.
 */
export function refQuery(
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

/** `@handoff`, then every other live session crossed with the payload kinds. */
export function refOptions(sessions: SessionSummary[], selfId: SessionId): RefOption[] {
  const options: RefOption[] = [{
    id: 'handoff',
    label: 'handoff',
    hint: 'start a new session from this one',
    kind: 'handoff',
  }];
  for (const s of sessions) {
    if (s.id === selfId || s.archived) { continue; }
    for (const { kind, hint } of KINDS) {
      options.push({ id: `${s.id}:${kind}`, label: s.title, hint, kind, sessionId: s.id });
    }
  }
  return options;
}

export function filterRefOptions(options: RefOption[], query: string): RefOption[] {
  if (query.length === 0) { return options; }
  const needle = query.toLowerCase();
  return options.filter((o) =>
    o.label.toLowerCase().includes(needle) || o.kind.toLowerCase().includes(needle));
}

function slug(label: string): string {
  const out = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (out.length > 0 ? out : 'session').slice(0, 24);
}

/**
 * The literal token for an option, unique against `taken`.
 *
 * Two sessions can share a title — every session starts as `Untitled` — and a
 * duplicate token would make `pruneRefs` unable to tell which reference the
 * user deleted.
 */
export function tokenFor(option: RefOption, taken: string[]): string {
  const base = `@${slug(option.label)}:${option.kind}`;
  if (!taken.includes(base)) { return base; }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) { return candidate; }
  }
}

/** Replaces the `@query` span with `token`, leaving the caret after it. */
export function spliceRef(
  text: string, start: number, caret: number, token: string,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, start)}${token}${text.slice(caret)}`,
    caret: start + token.length,
  };
}

/** The references whose tokens are still present in the text. */
export function pruneRefs(text: string, pending: PendingRef[]): PendingRef[] {
  return pending.filter((p) => text.includes(p.token));
}
