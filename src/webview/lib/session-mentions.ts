import type { RefKind, SessionId, SessionRef, SessionSummary } from '../../protocol/messages';
import type { MentionOption, PendingMention } from './mention-menu';

/**
 * What a row from this source means. Lives here, not in the menu machinery:
 * a source owns its own payload, which is what lets another source be added
 * beside this one without the machinery learning about either.
 */
export type SessionMentionPayload =
  | { kind: 'session-ref'; ref: SessionRef }
  | { kind: 'action'; action: 'handoff' };

const KINDS: { kind: RefKind; hint: string }[] = [
  { kind: 'message', hint: 'last reply' },
  { kind: 'plan', hint: 'last plan' },
];

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
 * The rows sessions contribute to the `@` menu: the handoff gesture, then
 * every other live session crossed with the payload kinds.
 *
 * One of possibly several sources — the composer concatenates what each
 * source offers, so adding file tagging later means adding a module beside
 * this one and one more array in the caller.
 */
export function sessionMentions(
  sessions: SessionSummary[], selfId: SessionId,
): MentionOption<SessionMentionPayload>[] {
  const options: MentionOption<SessionMentionPayload>[] = [{
    id: 'handoff',
    label: 'handoff',
    hint: 'start a new session from this one',
    group: 'Actions',
    baseToken: 'handoff',
    payload: { kind: 'action', action: 'handoff' },
  }];

  for (const s of sessions) {
    if (s.id === selfId || s.archived) { continue; }
    for (const { kind, hint } of KINDS) {
      options.push({
        id: `${s.id}:${kind}`,
        label: s.title,
        hint,
        group: 'Sessions',
        baseToken: `${slug(s.title)}:${kind}`,
        payload: { kind: 'session-ref', ref: { sessionId: s.id, kind, title: s.title } },
      });
    }
  }
  return options;
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
