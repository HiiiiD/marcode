// Pure pane-layout reconciliation logic, kept dependency-free (no React, no
// `@/...`-aliased imports) so it can be required directly in the Node/mocha
// unit-test harness — see the note on tool-card-format.ts for why that
// constraint exists.
//
// Shapes mirror `PaneLayout`/`{ sessionId, size }` from `protocol/messages.ts`
// structurally rather than importing it, so this module has zero import
// surface at all and stays trivially requirable.

export interface PaneEntry {
  sessionId: string;
  size: number;
}

export interface LayoutLike {
  orientation: 'vertical' | 'horizontal';
  panes: PaneEntry[];
}

/** Evenly splits 100% of space across `ids`, in the given order. */
export function evenlySizedPanes(ids: string[], orientation: LayoutLike['orientation']): LayoutLike {
  const size = ids.length > 0 ? 100 / ids.length : 100;
  return { orientation, panes: ids.map((sessionId) => ({ sessionId, size })) };
}

/**
 * The subset of `panes` that should actually render: the session must still
 * be in the roster (i.e. not deleted outright — `delete-session` is the
 * only thing that removes a session from the roster; `close-session` only
 * archives it) *and* its full state must have already arrived in `byId`.
 *
 * Archived is deliberately NOT excluded here: whether an archived session
 * has a pane is the user's call (see `reconcilePaneLayout`'s doc comment on
 * why eligibility can't be derived from session state), not something
 * render-time filtering should second-guess.
 *
 * A pane can outlive `delete-session` on the client for a render or two
 * (the layout the client optimistically applies is only corrected by the
 * reconcile effect one render later), and a stale `byId` entry for a
 * deleted session is never cleaned up client-side either. This is the
 * render-time guard against showing that kind of stale pane.
 */
export function visiblePanes(
  panes: PaneEntry[],
  rosterSessionIds: ReadonlySet<string>,
  snapshotArrivedIds: ReadonlySet<string>,
): PaneEntry[] {
  return panes.filter(
    (p) => rosterSessionIds.has(p.sessionId) && snapshotArrivedIds.has(p.sessionId),
  );
}

export interface ReconcileResult {
  /** The next layout to persist, or `null` if nothing needs to change. */
  layout: LayoutLike | null;
  /**
   * The session ids this reconciliation has now "seen" — pass this back in
   * as `knownSessionIds` on the next call (see below).
   */
  knownSessionIds: Set<string>;
}

/**
 * Reconciles a persisted layout against the current roster. The layout IS
 * the user's intent — which sessions have a pane open is something only the
 * user's own actions (the roster checkbox, "+ New", closing a pane) get to
 * decide. Session *state* (archived or not) must never be used to derive
 * "should this session have a pane": an archived session the user has
 * explicitly opened must keep its pane, and a live session the user has
 * explicitly closed via the roster checkbox must NOT come back on the next
 * pass just because it's still live and still in `byId`.
 *
 * So reconciliation only ever does two things:
 *  - drops a pane whose session is no longer in the roster at all (deleted
 *    outright — the one case where the session itself is gone, not just the
 *    user's choice to hide it);
 *  - appends a pane for a session that has a snapshot in `byId` for the
 *    FIRST time (`snapshotArrivedIds` minus `knownSessionIds`) — this is
 *    what makes a freshly created session open into a pane. A session
 *    already in `knownSessionIds` (because a previous pass already offered
 *    it a pane, or because it arrived via an explicit `set-visible` from
 *    the roster checkbox) is never auto-appended again, even if the user
 *    just removed its pane.
 *
 * Sizes are re-split evenly across the resulting pane set. `layout` is
 * `null` when nothing needs to change, so a caller driving this from a
 * render effect can skip posting `set-layout` on every pass.
 */
export function reconcilePaneLayout(
  layout: LayoutLike,
  rosterSessionIds: ReadonlySet<string>,
  snapshotArrivedIds: string[],
  knownSessionIds: ReadonlySet<string>,
): ReconcileResult {
  const kept = layout.panes
    .map((p) => p.sessionId)
    .filter((id) => rosterSessionIds.has(id));
  const known = new Set(kept);
  const newlyArrived = snapshotArrivedIds.filter(
    (id) => rosterSessionIds.has(id) && !known.has(id) && !knownSessionIds.has(id),
  );

  const nextKnown = new Set(knownSessionIds);
  for (const id of snapshotArrivedIds) { nextKnown.add(id); }

  const unchanged = kept.length === layout.panes.length && newlyArrived.length === 0;
  const nextLayout = unchanged ? null : evenlySizedPanes([...kept, ...newlyArrived], layout.orientation);
  return { layout: nextLayout, knownSessionIds: nextKnown };
}
