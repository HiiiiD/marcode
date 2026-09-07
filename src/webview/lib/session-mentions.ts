import type { SessionId, SessionSummary } from '../../protocol/messages';
import type { MentionOption } from './mention-menu';

/**
 * What a row from this source means. Lives here, not in the menu machinery:
 * a source owns its own payload, which is what lets another source be added
 * beside this one without the machinery learning about either.
 *
 * A session row's payload carries nothing beyond its own kind: picking one
 * inserts the session's name as literal text and nothing else. Earlier this
 * carried a `SessionRef` that the host resolved into a recap and appended to
 * the outgoing message — that pull is gone. Pulling another session's
 * content is now something the agent does itself, mid-turn, through
 * `marcode__get_session_context` — never something the host attaches
 * silently because the user typed a name. `RefKind`/`SessionRef` still exist
 * on the wire (see `../../protocol/messages.ts`) and `session-refs.ts` still
 * resolves them — transcripts written before this change carry
 * `SessionRef{kind:'message'|'plan'}` entries and replaying those still has
 * to work.
 */
export type SessionMentionPayload =
  | { kind: 'name' }
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
 * row for each other live session — a fast way to type a session's name,
 * nothing more. Picking a row inserts its slugged name and attaches no
 * payload beyond `{kind: 'name'}`; nothing about the pick reaches the wire.
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
  // Sessions are labeled by their `name`, which is unique by construction
  // (enforced in `SessionManager.rename()`). Two sessions can only collide if
  // they both still hold their default auto-generated names — unlikely but
  // possible if `defaultName`'s counter ever repeats across a reload. The
  // suffix logic stays as a safety net.
  const seen = new Map<string, number>();
  for (const s of referable) { seen.set(s.name, (seen.get(s.name) ?? 0) + 1); }

  for (const s of referable) {
    options.push({
      id: s.id,
      label: (seen.get(s.name) ?? 0) > 1 ? `${s.name} (${shortId(s.id)})` : s.name,
      hint: 'session',
      group: 'Sessions',
      baseToken: slug(s.name),
      payload: { kind: 'name' },
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
