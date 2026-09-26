// Pure pane-layout reconciliation logic, kept dependency-free (no React, no
// `@/...`-aliased imports) so it can be required directly in the Node/mocha
// unit-test harness — see the note on tool-card-format.ts for why that
// constraint exists.
//
// Built on the `LayoutNode` tree from `./layout-tree`, which mirrors
// `PaneLayout` from `protocol/messages.ts` structurally.

import {
  emptySession, flattenLeaves, leafSessionIds, placeSession, rootOrientation, type FlatLeaf, type LayoutNode,
} from './layout-tree';

export interface RosterEntry {
  id: string;
}

/**
 * The set of session ids eligible to have a leaf, derived from the roster
 * (`ClientState.sessions`). This is where "eligibility is roster
 * membership" (see `reconcilePaneLayout`'s doc
 * comment) actually gets decided for both `visibleLeaves` and
 * `reconcilePaneLayout` callers. Only `delete-session` removes a session from
 * the roster entirely; a session the user has explicitly opened (checked in
 * the roster picker) must keep its leaf. Extracted so this decision has its own name
 * and is pinned by a test, rather than living as an easy-to-get-wrong
 * inline `.map()` at each call site.
 */
export function rosterSessionIds(sessions: RosterEntry[]): Set<string> {
  return new Set(sessions.map((s) => s.id));
}

export type LeafDisplayState = 'empty' | 'pending' | 'ready';

/**
 * How a single leaf should render, given its sessionId:
 *  - `empty`: no session assigned (an assignable slot).
 *  - `pending`: a session is assigned but hasn't cleared the roster/snapshot
 *    gate yet — either its snapshot hasn't arrived (`byId`, i.e.
 *    `snapshotArrived`) or, transiently, it has already left the roster and
 *    a `reconcilePaneLayout` pass just hasn't caught up yet. Rendered as an
 *    inert placeholder, never the assign-picker: a picker here would let a
 *    user "assign" a session the tree already points at.
 *  - `ready`: the session is in both the roster and `byId` — render the
 *    real pane.
 */
export function leafDisplayState(
  sessionId: string | null, roster: ReadonlySet<string>, snapshotArrived: ReadonlySet<string>,
): LeafDisplayState {
  if (sessionId === null) { return 'empty'; }
  return roster.has(sessionId) && snapshotArrived.has(sessionId) ? 'ready' : 'pending';
}

export type DisplayLeaf = FlatLeaf & { state: LeafDisplayState };

/**
 * Every leaf in the tree, tagged with how it should render. This never
 * mutates the tree itself — a `pending`/dropped leaf is corrected by
 * `reconcilePaneLayout`, not by hiding it here; this is purely a render-time
 * read, the tree-shaped analogue of the old flat model's `visiblePanes`.
 */
export function visibleLeaves(
  root: LayoutNode, roster: ReadonlySet<string>, snapshotArrived: ReadonlySet<string>,
): DisplayLeaf[] {
  return flattenLeaves(root).map((leaf) => ({ ...leaf, state: leafDisplayState(leaf.sessionId, roster, snapshotArrived) }));
}

export interface ReconcileResult {
  /** The next tree to persist, or `null` if nothing needs to change. */
  root: LayoutNode | null;
  /**
   * The session ids this reconciliation has now "seen" — pass this back in
   * as `knownSessionIds` on the next call (see below).
   */
  knownSessionIds: Set<string>;
}

/**
 * Reconciles a persisted tree against the current roster. The tree IS the
 * user's intent — which sessions have a leaf open is something only the
 * user's own actions (the roster checkbox, "+ New", closing a pane, drag-
 * to-split) get to decide. Session *state* must never be
 * used to derive "should this session have a leaf": a session the
 * user has explicitly opened must keep its leaf, and a live session the
 * user has explicitly closed via the roster checkbox must NOT come back on
 * the next pass just because it's still live and still in `byId`.
 *
 * So reconciliation only ever does two things:
 *  - drops a leaf whose session is no longer in the roster at all (deleted
 *    outright — the one case where the session itself is gone, not just the
 *    user's choice to hide it), via `removeSession`, which also collapses
 *    the leaf's parent split (see its own doc comment for the collapse
 *    rules) — the tree-shaped equivalent of re-splitting sizes evenly
 *    across the remaining flat pane list;
 *  - appends a leaf for a session that has a snapshot in `byId` for the
 *    FIRST time (`snapshotArrivedIds` minus `knownSessionIds`) — this is
 *    what makes a freshly created session open into a pane. A session
 *    already in `knownSessionIds` (because a previous pass already offered
 *    it a leaf, or because it arrived via an explicit `set-visible` from
 *    the roster checkbox) is never auto-appended again, even if the user
 *    just removed its leaf. A bare empty root leaf is filled directly;
 *    otherwise the new leaf is appended as a sibling at the top split
 *    level, wrapping the existing root in a fresh vertical split only when
 *    it isn't already one, and sizes are re-split evenly across the
 *    resulting sibling set.
 *
 * `root` is `null` when nothing needs to change, so a caller driving this
 * from a render effect can skip posting `set-layout` on every pass.
 *
 * ⚠️ `knownSessionIds` is client-only state (a `useRef` in `main.tsx`) and
 * genuinely resets to empty on every reload. That does NOT resurrect
 * previously-unchecked leaves only because of a second, non-obvious
 * invariant this relies on: `newlyArrived` also requires the id to be in
 * `snapshotArrivedIds` (`byId`), and after a reload `byId` is seeded solely
 * from `hydrate.snapshots` — which the host builds from the persisted
 * tree's own leaves (`message-router.ts`'s `ready` handler), NOT from the
 * full roster. An unchecked session has no leaf in the persisted tree, so it
 * gets no snapshot, so it's absent from `byId`, so it can never be
 * `newlyArrived` regardless of what `knownSessionIds` contains. If `ready`
 * ever changed to hydrate snapshots for the whole roster instead of just
 * the tree's leaves, the empty post-reload `knownSessionIds` would treat
 * every roster session as "arriving for the first time" and re-append all
 * of them — silently reintroducing the bug this function exists to fix.
 * This module has no way to enforce that invariant (it lives on the host),
 * so: know this before changing what `ready` hydrates.
 */
export function reconcilePaneLayout(
  root: LayoutNode, roster: ReadonlySet<string>, snapshotArrivedIds: string[], knownSessionIds: ReadonlySet<string>,
  focusedSessionId: string | null = null,
): ReconcileResult {
  let next = root;
  let changed = false;
  for (const id of leafSessionIds(root)) {
    if (!roster.has(id)) { next = emptySession(next, id); changed = true; }
  }

  const stillPresent = new Set(leafSessionIds(next));
  const newlyArrived = snapshotArrivedIds.filter(
    (id) => roster.has(id) && !stillPresent.has(id) && !knownSessionIds.has(id),
  );
  for (const id of newlyArrived) {
    changed = true;
    next = placeSession(next, id, focusedSessionId, rootOrientation(next));
  }

  const nextKnown = new Set(knownSessionIds);
  for (const id of snapshotArrivedIds) { nextKnown.add(id); }

  return { root: changed ? next : null, knownSessionIds: nextKnown };
}

export interface TitledSession {
  id: string;
  title: string;
}

/**
 * The name each currently-visible pane's title-derived controls (the close
 * button, the resize handles either side of it) should actually announce.
 *
 * Session titles are user/host-controlled and can collide — most visibly,
 * every freshly created session starts out titled `'Untitled'` until its
 * first message lands, so two brand-new panes read identically to a screen
 * reader even though they're visually distinguishable side by side. This
 * disambiguates only when a collision actually exists among the given
 * (visible) sessions, and only in the accessible name — the id is stable,
 * always present on every session, and needs no new format invented for it,
 * so it's a safe suffix to add without touching what's rendered on screen.
 */
export function accessibleTitles(sessions: TitledSession[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of sessions) { counts.set(s.title, (counts.get(s.title) ?? 0) + 1); }

  const result = new Map<string, string>();
  for (const s of sessions) {
    result.set(s.id, (counts.get(s.title) ?? 0) > 1 ? `${s.title} (${s.id})` : s.title);
  }
  return result;
}
