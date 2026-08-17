# Fleet Diff Review — deferred work

> **§1, §3 and §5 are done** — see
> [the review tab spec](../specs/2026-08-17-fleet-diff-review-tab-design.md) and
> [its plan](2026-08-17-fleet-diff-review-tab.md). §2 dissolved with the move to
> an editor tab: the panes are never replaced, so a permission card can no
> longer be hidden by the review surface. **§4, §6 and §7 remain open.**

**Status:** the feature shipped on `feat/fleet-diff-review` (tasks 1–9 of
[the plan](2026-08-16-fleet-diff-review.md), plus one remediation commit). Everything below
was found by the `impeccable` critique gate on 2026-08-16 and deliberately **not** done,
either because it is feature-sized rather than a defect, or because it is a design decision
the user should make rather than the implementer.

This file exists so none of it is rediscovered from scratch. Snapshot with full reasoning:
`.impeccable/critique/2026-08-16T10-29-59Z__src-webview.md` (gitignored — regenerate with
`/impeccable critique src/webview` if the file is not in your working tree).

**Score at merge: 24/40.** Trend for this target: 15/40 → 15/40 → 25/36 → 24/40. The
25/36 run scored heuristic 10 as `n/a`, so it is not a like-for-like comparison, but the
proportional direction against the immediately prior run was **down** (69% → 60%). This is
recorded honestly rather than re-measured after the remediation commit: a gate re-scored by
the person who just fixed its findings is not a gate. The score is expected to recover once
the items below land — that recovery has not been measured.

---

## 1. The width gate is the strategic question

**The problem in one line:** PRODUCT.md says the panel is *typically 300–500px*.
`REVIEW_PX = 700`. So at the modal width, the flagship feature of this branch **does not
render at all** — no disabled state, no tooltip, no "widen the panel to review changes".

The gate's reasoning is sound: a file list with churn counts and session chips in a 300px
column is a wall of truncated paths, which is worse than nothing. The *absence of any
compensating affordance* is the defect, not the threshold.

Three ways out, in ascending order of ambition:

1. **Add a hint below the threshold.** Cheapest. A disabled control or a line in the
   working-trees menu saying review needs a wider panel. Fixes discoverability, keeps
   everything else.
2. **Put review in a pane instead of replacing the panes.** At ≥700px there is room for
   both — that is the premise of the gate. A review surface occupying one slot in the
   existing `ResizablePanelGroup` would keep permission cards visible (see §2), reuse the
   resize handles the user already knows, cost zero new focus management, and make "read
   the diff, then tell that agent to fix it" a two-inch mouse move rather than a mode
   switch.
3. **Move it to an editor-area `WebviewPanel`.** The rows already open in VS Code's native
   diff editor — the panel is a launcher, not a viewer. An editor tab gets ~1200px, can sit
   beside the diff it opens, and **deletes the width gate, the 699px unmount whiplash, and
   the discoverability hole in one move**. Cost: a second webview and its transport. This
   was flagged as the deferred v2 when the feature was specced, before any of the above was
   known; it looks more right now than it did then.

---

## 2. The review surface hides blocking permission requests — P1

`FleetDiff` replaces `PaneGroup` entirely. A session entering `awaiting-approval` while
review is open is signalled only by `{needing} needs you` — a `text-primary` span at the
right edge of the roster `DropdownMenuTrigger`, with no `aria-live`, sharing a 24px row
with the split count.

A blocked agent is dead time, and not losing it is the panel's reason to exist. The one
state where the user is deliberately not watching the panes is the one state with no
interruption channel.

**Fix:** an interrupting banner at the top of the surface's scroll container when
`state.sessions.some(s => statusView(s.status).needsUser)` — session title, tool label, and
a control that closes review and scrolls that pane's card into view. `role="alert"`. Do not
rely on the roster trigger.

Note this dissolves entirely under §1 option 2 — a review *pane* never hides the others.

---

## 3. Power-user affordances over a 500-row list — P1

The surface's own doc comment says a tree can carry 500 rows. It ships with:

- no path filter or search
- no collapse on trees or session groups
- no arrow-key navigation — every row is an independent `Button`, so a keyboard user Tabs
  through all 500
- no opened/read marker, so on a 200-file review the user tracks "have I read this" in
  their head
- no next/prev-file control
- no keyboard shortcut to open review at all
- `tree.omitted` announces "N more files are not shown" with **no control to show them** —
  a named dead end

This is almost the entire reason heuristic 7 (Flexibility and Efficiency) scored **1/4**.
It is a power-user's review tool with no power-user path, and the impatient-power-user
persona — the one this feature is *for* — is the one it serves worst.

**Fix, roughly in value order:** a filter `Input` in the header matching `file.path`;
collapse chevrons per tree and per session group, persisted per `root` / `sessionId`; an
opened-path `Set` that dims the basename of rows already visited this session; roving
tabindex over rows; make `omitted` a control that re-requests with a raised cap.

---

## 4. Refresh has no acknowledgement, and no throttle — P2

The Refresh control has no pending state, no disabled state, and no "last read" timestamp.
Click it when the payload is identical and **literally nothing on screen changes** — the
user cannot distinguish "up to date" from "broken". It is also unthrottled: the 750ms
debounce guards only `state.fleetDiffDirty`, not the manual path, so five clicks post five
`request-fleet-diff` messages, each shelling out to git once per tree.

**Fix:** disable while in flight, and either a spinner on the control or a settled "read
just now" caption. Route the manual path through the same debounce.

---

## 5. Structure, not styling — P1 (partially addressed)

The remediation commit added `h3` / `h4` headings, which fixes screen-reader navigation.
The *visual* hierarchy is still flat: three nesting levels (tree → session → file) render at
one type size (`text-xs`), with no indentation, differentiated only by `font-medium` versus
`text-muted-foreground` and ~10px of margin. At 500 rows that hierarchy is gone.

The critique's framing is worth keeping: this surface **borrows** VS Code's SCM vocabulary
rather than deriving its own, and drops the things that make the SCM view work at scale —
per-directory indentation, collapsible groups, per-group count badges, opened state. The
panel's character is present in this surface's *copy* and absent from its *structure*.

The panel also knows things no SCM view knows and surfaces none of them structurally: which
session is still **running** while you read its diff, which file two agents are fighting
over, which files you have already opened. The `also SessionB` string on a shared file is
the one place the fleet's identity shows through, and it is a truncating muted span at the
end of a row that is already out of width.

---

## 6. Smaller items

- **`reviewOpen` is client-only `useState`.** Every other durable UI decision — layout,
  orientation, visible set — round-trips through the host and survives a reload. Review mode
  does not, so the routine window reload that "must cost nothing" costs a review in
  progress. Either persist it or write down why ephemeral view modes are exempt.
- **`state.fleetDiff` is never reset on close**, so reopening flashes the previous list for
  a frame before the fresh request lands. Arguably good (instant content), but undeclared,
  and the stale rows are indistinguishable from current ones for that frame.
- **The loading line has no upper bound.** A tree that takes four seconds shows the same
  static "Reading the working trees…" as one that takes forty milliseconds.
- **`section aria-label="Changes"` duplicates its own `h2`.** The accessible name would be
  better spent on scope, e.g. "Changes across 3 working trees".
- **`use-is-narrow.ts` now exports two thresholds and one hook**, and the filename says
  neither. `use-panel-width.ts` would match what it does.
- **`summarize()` says "N files in M working trees"**, never "across M sessions" — which is
  the axis the surface actually groups by.
- **The 750ms auto-refresh replaces the whole list under a reading user** with no live
  region and nothing saying why. Rows move mid-scan.
- **Session-group headers are not sticky**, only tree headers are, so attribution scrolls
  away while file rows keep coming.

---

## 7. Open design questions

Not defects. Genuine forks where the current behaviour is defensible and undecided.

1. **Is "not attributed" one bucket or two?** A file an agent wrote via
   `Bash("sed -i …")` lands in unattributed looking exactly like a build artifact. The
   surface concedes the failure mode in prose; it could distinguish "nothing claimed this"
   from "a shell command in session B ran at the right time".
2. **What is a session's change set once it commits?** `base: merge-base` includes committed
   work, `head` does not. The surface correctly names which it is showing but never lets the
   user *choose*. Two sessions in one tree — one committing as it goes, one not — are
   measured on incomparable rulers, and the only remedy offered is a sentence explaining
   that they are.
3. **Is a flat 500-row list ever the right answer**, or is the real unit of review "one
   session's work"? The surface groups by session but presents every group at once. A user
   supervising four agents may want "show me what session B did" as the *first* choice
   rather than a scroll target — which would also make the width gate mostly disappear,
   since one session's files fit in 400px far more often than four sessions' do.

---

## What is already done — do not redo

Fixed in `98f849b`, each verified red-first where testable:

- Escape binding, and focus restored to the still-mounted review toggle on close
- `aria-pressed` on the toggle, fed `reviewOpen && canReview` so the shrink-below-700px
  fallback cannot make it claim an open surface
- `h3` / `h4` heading structure
- the shared-file count contradiction — the header now names how many rows are listed under
  more than one session, keeping the deliberate duplication
- `shrink-0 truncate` (self-cancelling: `shrink-0` meant `truncate` could never fire, so
  long filenames pushed the churn column out of the row and clipped the numbers)
- the `h-6` override that made rows 24px against the panel's 28px convention
- the empty state's unsupported cleanliness claim — now distinguishes "no sessions yet" from
  "no session is in a git repository"
- `gitDecoration` fallbacks, via four new `index.css` tokens
- **an invariant violation**: a throw inside `fleetDiff()` was swallowed by
  `MessageRouter`'s catch-all, so no message was emitted and the surface held "Reading the
  working trees…" permanently. `CLAUDE.md` requires errors be state, never exceptions. The
  `fleet-diff` message gained a `reason` and the surface renders "Could not read the
  changes" with Refresh still live.

Fixed before that: a literal **NUL byte** used as a React key sentinel in `fleet-diff.tsx`.
It rendered as a space and worked, but made git and ripgrep classify the whole file as
**binary**, so it silently dropped out of every text search and `git grep`. Replaced with a
prefixed key scheme. If you ever need a sentinel key again, use printable bytes.
