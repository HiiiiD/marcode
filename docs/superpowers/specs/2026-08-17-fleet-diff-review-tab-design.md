# Fleet Diff Review — the editor tab

**Status:** design, approved 2026-08-17. Successor to
[the fleet diff review followups](../plans/2026-08-16-fleet-diff-review-followups.md), which
this spec addresses §1, §3 and §5 of. §4, §6 and §7 stay deferred there.

## The problem

The fleet diff review surface shipped in `d158fda` (#19) and scored 24/40 at the
`impeccable` critique gate. Its central defect is structural rather than cosmetic:
`REVIEW_PX = 700`, and PRODUCT.md says the panel is *typically 300–500px*. At the modal
width the flagship feature of that branch does not render at all — no disabled state, no
tooltip, no "widen the panel to review changes".

The threshold itself is sound. A file list with churn counts and session chips in a 300px
column is a wall of truncated paths, which is worse than nothing. The defect is the absence
of any compensating affordance, and every cheap fix for it — a hint, a disabled control —
buys discoverability while leaving the surface unusable at the width the user actually has.

A second defect follows from the same placement. `FleetDiff` replaces `PaneGroup` entirely,
so a session entering `awaiting-approval` while review is open is signalled only by a
`text-primary` span at the right edge of the roster trigger, with no `aria-live`. A blocked
agent is dead time, and not losing it is the panel's reason to exist. The one state where
the user is deliberately not watching the panes is the one state with no interruption
channel.

## The decision

**Review moves out of the sidebar and into an editor-area `WebviewPanel`.**

The rows already open in VS Code's native diff editor — the panel is a launcher, not a
viewer. An editor tab gets roughly 1200px, can sit beside the diff it opens, and deletes
the width gate, the 699px unmount whiplash, and the discoverability hole in one move. It
also dissolves the hidden-permission-card defect outright rather than patching it: the
panes are never replaced, so nothing hides them.

This was flagged as the deferred v2 when the feature was specced, before the critique had
run. It looks more right now than it did then.

## Architecture

### The host

A new unit, `src/host/review-panel.ts`, owns at most one `vscode.WebviewPanel`
(`viewColumn: Beside`). `open()` reveals a live panel and creates one otherwise, so the
command is idempotent and a second invocation focuses the tab rather than spawning a
duplicate.

Its webview is configured exactly as the sidebar's is — `default-src 'none'`, a per-load
CSPRNG nonce, `localResourceRoots` pinned to `dist/`. That construction moves out of
`PanelViewProvider.render` into a shared `src/host/webview-html.ts` and both call it. A
second hand-copied CSP is precisely how that invariant rots: the copy stays correct until
the day one of them is edited.

### The client

esbuild gains a third entry, `src/review/main.tsx` → `dist/review.js` + `dist/review.css`.

The review client is not the panel client in a different mode. It has its own `reduce()`
over a narrow `ReviewState` — `sessions`, `fleetDiff`, `fleetDiffReason`, `fleetDiffDirty`,
`ready` — with no `byId`, no layout and no composer. The narrowness is the point: it is
what makes the fan-out below safe to reason about.

`fleet-diff.tsx` and `fleet-diff-groups.ts` move from `src/webview/components/` to
`src/review/`. They import `../store`, which in the new bundle resolves to the review
store. `@/components/ui/*` stays shared — both bundles compile the primitives they import,
and the Tailwind esbuild plugin scans by import graph, so no config change is needed.

### Fan-out

`SessionManager` is constructed with a single `post` callback (`extension.ts:108`, pointing
at `provider.post`). That becomes a small `PostBus`: clients register with a predicate.

- The sidebar registers for everything, exactly as today.
- The review tab registers for `sessions-changed`, `session-status`, `fleet-diff` and
  `ready`.

**This leaves the visible-set invariant untouched.** Transcript patches fan out only to
visible sessions; the review client never asks for `session-patch`, so the gating stays
where it is and is not re-implemented in a second place. `sessions-changed` and
`session-status` were already ungated by design, which is why the review tab can have the
roster and every session's status without widening anything.

### Opening it

`SessionPicker`'s review control stops being a state toggle and becomes a button posting
`{ t: 'open-review' }`. `PanelViewProvider` intercepts that message before `router.handle`,
the same interception `open-file` already receives — `MessageRouter` must not import
`vscode`, and this keeps that true rather than widening the router's dependencies for one
message.

The same action is registered as the command `hiiiidCode.review.open`, which gives the
keyboard path §3 asked for and costs nothing beyond a `package.json` entry.

### What leaves the sidebar bundle

`REVIEW_PX` and its doc comment, `canReview`, `reviewOpen`, the derived-fallback branch at
`app.tsx:112`, and `aria-pressed` on the review toggle (which existed only to describe a
surface that could vanish under the user at 699px). `PaneGroup` becomes the panel body
unconditionally.

`use-is-narrow.ts` keeps `NARROW_PX` and `usePanelWidth`. Its rename to `use-panel-width.ts`
belongs to §6 and stays deferred — the file is again a single-threshold module, which is
what its current name describes.

### Reload

A `WebviewPanelSerializer` is registered, so VS Code restores the tab itself. Without one
it restores a blank webview, which is worse than not restoring it.

This settles §6's complaint that `reviewOpen` was client-only `useState`, and settles it in
the shape the architecture already requires: the host owns whether the tab exists and the
client owns nothing durable. A reload replays host state through `hydrate`, the same as
every other surface.

## The surface

### Structure (§5)

Three nesting levels stop sharing one type size.

| Level | Treatment |
|---|---|
| Tree | `text-sm font-medium`, branch as a muted chip |
| Session group | `text-xs font-medium`, count badge, live `StatusBadge` |
| File row | `text-xs` |

An indentation ladder (0 / 12 / 24px) with a hairline left rule per session group makes the
nesting visible without the reader parsing font weights. Session-group headers become
sticky alongside tree headers, so attribution does not scroll away while rows keep coming.

The critique's framing is worth preserving: this surface **borrowed** VS Code's SCM
vocabulary and dropped the things that make the SCM view work at scale. Two of them come
back here (indentation, per-group counts). One goes further than SCM can:

**The panel knows which sessions are still running.** A session group carries its live
status, so you can see that the diff you are reading is still being written. No SCM view
can say that, and it is the fleet's identity showing through in structure rather than in
copy.

### Paths

Per group, the common prefix is elided once into the group header and rows are indented by
their remaining depth. A group entirely under `src/webview/components/` says so at the top
instead of spending thirty columns of every row repeating it.

### Contested files

Two sessions writing one file is the situation worth stopping on. Today it renders as
`also SessionB` — a truncating muted span at the end of a row that is already out of width
(`fleet-diff.tsx:361`).

It becomes a `destructive`-toned badge, and the header gains a "contested only" toggle.

### Power-user paths (§3)

Heuristic 7 (Flexibility and Efficiency) scored **1/4**. The surface is a power-user's
review tool with no power-user path, and the impatient-power-user persona it exists for is
the one it serves worst. In value order:

- **Filter.** A shadcn `Input` in the header, case-insensitive substring over `file.path`.
  Client-side, no debounce. Empty groups drop out. The header count reads filtered-of-total
  so a filter can never be mistaken for an empty fleet.
- **Collapse.** Chevrons per tree and per session group.
- **Keyboard.** Roving tabindex over rows: one row in the tab order, arrows move, Enter
  opens the diff, Home/End jump. Today every row is an independent `Button`, so a keyboard
  user Tabs through all 500.
- **Next / previous.** Header controls that move the roving index *and* open, which is the
  file-by-file review path.
- **Opened marker.** A `Set<path>` dimming the basename of rows already opened.
- **`omitted` becomes a control.** `request-fleet-diff` gains an optional `cap`; the host
  clamps it to a hard ceiling of 2000. The named dead end — "N more files are not shown",
  with nothing to press — becomes "Show 340 more".

### What stays ephemeral, and why

Collapse state and the opened-path set live in the review client and do not survive a
reload, even though the tab itself now does. §6 asked for either persistence or a written
reason; this is the reason.

Both describe a **reading position in a list that has since re-read itself**. The tab
re-requests on mount and on the 750ms dirty timer, so a restored collapse state would be
folding groups of a list assembled from a different working tree than the one that was
folded. Restoring it would be restoring an opinion about content that no longer exists —
the same argument that keeps diff claims and failed model probes off disk.

## Error, empty and loading states

Unchanged from the current surface, which handles them correctly:

- A failed read is a third state with Refresh still live, not a permanent "Reading the
  working trees…".
- The empty state distinguishes "no sessions yet" from "no session is in a git repository",
  and never implies a clean fleet it was not told about.

The review client needs the same pre-`ready` `Loading…` state the panel has, because the
serializer can restore a tab while `SessionManager.init()` is still running.

The loading *treatment* — today a static sentence with no upper bound, so a four-second
read looks identical to a forty-millisecond one — is knowingly inherited as-is. Making it
more appealing is follow-up work, tracked in §6 of the followups doc.

## Testing

**Unit.**

- `PostBus` predicate filtering. The load-bearing assertion is that a review client never
  receives `session-patch`.
- `cap` clamping in `src/host/fleet-diff.ts`.
- The pure additions to `fleet-diff-groups.ts`: common-prefix elision, path filtering,
  contested detection.

**DOM.** A review harness beside `src/test/dom/harness.tsx`. State arrives as genuine
`HostToWebview` messages through the real review `StoreProvider`; assertions read the
messages the client posted back. Never a hand-built `ReviewState` — a fake provider bypasses
`reduce` and lets a test pass against a state the host could never produce. Roving tabindex,
filter, collapse and "show more" each get a red-first test. The existing
`src/test/dom/fleet-diff.test.tsx` migrates to it.

**Assertions compare booleans, strings or counts — never DOM nodes.** The node-valued form
allocated 3.5GB in four seconds on 2026-08-14, and it only detonates while the test is red,
which is exactly when it is being run.

## Risks

- **The second webview doubles the CSP surface.** Mitigated by the shared
  `webview-html.ts`; both panels must be constructed through it.
- **The serializer can restore a tab mid-`init()`**, against an empty roster. Hence the
  pre-`ready` state above.
- **A review tab in a background editor group keeps requesting.** The 750ms dirty timer
  would put one git invocation per tree on the host for a surface nobody can see. The
  client stops requesting when the panel reports `visible === false` and re-requests once
  on becoming visible again.

## Gates

`yarn lint`, `yarn check-types` and `yarn run compile` before every commit, each pinned
with its own `cd` — shell cwd reverts mid-session, and an unproven-directory green gate is
an unrun gate.

`node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>` over everything
touched under the review bundle. Exit 2 is a failing check, not a suggestion.

The closing `impeccable critique` runs in **two isolated agents, never the implementer**.
A gate re-scored by whoever just fixed its findings is not a gate. Baseline to beat:
**24/40**.

## Explicitly out of scope

Deferred, and still recorded in
[the followups doc](../plans/2026-08-16-fleet-diff-review-followups.md):

- **§4** — Refresh acknowledgement and throttling.
- **§6** — the remaining smaller items, including the loading-state polish noted above.
- **§7** — the open design questions: whether "not attributed" is one bucket or two, what a
  session's change set is once it commits, and whether per-session review should be the
  first choice rather than a scroll target.
