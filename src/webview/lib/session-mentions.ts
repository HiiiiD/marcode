import type { SessionId, SessionRef, SessionSummary } from '../../protocol/messages';
import type { MentionOption, PendingMention } from './mention-menu';

/**
 * What a row from this source means. Lives here, not in the menu machinery:
 * a source owns its own payload, which is what lets another source be added
 * beside this one without the machinery learning about either.
 */
export type SessionMentionPayload =
  | { kind: 'session-ref'; ref: SessionRef }
  | { kind: 'action'; action: 'handoff' };

/**
 * Slugs a session title into a token-safe fragment.
 *
 * Capped, because the token is literal text the user has to read and edit
 * inside their own sentence, and a session titled with a whole paragraph
 * would otherwise put that paragraph in the box.
 */
function slug(title: string): string {
  const out = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (out.length > 0 ? out : 'session').slice(0, 24);
}

/**
 * The rows sessions contribute to the `@` menu: the handoff gesture, then one
 * row for each other live session.
 *
 * One row per session, not one per `RefKind`. Crossing the two put a pair of
 * rows on screen carrying the same title, separated only by a hint in the
 * right margin of a 300px pane — and the `plan` half of every pair referenced
 * something most sessions have never produced, so picking it got the message
 * refused at send time. `message` is the kind a session always has if it has
 * anything at all, and it is now the only kind this menu offers. `RefKind`
 * keeps its other arm: transcripts written before this change still carry
 * plan references, and the host still resolves and renders them.
 *
 * One of possibly several sources — the composer concatenates what each
 * source offers, so adding file tagging later means adding a module beside
 * this one and one more array in the caller.
 *
 * `handoffAvailable` is a boolean rather than the catalog: whether there is a
 * provider to create against is the caller's knowledge, and a row that opens a
 * dialog which is not rendered looks like it worked and does nothing. Not
 * offering it is the only honest shape.
 */
export function sessionMentions(
  sessions: SessionSummary[], selfId: SessionId, handoffAvailable: boolean,
): MentionOption<SessionMentionPayload>[] {
  const options: MentionOption<SessionMentionPayload>[] = [];
  if (handoffAvailable) {
    options.push({
      id: 'handoff',
      label: 'handoff',
      hint: 'start a new session from this one',
      group: 'Actions',
      baseToken: 'handoff',
      payload: { kind: 'action', action: 'handoff' },
    });
  }

  const referable = sessions.filter((s) => s.id !== selfId && !s.archived);
  // Every session starts titled `Untitled`, so two rows reading the same word
  // with the same hint is the common case, not the edge one — and the only
  // thing telling them apart otherwise is a collision suffix inside a token
  // the user has not looked at yet.
  const seen = new Map<string, number>();
  for (const s of referable) { seen.set(s.title, (seen.get(s.title) ?? 0) + 1); }

  for (const s of referable) {
    options.push({
      id: s.id,
      label: (seen.get(s.title) ?? 0) > 1 ? `${s.title} (${shortId(s.id)})` : s.title,
      hint: 'last reply',
      group: 'Sessions',
      baseToken: slug(s.title),
      payload: {
        kind: 'session-ref',
        ref: { sessionId: s.id, kind: 'message', title: s.title },
      },
    });
  }
  return options;
}

/**
 * The tail of a session id, as a disambiguator for two identically titled
 * sessions. The tail rather than the head: ids share a generated prefix often
 * enough that the first characters are the ones that do not differ.
 */
function shortId(id: SessionId): string {
  return id.slice(-4);
}

/**
 * The session references among `pending`, in order.
 *
 * The composer sends `SessionRef[]` on the wire, and only some payload kinds
 * are references — an action row is a gesture, not a reference.
 *
 * The predicate is doing real work: a plain boolean filter does not narrow
 * the mapped element, which is what forced an unchecked cast here before. With
 * the predicate the compiler keeps the filter and the projection in step, so a
 * payload arm added later cannot silently fall through as `undefined`.
 */
export function sessionRefsOf(
  pending: PendingMention<SessionMentionPayload>[],
): SessionRef[] {
  return pending
    .filter((p): p is PendingMention<{ kind: 'session-ref'; ref: SessionRef }> =>
      p.payload.kind === 'session-ref')
    .map((p) => p.payload.ref);
}
