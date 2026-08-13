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
 * be "eligible" (present in the roster and not archived — see
 * `eligibleSessionIds` below) *and* its full state must have already
 * arrived in `byId`.
 *
 * A pane can outlive both `close-session` (only `delete-session` prunes the
 * persisted layout, so a closed session's pane lingers, archived) and
 * `delete-session` itself on the client (the layout the client optimistically
 * applies is only corrected by the reconcile effect one render later) — and
 * a stale `byId` entry for either case is never cleaned up client-side. This
 * is the render-time guard against showing either kind of stale pane.
 */
export function visiblePanes(
  panes: PaneEntry[],
  eligibleSessionIds: ReadonlySet<string>,
  snapshotArrivedIds: ReadonlySet<string>,
): PaneEntry[] {
  return panes.filter(
    (p) => eligibleSessionIds.has(p.sessionId) && snapshotArrivedIds.has(p.sessionId),
  );
}

/**
 * Reconciles a persisted layout against the current roster:
 *  - a pane pointing at a session that is no longer eligible — archived, or
 *    deleted outright and no longer in the roster at all — is dropped;
 *  - a session whose snapshot has arrived (`snapshotArrivedIds`) but is not
 *    yet in the layout gets appended as a new pane (a freshly created
 *    session, or one just reopened).
 * Sizes are re-split evenly across the resulting pane set. Returns `null`
 * when nothing needs to change, so a caller driving this from a render
 * effect can skip posting `set-layout` on every pass.
 */
export function reconcilePaneLayout(
  layout: LayoutLike,
  eligibleSessionIds: ReadonlySet<string>,
  snapshotArrivedIds: string[],
): LayoutLike | null {
  const kept = layout.panes
    .map((p) => p.sessionId)
    .filter((id) => eligibleSessionIds.has(id));
  const known = new Set(kept);
  const missing = snapshotArrivedIds.filter(
    (id) => eligibleSessionIds.has(id) && !known.has(id),
  );

  const unchanged = kept.length === layout.panes.length && missing.length === 0;
  if (unchanged) { return null; }

  return evenlySizedPanes([...kept, ...missing], layout.orientation);
}
