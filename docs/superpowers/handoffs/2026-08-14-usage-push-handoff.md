# Handoff — make account usage push-fed, and close out the usage/context branch

Written 2026-08-14, at the end of the branch that shipped
[docs/superpowers/plans/2026-08-13-usage-and-context.md](../plans/2026-08-13-usage-and-context.md).
Everything here is work the *next* agent should do; nothing in it is started.

## Read first

- Spec: [docs/superpowers/specs/2026-08-13-usage-and-context-design.md](../specs/2026-08-13-usage-and-context-design.md)
- Plan as executed: [docs/superpowers/plans/2026-08-13-usage-and-context.md](../plans/2026-08-13-usage-and-context.md)
- `CLAUDE.md` — architecture and the invariants any change here must keep.

The branch is `worktree-feat+usage-and-context`, 17 commits from `0c32be9`, all gates green
(lint, check-types, 181 unit, 112 DOM, compile, impeccable detector exit 0). It shipped a
per-session context-fill ring with a breakdown popover, and a panel-level account usage strip.

**Do not reopen those 17 commits.** The context-ring half is finished and reviewed. This work
is a follow-up branch on top.

---

## Part 1 — the main job: replace the pull with the push

### The problem

With the real Claude provider, the usage strip reads as an error after every window reload.

`ClaudeProvider` builds its SDK `Query` lazily, on the first `send()`. Until then `queryRef` is
undefined and `usageWindows()` throws `'This session has not started yet'`. After a reload the
sessions are live but unstarted, so the host's first answer is not-ok, and nothing then triggers
a retry: `setVisible` emits no `sessions-changed`, and a `usage-windows` reply changes none of
the strip's effect dependencies. The strip therefore shows an error string until the user sends
a message.

The whole-branch review found this as its one Critical. A fix wave repaired the client half —
the throttle now has a trailing edge and a not-ok result retries on roster change — but the
host-side cause above was outside that packet's scope and survives.

### Why not just patch it

Two patches were considered and rejected:

- **Probe query.** Have the provider construct a throwaway `Query` and call the usage control
  request. It works in principle (control requests are available in streaming-input mode, which
  this provider uses, and the CLI answers `initialize` on connect), but it spawns a CLI
  subprocess on panel open for a user who may never send a message.
- **Nicer error text.** Doesn't give the user the number they asked for.

Both are beaten by a stable API the branch overlooked.

### The design

`SDKRateLimitEvent` is a first-class member of the `SDKMessage` union — no `EXPERIMENTAL` in its
name, unlike `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` which the branch
currently calls. The SDK documents it as "emitted when rate limit info changes". Its payload:

```ts
type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
                | 'seven_day_overage_included' | 'overage';
  utilization?: number;   // 0..100 — what the ring renders
  resetsAt?: number;      // what the tooltip renders
  // plus overage fields this feature does not use
};
```

Both fields the strip needs, arriving through the event stream `src/providers/claude/map-events.ts`
already maps — and currently drops on the floor (`mapEvent()` at line 116 has no branch for
`type === 'rate_limit_event'`).

Turning the strip push-fed **deletes** machinery rather than adding it. Gone: the experimental
call, `AgentRun.usageWindows`, `SessionManager.usageWindows`'s loop over live sessions, the
`request-usage` / `usage-windows` request-response pair, and in `src/webview/components/usage-strip.tsx`
the `REFRESH_MS` throttle, `lastRequestedRef`, `pendingRef`, the trailing-edge timer, the unmount
sweep and the retry-on-roster-change effect. All of that exists only because the data was
pull-shaped. The strip becomes a render of whatever the host last knew.

Sketch, for the plan to firm up:

1. `map-events.ts` — map `rate_limit_event` to a new `AgentEvent`, e.g.
   `{ kind: 'usage-window'; window: UsageWindow }`. Reuse the existing `UsageWindow` type and the
   label/id mapping already written in `src/providers/claude/map-context.ts` (`WINDOW_LABELS`);
   the `rateLimitType` values line up with the ids that module already emits. Skip events whose
   `utilization` is undefined.
2. `AgentSession` — on that event, hand the window to the sink. `SessionSink`
   (`src/host/agent-session.ts:11`) gains a method, or `changed()` grows a payload; pick one and
   keep it narrow.
3. `SessionManager` — hold the latest window per `(providerId, windowId)`, persist alongside
   `index.json` (a sibling file is fine; `SessionState` is the wrong home — this is account data,
   not session data), and emit `usage-windows` to the webview ungated, the way `sessions-changed`
   already goes out. Carry the known set in `hydrate` so a reload paints real numbers immediately.
4. Webview — the strip reads `usageByProvider` and renders. No effects, no timers.
5. Delete the pull path and its tests.

### What this does and does not fix

- After a reload the strip shows the last known windows straight away. The Critical's symptom is
  gone because the strip no longer depends on a live, started query.
- A brand-new install with no turn yet has genuinely nothing to show. That is a real
  "not reported yet" state, distinct from the existing `No plan limits` (which means the provider
  has no plan limits at all — API key, Bedrock, Vertex). Design a third, quiet state; do not
  reuse either existing one.
- A persisted value is "as of the last event". Utilization only moves when the plan is used, so
  last-known is the truth until the next event. Use `resetsAt` to drop a window that has since
  reset rather than showing a stale percentage past its reset.
- API-key/Bedrock/Vertex users never receive these events, which is correct — they keep the
  existing empty state.

### Leave alone

The context breakdown stays pull-based. `Query.getContextUsage()` carries no experimental
warning and is inherently per-session, so `request-context` / `context-breakdown` and the whole
`context-ring.tsx` path are out of scope.

---

## Part 2 — three parked items from the final review

Small, independent, and safe to fold into the same branch:

1. **`src/webview/components/usage-strip.tsx` (~line 124) ships a false rationale comment.** It
   claims restored sessions are not live until `set-visible` and that this component's effect runs
   before `App`'s. Both are wrong: the router's `ready` handler reopens pane sessions before
   emitting `hydrate` (`src/host/message-router.ts:52-56`), and the strip only mounts once
   `state.ready` (`src/webview/app.tsx:80`). The same wrong mechanism is copied into
   `src/test/dom/usage-strip.test.tsx:26-36`. If Part 1 lands, most of that comment's subject
   disappears with the effect — delete rather than correct.
2. **`src/webview/components/context-ring.tsx` — the header and the trigger disagree.** The
   popover header now derives its percentage from the pulled breakdown, but `danger` and the
   inline ≥80% label still read the pushed `contextPercent`. A session can render a destructive
   `86%` beside a `50% used` header. Pick one source for all three.
3. **`src/providers/claude/map-context.ts` — memory rows use a different denominator from their
   slice.** Rows are `tokens / maxTokens`; the Memory slice is a largest-remainder share of
   `usedPercent`. In clamped or over-full cases a single row can exceed the slice above it. It is
   documented ("never re-derive a total from the rows") but it can look wrong on screen.

Also deferred, lower value: `resetsIn` is computed once at render and goes stale for the life of
the panel (`usage-strip.tsx`); `contextPercent` persists into `index.json` so a restored session
shows a stale ring beside a "not running" popover; `statusKey` re-joins every session per render;
`refreshContextPercent`'s no-op path and post-dispose guard are correct but untested
(`src/host/agent-session.ts`).

---

## Part 3 — two verification gaps the branch never closed

State these to the user before starting; they are decisions, not oversights to fix silently.

1. **Nobody has run these surfaces outside jsdom.** The plan's manual dev-host step was skipped —
   the executing session had no interactive VS Code. So ring geometry, popover placement at 300px,
   the addon wrap, and `PanelViewProvider.openFile` (which has no unit, DOM *or* integration
   coverage) have never executed. `src/extension.ts` now scripts its dev `FakeProvider` with a
   breakdown and two windows, so `yarn dev` shows populated surfaces. Run it early — the Critical
   above is exactly the bug class a five-minute dev-host run finds.
2. **The spec's integration requirement is unmet.** The spec asks for "the panel loads, the ring
   renders, the popover opens against the fake breakdown, and clicking a memory path opens that
   document". The plan waived it in its own self-review table, writing that DOM tests cover it
   instead. The final reviewer called that out as a process fault, correctly: a plan authored by
   the executing process should not retire a spec obligation. Either write the integration test or
   amend the spec deliberately — but the waiver should not stand silently.

---

## Process

This changes the provider seam, the wire protocol and the persisted host state, so it is not a
bounded tweak:

1. **Amend the spec first.** Its "Flow" section currently specifies the pull shape
   ("Usage strip — pulled, refreshed"), and its data model puts `usageWindows` on `AgentRun`.
   Both become wrong. Rewrite those sections, record why the experimental API was abandoned, and
   commit the amendment before any code.
2. Then `superpowers:writing-plans` for the implementation plan, and
   `superpowers:subagent-driven-development` to execute it.

Two lessons from executing the last plan, worth carrying:

- **Verify the plan's own arithmetic and defaults against the current tree before dispatching.**
  The plan's percentage split shipped a rounding scheme that could total 101%, and its first
  correction failed from the opposite direction. It took a largest-remainder allocation and a
  5,000-combination sweep to actually settle it. A plan is an argument, not an authority.
- **Subagents' shells may start in a different checkout than the worktree.** Every dispatch must
  prefix commands with `cd <worktree> &&` and verify `git log -1` shows its own commit before
  reporting. The first task of the last plan committed into the wrong repository.

## Loose end in the other checkout

`E:\Efebia\hiiiid-code` on `master` carries an orphan commit `30f3327` — the misplaced first task,
cherry-picked onto this branch as `3648d1a`. It was left in place because another session was
committing on that branch at the time. Drop it when nothing else is running:

```
git -C E:/Efebia/hiiiid-code rebase --onto 30f3327~1 30f3327 master
```

or let the merge absorb it as already-applied.
