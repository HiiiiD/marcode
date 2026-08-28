# Subagent Transcript Pane & Fleet View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user (1) open a subagent's complete tool-call history in place of the pane
it was opened from, with a breadcrumb back, and (2) open a dedicated "fleet view" editor tab
showing every roster session's live status and activity, clicking a card to bring that
session into the sidebar's split.

**Architecture:** The subagent pane needs no new protocol or host plumbing — `item.children`
already carries a subagent's full tool-call history to the webview; only the client-side
window (`SUBAGENT_CHILD_WINDOW = 10`) hides it. Adding an "Open full transcript" affordance
plus a purely client-local drill-in map on `PaneGroup` is the whole feature. The fleet view
is a fourth webview surface, built by copying `ReviewPanel`'s already-proven pattern
(`WebviewPanel`, own `PostBus` predicate, own `MessageRouter` instance, own esbuild bundle)
rather than inventing a new one.

**Tech Stack:** TypeScript, React 19, esbuild, mocha (unit + jsdom DOM tests), VS Code
extension API.

**Spec:** [docs/superpowers/specs/2026-08-28-subagent-pane-and-fleet-view-design.md](../specs/2026-08-28-subagent-pane-and-fleet-view-design.md)

## Global Constraints

- Filenames are kebab-case, including React components.
- Never raw HTML controls — use `Button`, etc. from `@/components/ui/*`.
- Compose classNames with `cn` from `@/lib/utils`, never template literals.
- `src/protocol/messages.ts` is types-only — no runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/`, and not `src/host/message-router.ts`,
  imports `vscode`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Transcript patches fan out only to visible sessions; `sessions-changed` and
  `session-status` are ungated. The fleet view must never receive `session-patch`.
- DOM tests drive components through the real `StoreProvider`, state arrives as genuine
  `HostToWebview` messages via `sendFromHost`, assertions read posted messages back. Never
  mock `useStore` or hand-build client state.
- Assertions compare a boolean, a string, or a count — **never** a DOM node, per the RAM
  guard (`assert.strictEqual(container.querySelector('div') === null, true)`, never
  `... , null)`).
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before every commit, each
  pinned with its own `cd "e:/Efebia/hiiiid-code"` (shell cwd reverts mid-session).
- Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). Commit after
  every task.
- After any change under `src/webview/components/`, run
  `node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>` before considering
  the task done.

---

## Task 1: `activityLabel` on `SessionState`

**Files:**
- Modify: `src/protocol/messages.ts` (the `SessionState` interface, lines 157-215)
- Modify: `src/host/agent-session.ts` (`recomputeWaitingStatus`, lines 640-653; `tool-start`
  handler, lines 828-856)
- Test: `src/test/unit/agent-session.test.ts` (existing file — add cases; if it does not
  exist, create it following the pattern of `src/test/unit/post-bus.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SessionState.activityLabel?: string` — read by Task 6's fleet session card.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/agent-session.test.ts` (create the file if absent, importing
`AgentSession` the same way other host unit tests do — check
`src/test/unit/session-manager.test.ts` for the construction pattern used there and mirror
it for a minimal `AgentSession` instance):

```ts
test('activityLabel reports idle, running-tool and awaiting-approval', async () => {
  const session = makeTestAgentSession(); // helper already used by this suite
  assert.strictEqual(session.state.activityLabel, 'Idle');

  session.handleEvent({ t: 'tool-start', id: 't1', tool: { kind: 'shell', command: 'ls' } });
  assert.strictEqual(session.state.activityLabel, 'Running shell');

  session.handleEvent({ t: 'permission-request', id: 't1', requestId: 'r1', tool: { kind: 'shell', command: 'ls' } });
  assert.strictEqual(session.state.activityLabel, 'Waiting for approval: shell');
});
```

If `makeTestAgentSession`/`handleEvent` names differ from what's actually in
`agent-session.ts` and its existing tests, use the real constructor and event-dispatch entry
points found there instead — read `src/host/agent-session.ts`'s public surface and any
existing `src/test/unit/agent-session*.test.ts` file first and match its exact API rather
than the illustrative names above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "activityLabel"`
Expected: FAIL — `activityLabel` is `undefined`.

- [ ] **Step 3: Add the field to the protocol type**

In `src/protocol/messages.ts`, inside `interface SessionState` (after `status:
SessionStatus;` around line 164):

```ts
  status: SessionStatus;
  /**
   * A short, human-readable description of what this session is doing right
   * now — "Running Edit", "Waiting for approval: Bash", "Idle". Derived
   * alongside `status` in `AgentSession.recomputeWaitingStatus()`, the one
   * place `status` itself is computed, so the two can never read the wall
   * differently. Optional only for the instant before a session's first
   * event.
   */
  activityLabel?: string;
```

- [ ] **Step 4: Compute it in `agent-session.ts`**

In `recomputeWaitingStatus` (lines 640-653), extend to also set `activityLabel` from the
same three-way branch it already uses for `status`:

```ts
private recomputeWaitingStatus(idle: SessionStatus = 'running'): void {
  const waiting = this.pending.size > 0 || this.pendingQuestions.size > 0;
  const busy = this.activeBackgroundTasks.size > 0;
  this.setStatus(waiting ? 'awaiting-approval' : busy ? 'running' : idle);
  this._state.activityLabel = waiting
    ? `Waiting for approval: ${this.currentToolLabel() ?? 'a tool'}`
    : busy
      ? `Running ${this.currentToolLabel() ?? 'a tool'}`
      : 'Idle';
}

/** The kind of the most recently started, still-running top-level tool —
 * "the current tool" for `activityLabel`'s purposes. Subagent-nested tool
 * activity is deliberately not surfaced here: the fleet card is a one-line
 * summary of the session, not of everything running inside it. */
private currentToolLabel(): string | undefined {
  for (const item of [...this.toolItems.values()].reverse()) {
    if (item.role === 'tool' && item.state === 'running' && !this.childOf.has(item.toolId)) {
      return item.tool.kind;
    }
  }
  return undefined;
}
```

Check the actual field/method names on `AgentSession` this snippet assumes
(`this.toolItems`, `this.childOf`, `this._state`) against the real file before pasting —
they were confirmed present in the earlier investigation (`this.toolItems.get`,
`this.childOf.get` both appear in the `tool-end` handler at lines 858-897), but confirm
`toolItems`'s value type and iteration order match `[...this.toolItems.values()].reverse()`
returning most-recent-first before relying on it; adjust to whatever ordering the map
actually holds (e.g. tracking a separate `mostRecentRunningTool: string | undefined` set in
`tool-start`/`tool-end` is an acceptable, simpler alternative if the map's order is not
insertion order).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "activityLabel"`
Expected: PASS.

- [ ] **Step 6: Run full gate**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/protocol/messages.ts src/host/agent-session.ts src/test/unit/agent-session.test.ts
git commit -m "feat: derive a session's activityLabel alongside its status"
```

---

## Task 2: `FLEET_WANTS` on `PostBus`

**Files:**
- Modify: `src/host/post-bus.ts`
- Test: `src/test/unit/post-bus.test.ts`

**Interfaces:**
- Consumes: `HostToWebview` (unchanged).
- Produces: `FLEET_WANTS: (msg: HostToWebview) => boolean`, consumed by Task 5's
  `FleetPanel`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/post-bus.test.ts`, mirroring its existing `REVIEW_WANTS` tests:

```ts
test('FLEET_WANTS admits only sessions-changed and session-status', () => {
  assert.strictEqual(FLEET_WANTS({ t: 'sessions-changed', sessions: [] } as unknown as HostToWebview), true);
  assert.strictEqual(FLEET_WANTS({ t: 'session-status', id: 's1' as SessionId, status: 'idle' } as HostToWebview), true);
  assert.strictEqual(FLEET_WANTS({ t: 'fleet-diff', trees: [] } as unknown as HostToWebview), false);
  assert.strictEqual(FLEET_WANTS({ t: 'session-patch', id: 's1' as SessionId, ops: [] } as unknown as HostToWebview), false);
});
```

Add `FLEET_WANTS` (and `SessionId` if not already imported) to the test file's import line
for `post-bus.ts`. Check the exact shape of `session-patch` and `fleet-diff` messages in
`src/protocol/messages.ts` before finalizing the literals above — they must be structurally
valid enough to type-check, using `as unknown as HostToWebview` for any fields you don't
need to fill in, matching the existing test file's own style for constructing minimal
messages (read that file's existing `REVIEW_WANTS` cases and copy their casting style
exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "FLEET_WANTS"`
Expected: FAIL — `FLEET_WANTS is not defined`.

- [ ] **Step 3: Implement**

In `src/host/post-bus.ts`, beside `REVIEW_WANTS`:

```ts
export const REVIEW_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status' || msg.t === 'fleet-diff';

/**
 * The fleet view's allow-list. One narrower than `REVIEW_WANTS`: it never
 * asks for `fleet-diff` (no transcript or diff content, just roster status),
 * so it doesn't get it — a new message type here defaults to not reaching
 * this client either, the same discipline `REVIEW_WANTS` documents.
 */
export const FLEET_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "FLEET_WANTS"`
Expected: PASS.

- [ ] **Step 5: Run full gate**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile`

- [ ] **Step 6: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/host/post-bus.ts src/test/unit/post-bus.test.ts
git commit -m "feat: add FLEET_WANTS post-bus predicate"
```

---

## Task 3: `SubagentCard` gains an "Open full transcript" affordance

Client-only. No host or protocol change. Introduces a React context so the deeply nested
`SubagentCard` can ask its ancestor `PaneGroup` to drill in, without threading a callback
prop through `Transcript` → `TranscriptItemView` → `ToolCard`/`SubagentCard`.

**Files:**
- Create: `src/webview/components/subagent-drill-in-context.ts`
- Modify: `src/webview/components/subagent-card.tsx`
- Test: `src/test/dom/subagent-card.test.tsx` (existing file, modify the test at lines 63-75
  that currently asserts no such control exists)

**Interfaces:**
- Produces: `SubagentDrillInContext` (React context, default `undefined`),
  `useOpenSubagentTranscript(): (itemId: string) => void` — a hook that returns a no-op
  function when no provider is mounted (so `SubagentCard` renders safely in any test harness
  that doesn't wrap it), and the real drill-in setter once Task 4 provides it.

- [ ] **Step 1: Write the failing test**

Modify `src/test/dom/subagent-card.test.tsx`'s existing test around lines 63-75 (the one
that currently asserts a "show all" button does *not* exist) to assert the new control
exists once the child count exceeds the window, and posts nothing on the wire (it's a
context call, not a message):

```tsx
test('offers to open the full transcript once past the window', () => {
  const item = /* ...same fixture the existing test builds with 25 children... */;
  renderWithStore(<SubagentCard item={item} sessionId={'s1' as SessionId} />);
  fireEvent.click(screen.getByRole('button', { name: /subagent/i })); // expand
  assert.strictEqual(
    screen.getByRole('button', { name: /open full transcript/i }) !== null,
    true,
  );
});
```

Reuse the exact fixture-building helper the existing 25-children test in this file already
uses (do not invent a new one) — read the file's current contents first and adapt in place
rather than duplicating its setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "open the full transcript"`
Expected: FAIL — no such button.

- [ ] **Step 3: Create the context**

`src/webview/components/subagent-drill-in-context.ts`:

```ts
import { createContext, useContext } from 'react';

/**
 * How a `SubagentCard` asks its pane to replace itself with this subagent's
 * full, unwindowed transcript. Provided by `PaneGroup` around each pane's
 * subtree (see pane-group.tsx); absent in any other host (a test harness
 * that mounts `SubagentCard` directly, the review tab), where it is a no-op
 * rather than a crash — the affordance simply does nothing there, which is
 * correct since neither host has a pane to drill into.
 */
export const SubagentDrillInContext = createContext<((itemId: string) => void) | undefined>(undefined);

export function useOpenSubagentTranscript(): (itemId: string) => void {
  return useContext(SubagentDrillInContext) ?? (() => {});
}
```

- [ ] **Step 4: Wire the button into `SubagentCard`**

In `src/webview/components/subagent-card.tsx`, import the hook and render a button
alongside the existing "showing last N of M" note (replacing the comment that called the
escape hatch "a future subagent pane, not a button here" — this plan is that pane):

```tsx
import { useOpenSubagentTranscript } from './subagent-drill-in-context';
```

```tsx
  const openTranscript = useOpenSubagentTranscript();
```

Replace the block at lines 97-104:

```tsx
            {children.length > shown.length && (
              <div className="flex items-center justify-between pb-1 text-muted-foreground">
                <p>showing last {shown.length} of {children.length}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs font-normal"
                  onClick={() => openTranscript(item.id)}
                >
                  Open full transcript
                </Button>
              </div>
            )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "open the full transcript"`
Expected: PASS.

- [ ] **Step 6: Run the impeccable detector**

Run: `cd "e:/Efebia/hiiiid-code" && node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/subagent-card.tsx src/webview/components/subagent-drill-in-context.ts`
Expected: exit 0.

- [ ] **Step 7: Run full gate**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile`

- [ ] **Step 8: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/webview/components/subagent-card.tsx src/webview/components/subagent-drill-in-context.ts src/test/dom/subagent-card.test.tsx
git commit -m "feat: subagent card offers to open its full transcript"
```

---

## Task 4: `PaneGroup` renders the drill-in

**Files:**
- Create: `src/webview/components/subagent-transcript.tsx`
- Modify: `src/webview/components/pane-group.tsx` (lines 259-284, and imports)
- Test: `src/test/dom/pane-group.test.tsx` (create if it does not already exist as a
  distinct file — check first; if pane behavior is instead tested inside a broader
  `app.test.tsx`, add the case there and follow that file's existing patterns)

**Interfaces:**
- Consumes: `SubagentDrillInContext` from Task 3, `PaneState` from `../reducer`,
  `TranscriptItem` from `../../protocol/messages`.
- Produces: `SubagentTranscript({ item, sessionId, onBack }: { item: Extract<TranscriptItem,
  { role: 'tool' }>; sessionId: SessionId; onBack: () => void })`.

- [ ] **Step 1: Write the failing test**

```tsx
test('opening a subagent transcript replaces the pane, and the breadcrumb returns', () => {
  renderApp();
  sendFromHost(hydrateWithOneSessionAndOneSubagentToolItem()); // build via existing
    // hydrate-fixture helpers already used elsewhere in src/test/dom — a session with
    // one 'tool' role item, tool.kind === 'subagent', 25 children.
  fireEvent.click(screen.getByRole('button', { name: /subagent/i }));
  fireEvent.click(screen.getByRole('button', { name: /open full transcript/i }));
  assert.strictEqual(screen.getByRole('button', { name: /back to/i }) !== null, true);
  // The session's own composer is gone while drilled in — replaced in place, not split.
  assert.strictEqual(screen.queryAllByRole('textbox').length, 0);
  fireEvent.click(screen.getByRole('button', { name: /back to/i }));
  assert.strictEqual(screen.queryAllByRole('textbox').length, 1);
});
```

Use whatever this suite's actual hydrate-fixture helper is named (grep existing
`src/test/dom/*.test.tsx` files for how a session with transcript items is seeded via
`sendFromHost({ t: 'hydrate', ... })` and follow that exact shape) rather than the
illustrative helper name above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "breadcrumb returns"`
Expected: FAIL.

- [ ] **Step 3: Create `SubagentTranscript`**

`src/webview/components/subagent-transcript.tsx`:

```tsx
import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from 'lucide-react';
import { TranscriptItemView } from './transcript-item';
import { subagentLabel } from './subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A subagent's complete tool-call history, unwindowed — the drill-in
 * `PaneGroup` swaps a pane's `SessionHeader`+`Transcript` for when a
 * `SubagentCard` asks to open its full transcript. No `hasMore`/pagination:
 * a subagent's children are a fixed list already fully present in
 * `item.children`, never paged from the host.
 */
export function SubagentTranscript({
  item, sessionId, onBack,
}: {
  item: ToolItem;
  sessionId: SessionId;
  onBack: () => void;
}) {
  const children = item.children ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <Button variant="ghost" size="icon-xs" aria-label={`Back to ${sessionId}`} onClick={onBack}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="truncate font-medium">Subagent: {subagentLabel(item)}</span>
      </div>
      <div className="min-h-0 flex-1">
        <MessageScroller className="h-full">
          <MessageScrollerViewport className="px-2">
            <MessageScrollerContent className="justify-end gap-2">
              {children.map((child) => (
                <MessageScrollerItem key={child.id} messageId={child.id}>
                  <TranscriptItemView item={child} sessionId={sessionId} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </div>
    </div>
  );
}
```

Check `MessageScroller`'s actual required context — `transcript.tsx` relies on a
`MessageScrollerProvider` mounted by its parent (`pane-group.tsx`'s
`<MessageScrollerProvider autoScroll defaultScrollPosition="end">`, wrapping both
`SessionHeader` and `Transcript`). Since Step 4 below keeps that same
`MessageScrollerProvider` wrapping the swapped content, `SubagentTranscript` does not need
its own provider — verify this holds once wired in Step 4, and if `MessageScroller` throws
without a fresh provider per mounted tree, wrap `SubagentTranscript`'s own scroller in a
second nested `MessageScrollerProvider` instead.

`onBack`'s accessible label uses the raw `sessionId`, not a title, only in this scaffold —
replace `${sessionId}` with the pane's session title (already available as
`paneState.summary.title` at the call site in Step 4) when wiring it in.

- [ ] **Step 4: Wire the drill-in state into `PaneGroup`**

In `src/webview/components/pane-group.tsx`:

```tsx
import { useState } from "react"; // add useState to the existing React import line
import { SubagentDrillInContext } from "./subagent-drill-in-context";
import { SubagentTranscript } from "./subagent-transcript";
```

Inside `PaneGroup`, alongside the other per-group state (near `rootRef`/`prevCount`):

```tsx
  // A pane's reading position, not part of the pane's own layout — keyed by
  // sessionId (not pane index) so a session's drill-in survives the pane
  // reordering `evenlySizedPanes` can do, and is cleared, never restored, on
  // reload: see the spec's "what stays ephemeral" section.
  const [drilledIn, setDrilledIn] = useState<Record<string, string>>({});
```

Replace the body of the `Fragment` (lines 259-284) to branch on `drilledIn[pane.sessionId]`:

```tsx
                <MessageScrollerProvider autoScroll defaultScrollPosition="end">
                  {(() => {
                    const openItemId = drilledIn[pane.sessionId];
                    const openItem = openItemId
                      ? paneState.items.find((i) => i.id === openItemId)
                      : undefined;
                    if (openItem && openItem.role === "tool") {
                      return (
                        <SubagentTranscript
                          item={openItem}
                          sessionId={paneState.summary.id}
                          onBack={() =>
                            setDrilledIn((prev) => {
                              const next = { ...prev };
                              delete next[pane.sessionId];
                              return next;
                            })
                          }
                        />
                      );
                    }
                    return (
                      <div className="flex h-full flex-col">
                        <SessionHeader
                          pane={paneState}
                          accessibleTitle={names.get(paneState.summary.id)!}
                        />
                        <SubagentDrillInContext.Provider
                          value={(itemId) =>
                            setDrilledIn((prev) => ({ ...prev, [pane.sessionId]: itemId }))
                          }
                        >
                          <div className="min-h-0 flex-1">
                            <Transcript
                              pane={paneState}
                              onLoadMore={(beforeItemId) =>
                                post({
                                  t: "load-more",
                                  id: pane.sessionId,
                                  beforeItemId,
                                })
                              }
                            />
                          </div>
                        </SubagentDrillInContext.Provider>
                        <Composer
                          pane={paneState}
                          model={model}
                          models={provider?.models ?? []}
                          unavailableReason={unavailabilityFor(state, paneState.summary.providerId)}
                        />
                      </div>
                    );
                  })()}
                </MessageScrollerProvider>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "breadcrumb returns"`
Expected: PASS.

- [ ] **Step 6: Run the impeccable detector**

Run: `cd "e:/Efebia/hiiiid-code" && node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/pane-group.tsx src/webview/components/subagent-transcript.tsx`

- [ ] **Step 7: Run full gate and full DOM suite**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile && yarn test:dom`
Expected: all pass — this task edits a widely-shared component, so the whole DOM suite must
stay green, not just the new test.

- [ ] **Step 8: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/webview/components/pane-group.tsx src/webview/components/subagent-transcript.tsx src/test/dom/pane-group.test.tsx
git commit -m "feat: open a subagent's full transcript in place of its pane"
```

---

## Task 5: `focus-session` message

Adds the one new wire message the fleet view needs, and its deliberate no-op wire-guard
entry — independent of the fleet panel itself so it lands with its own test.

**Files:**
- Modify: `src/protocol/messages.ts` (`WebviewToHost` union, near `set-visible`/`set-layout`
  at lines 397-398)
- Modify: `src/host/message-router.ts` (`KNOWN_MESSAGE_TAGS` at lines 581-595, and the
  `open-review` no-op case at lines 507-508)
- Test: `src/test/unit/message-router.test.ts` (mirror the existing "open-review survives
  the wire guard" test)

**Interfaces:**
- Produces: `{ t: 'focus-session'; id: SessionId }` on `WebviewToHost`, intercepted by
  `FleetPanel` in Task 6 before it ever reaches `MessageRouter.handle`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/message-router.test.ts`, right beside the existing "open-review
survives the wire guard as a deliberate no-op, same as open-file" test (around line 641):

```ts
test('focus-session survives the wire guard as a deliberate no-op, same as open-review', async () => {
  const router = /* construct the same way the open-review test does, line ~641-648 */;
  await router.handle({ t: 'focus-session', id: 's1' as SessionId });
  // No throw, and nothing emitted — same assertion shape as the open-review test above it.
});
```

Copy that test's exact router-construction call rather than re-deriving it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "focus-session"`
Expected: FAIL — TypeScript rejects `{ t: 'focus-session', ... }` since it's not yet a
member of `WebviewToHost` (a compile failure counts as the red step here).

- [ ] **Step 3: Add the message type**

In `src/protocol/messages.ts`, in the `WebviewToHost` union, after `{ t: 'set-layout';
layout: PaneLayout }` (line 398):

```ts
  | { t: 'set-layout'; layout: PaneLayout }
  /**
   * Sent only by the fleet view: bring a session into the sidebar's visible
   * split. Intercepted by `FleetPanel` before `MessageRouter.handle` (same
   * precedent as `open-review`), because revealing the sidebar view
   * container needs the `vscode` API this module must not import.
   */
  | { t: 'focus-session'; id: SessionId }
```

- [ ] **Step 4: Add the wire-guard entries**

In `src/host/message-router.ts`, add `'focus-session'` to `KNOWN_MESSAGE_TAGS` (line
581-595), and add the no-op case right after `open-review` (lines 507-508):

```ts
      case 'open-review':
        return;

      // Same precedent as open-review: FleetPanel intercepts this before
      // delegating, since revealing the sidebar view container needs the
      // vscode API this module must not import. Listed here, and in
      // KNOWN_MESSAGE_TAGS, so a stray one — this router also backs
      // PanelViewProvider itself, where nothing intercepts it — is a
      // deliberate no-op rather than a "malformed message" error log.
      case 'focus-session':
        return;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:unit --grep "focus-session"`
Expected: PASS.

- [ ] **Step 6: Run full gate**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile`

- [ ] **Step 7: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/protocol/messages.ts src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: add focus-session wire message for the fleet view"
```

---

## Task 6: `FleetPanel` (host)

Mirrors `src/host/review-panel.ts` exactly, with `FLEET_WANTS` and a `focus-session`
intercept in place of review's diff-specific concerns.

**Files:**
- Create: `src/host/fleet-panel.ts`
- Test: `src/test/unit/fleet-panel.test.ts` (mirror any existing `review-panel` unit test if
  one exists; if `review-panel.ts` has no dedicated unit test file, skip a host unit test
  here and rely on Task 8's DOM test plus the manual verification step below — do not invent
  a test that duplicates what `PostBus`'s own test already covers)

**Interfaces:**
- Consumes: `SessionManager.setVisible(ids: SessionId[]): Promise<void>`,
  `SessionManager.setLayout(layout: PaneLayout): void`, `SessionManager.layout():
  PaneLayout`, `FLEET_WANTS` from Task 2, `renderWebviewHtml` from `./webview-html`,
  `MessageRouter` from `./message-router`.
- Produces: `class FleetPanel { open(): void; restore(panel): void; dispose(): void }`,
  `FLEET_VIEW_TYPE = 'mar-code.fleet'`.

- [ ] **Step 1: Create `fleet-panel.ts`**

```ts
import * as vscode from 'vscode';
import { MessageRouter, type EditorContextHost } from './message-router';
import { PostBus, FLEET_WANTS } from './post-bus';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { WebviewToHost } from '../protocol/messages';
import { evenlySizedPanes } from '../webview/components/pane-layout';

export const FLEET_VIEW_TYPE = 'mar-code.fleet';

/**
 * The fleet-wide view: every roster session's live status and activity, in
 * an editor tab, mirroring `ReviewPanel`'s architecture exactly — its own
 * `WebviewPanel`, its own `PostBus` registration, its own `MessageRouter`.
 * At most one; `open()` reveals a live panel rather than making a second.
 */
export class FleetPanel {
  private panel: vscode.WebviewPanel | undefined;
  private unregister: (() => void) | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly bus: PostBus,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      FLEET_VIEW_TYPE, 'Fleet', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }

  restore(panel: vscode.WebviewPanel): void {
    const old = this.panel;
    if (old !== undefined) {
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
      old.dispose();
    }
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, {
      scriptUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'fleet.css'),
      ),
      title: 'Fleet',
    });

    this.unregister = this.bus.add({
      post: (msg) => { void panel.webview.postMessage(msg); },
      wants: FLEET_WANTS,
    });

    const router = new MessageRouter(
      this.manager, (m) => { void panel.webview.postMessage(m); },
      this.defaultCwd, this.editor,
    );
    const messageSub = panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // Same precedent as PanelViewProvider's open-file/open-review
        // intercepts: this needs the vscode API MessageRouter must not
        // import.
        if (raw?.t === 'focus-session') {
          const ids = this.manager.layout().panes.map((p) => p.sessionId);
          if (!ids.includes(raw.id)) {
            await this.manager.setVisible([...ids, raw.id]);
            this.manager.setLayout(
              evenlySizedPanes([...ids, raw.id], this.manager.layout().orientation),
            );
          }
          await vscode.commands.executeCommand('workbench.view.extension.mar-code');
          return;
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[mar-code] fleet message handling failed', err);
      }
    });

    const disposeSub = panel.onDidDispose(() => {
      if (this.panel !== panel) { return; }
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
      for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    });

    this.subscriptions = [messageSub, disposeSub];
  }

  dispose(): void {
    this.unregister?.();
    for (const sub of this.subscriptions.splice(0)) { sub.dispose(); }
    this.panel?.dispose();
  }
}
```

Verify `evenlySizedPanes`'s exact signature in `src/webview/components/pane-layout.ts`
before pasting the call above — it's imported here from the webview tree into the host,
which is new; confirm the function is pure (no `vscode`/DOM import) so this cross-import is
legal, or, if it is not exported in an importable form for the host bundle, duplicate the
handful of lines it takes to build an evenly-sized `PaneLayout` directly inside
`fleet-panel.ts` instead of importing across the boundary.

- [ ] **Step 2: Type-check**

Run: `cd "e:/Efebia/hiiiid-code" && yarn check-types`
Expected: PASS (no runtime test for this file per the note above — it is exercised
end-to-end by Task 8's DOM test plus manual verification via `yarn run` in Task 8).

- [ ] **Step 3: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/host/fleet-panel.ts
git commit -m "feat: add FleetPanel host wiring"
```

---

## Task 7: `src/fleet/` client bundle

**Files:**
- Create: `src/fleet/main.tsx`
- Create: `src/fleet/store.tsx`
- Create: `src/fleet/reducer.ts`
- Create: `src/fleet/fleet-app.tsx`
- Create: `src/fleet/session-card.tsx`
- Create: `src/fleet/index.css` (copy `src/review/index.css` verbatim — same Tailwind entry
  every bundle needs)
- Modify: `esbuild.js` (add a `fleetCtx`, mirroring `reviewCtx`)
- Test: `src/test/dom/fleet-harness.tsx` (mirror `src/test/dom/review-harness.tsx`)
- Test: `src/test/dom/fleet-app.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary` from `../protocol/messages`, `HostToWebview` for `reduce`.
- Produces: `FleetState { ready: boolean; sessions: SessionSummary[] }`, `reduceFleet(state,
  msg): FleetState`, `<FleetApp />`, `<StoreProvider>` / `useStore()` for the fleet tree.

- [ ] **Step 1: Write the failing test**

`src/test/dom/fleet-harness.tsx`:

```tsx
import { posted, resetHost, sendFromHost } from './harness';

export { posted, resetHost, sendFromHost };

let FleetApp: typeof import('../../fleet/fleet-app').FleetApp;
let StoreProvider: typeof import('../../fleet/store').StoreProvider;

export function renderFleet() {
  ({ FleetApp } = require('../../fleet/fleet-app'));
  ({ StoreProvider } = require('../../fleet/store'));
  const { render } = require('@testing-library/react');
  return render(<StoreProvider><FleetApp /></StoreProvider>);
}
```

Match `review-harness.tsx`'s exact deferred-require pattern and comment explaining why
`require` rather than `import` is used (the `acquireVsCodeApi` stub must exist before the
module under test is loaded) — copy that file's structure precisely rather than
re-deriving it.

`src/test/dom/fleet-app.test.tsx`:

```tsx
import { suite, test } from 'mocha';
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { renderFleet, resetHost, sendFromHost } from './fleet-harness';
import type { SessionSummary } from '../../protocol/messages';

suite('fleet view', () => {
  test('renders one card per roster session with its status', () => {
    resetHost();
    renderFleet();
    const sessions: SessionSummary[] = [
      makeSession({ id: 's1' as SessionSummary['id'], title: 'Alpha', status: 'running' }),
      makeSession({ id: 's2' as SessionSummary['id'], title: 'Beta', status: 'awaiting-approval' }),
    ];
    sendFromHost({ t: 'hydrate', sessions, layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [], unavailable: [], usage: {} });
    assert.strictEqual(screen.getByText('Alpha') !== undefined, true);
    assert.strictEqual(screen.getByText('Beta') !== undefined, true);
    assert.strictEqual(screen.getByText('Needs you') !== undefined, true);
  });
});

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's0' as SessionSummary['id'], providerId: 'claude', model: 'test-model', title: 'Untitled',
    cwd: '/tmp', status: 'idle', permissionMode: 'default', includeEditorContext: false,
    resumeTokens: {}, usage: { inputTokens: 0, outputTokens: 0 }, archived: false,
    createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}
```

Check the real minimal-required fields on `hydrate`'s payload and on `SessionSummary`
against `src/protocol/messages.ts` before finalizing — some fields shown may be optional and
can be dropped, and any field this snippet is missing that TypeScript requires must be
added.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "renders one card"`
Expected: FAIL — the modules under test don't exist yet.

- [ ] **Step 3: `reducer.ts`**

```ts
import type { HostToWebview, SessionSummary } from '../protocol/messages';

export interface FleetState {
  ready: boolean;
  sessions: SessionSummary[];
}

export const initialFleetState: FleetState = { ready: false, sessions: [] };

export function reduceFleet(state: FleetState, msg: HostToWebview): FleetState {
  switch (msg.t) {
    case 'hydrate':
      return { ready: true, sessions: msg.sessions };
    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };
    case 'session-status':
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === msg.id ? { ...s, status: msg.status } : s)),
      };
    default:
      return state;
  }
}
```

- [ ] **Step 4: `store.tsx`**

Mirror `src/review/store.tsx` exactly, substituting `reduceFleet`/`initialFleetState` for
`reduceReview`/`initialReviewState`. Read that file's full 39 lines first and copy its
`useReducer` wiring, `postMessage`-on-mount `{ t: 'ready' }`, and `useStore()` throw-if-outside-provider guard verbatim with the substitution.

- [ ] **Step 5: `session-card.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import { StatusBadge } from '../webview/components/status-badge';
import { useStore } from './store';
import type { SessionSummary } from '../protocol/messages';

export function SessionCard({ session }: { session: SessionSummary }) {
  const { post } = useStore();
  return (
    <Button
      variant="outline"
      className="flex h-auto w-full flex-col items-start gap-1 p-2 text-left text-xs font-normal"
      onClick={() => post({ t: 'focus-session', id: session.id })}
    >
      <div className="flex w-full items-center gap-2">
        <span className="truncate font-medium">{session.title}</span>
        <StatusBadge status={session.status} />
      </div>
      <span className="truncate text-muted-foreground">{session.activityLabel ?? 'Idle'}</span>
    </Button>
  );
}
```

- [ ] **Step 6: `fleet-app.tsx`**

```tsx
import { useStore } from './store';
import { SessionCard } from './session-card';

export function FleetApp() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  const live = state.sessions.filter((s) => !s.archived);
  if (live.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No sessions yet.</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {live.map((s) => <SessionCard key={s.id} session={s} />)}
    </div>
  );
}
```

- [ ] **Step 7: `main.tsx`**

Copy `src/review/main.tsx` verbatim, substituting `FleetApp`/`fleet-app` for
`ReviewApp`/`review-app`.

- [ ] **Step 8: `esbuild.js`**

Read the file's existing `reviewCtx` block and the two `Promise.all([...])` arrays (watch
and build). Add a `fleetCtx` block identical in shape:

```js
const fleetCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/fleet/main.tsx'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/fleet.js',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  alias: { '@': require('path').resolve(__dirname, 'src/webview') },
  plugins: [tailwindPlugin('src/fleet/index.css', 'dist/fleet.css'), ...common.plugins],
});
```

Add `fleetCtx` to both `Promise.all([...])` arrays (watch mode and one-shot build/dispose),
in the same position `reviewCtx` occupies in each.

- [ ] **Step 9: Copy the CSS entry**

```bash
cd "e:/Efebia/hiiiid-code"
cp src/review/index.css src/fleet/index.css
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "renders one card"`
Expected: PASS.

- [ ] **Step 11: Run full gate**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile`
Expected: all pass, and `dist/fleet.js`/`dist/fleet.css` now exist after `compile`.

- [ ] **Step 12: Run the impeccable detector**

Run: `cd "e:/Efebia/hiiiid-code" && node <impeccable-skill-dir>/scripts/detect.mjs --json src/fleet/session-card.tsx src/fleet/fleet-app.tsx`

- [ ] **Step 13: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/fleet esbuild.js src/test/dom/fleet-harness.tsx src/test/dom/fleet-app.test.tsx
git commit -m "feat: add the fleet view client bundle"
```

---

## Task 8: Wire it all up — extension activation, command, sidebar trigger

**Files:**
- Modify: `src/extension.ts` (near the `ReviewPanel` construction at lines 328-330 and the
  command registrations at lines 389-396)
- Modify: `package.json` (`contributes.commands`)
- Modify: `src/webview/components/session-picker.tsx` (props at lines 20-26, trigger button
  near lines 193-201)
- Modify: `src/webview/app.tsx` (line 92, where `onReview` is passed to `SessionPicker`)
- Modify: `src/protocol/messages.ts` (`WebviewToHost`, near `open-review` at line 517)
- Modify: `src/host/panel-view-provider.ts` (constructor and `onDidReceiveMessage`, mirroring
  `onOpenReview`)
- Modify: `src/host/message-router.ts` (wire guard, mirroring `open-review`)
- Test: `src/test/dom/session-picker.test.tsx` (mirror the existing `open-review` assertion
  at line 309)
- Test: `src/test/unit/message-router.test.ts` (mirror the `open-review` no-op test again,
  for `open-fleet` this time)

**Interfaces:**
- Consumes: `FleetPanel` from Task 6, `FLEET_VIEW_TYPE` from Task 6.
- Produces: `{ t: 'open-fleet' }` on `WebviewToHost`; `SessionPicker`'s `onFleet: () => void`
  prop.

- [ ] **Step 1: Write the failing DOM test**

In `src/test/dom/session-picker.test.tsx`, beside the existing test at line 309:

```tsx
test('posts open-fleet when the fleet trigger is clicked', () => {
  resetHost();
  renderApp();
  fireEvent.click(screen.getByRole('button', { name: /fleet/i }));
  assert.strictEqual(posted().some((m) => m.t === 'open-fleet'), true);
});
```

- [ ] **Step 2: Write the failing unit test**

In `src/test/unit/message-router.test.ts`, beside the `open-review`/`focus-session` no-op
tests:

```ts
test('open-fleet survives the wire guard as a deliberate no-op, same as open-review', async () => {
  const router = /* same construction as the open-review test */;
  await router.handle({ t: 'open-fleet' });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "open-fleet" && yarn test:unit --grep "open-fleet"`
Expected: FAIL (compile error — `open-fleet` isn't a valid `t` yet, and no such button
exists).

- [ ] **Step 4: Add the message type**

In `src/protocol/messages.ts`, beside `{ t: 'open-review' }` (line 517):

```ts
  | { t: 'open-review' }
  | { t: 'open-fleet' }
```

- [ ] **Step 5: Wire guard**

In `src/host/message-router.ts`: add `'open-fleet'` to `KNOWN_MESSAGE_TAGS`, and add a
no-op case beside `open-review`:

```ts
      case 'open-review':
        return;

      // Same precedent as open-review: PanelViewProvider intercepts this
      // before delegating, since opening the fleet tab needs the vscode API
      // this module must not import.
      case 'open-fleet':
        return;
```

- [ ] **Step 6: `PanelViewProvider` intercept**

In `src/host/panel-view-provider.ts`, add a constructor parameter and an intercept, mirroring
`onOpenReview` exactly:

```ts
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
    private readonly attachments: AttachmentStore | undefined,
    private readonly picker: AttachmentHost | undefined,
    private readonly onOpenReview: () => void,
    private readonly onOpenFleet: () => void,
    private readonly fileSearch?: FileSearch,
    private readonly agentsMdNudge?: AgentsMdNudgeController,
    private readonly favoriteModels?: () => string[],
    private readonly configHost?: ConfigHost,
  ) {}
```

```ts
        if (raw?.t === 'open-review') {
          this.onOpenReview();
          return;
        }
        if (raw?.t === 'open-fleet') {
          this.onOpenFleet();
          return;
        }
```

`onOpenFleet` is inserted right after `onOpenReview` in the parameter list (not appended at
the end) since it belongs beside its sibling; this shifts every positional argument after it
at the one call site in `extension.ts` — Step 8 below updates that call to match.

- [ ] **Step 7: `SessionPicker` trigger**

In `src/webview/components/session-picker.tsx`, add `onFleet: () => void` to
`SessionPickerProps` (line 20-26) and add a sibling button to the review trigger (near lines
193-201):

```tsx
interface SessionPickerProps {
  narrow: boolean;
  onReview: () => void;
  onFleet: () => void;
}
export function SessionPicker({ narrow, onReview, onFleet }: SessionPickerProps) {
```

```tsx
      <Button
        variant="outline"
        size="icon-sm"
        className="shrink-0"
        aria-label="Open the fleet view in an editor tab"
        onClick={onFleet}
      >
        <LayoutGridIcon aria-hidden />
      </Button>
```

placed as a sibling immediately before or after the existing review-trigger `Button` (lines
193-201). Import `LayoutGridIcon` from `lucide-react` alongside the existing icon imports at
the top of the file.

- [ ] **Step 8: Thread it from `app.tsx`**

In `src/webview/app.tsx`, line 92:

```tsx
              onReview={() => post({ t: 'open-review' })}
              onFleet={() => post({ t: 'open-fleet' })}
```

- [ ] **Step 9: Wire `extension.ts`**

Near the `ReviewPanel` construction (lines 328-330):

```ts
  const review = new ReviewPanel(
    context.extensionUri, manager, bus, defaultCwd, editorHost, reviewPollIntervalMs(),
  );
  const fleet = new FleetPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);
```

Add the import at the top of the file, beside the `ReviewPanel` import:

```ts
import { FleetPanel, FLEET_VIEW_TYPE } from './host/fleet-panel';
```

Update the `PanelViewProvider` construction (lines 366-373) to insert the new callback
after `() => { review.open(); }`:

```ts
  provider = new PanelViewProvider(
    context.extensionUri, manager, defaultCwd, editorHost, attachments, picker,
    () => { review.open(); },
    () => { fleet.open(); },
    fileIndex,
    agentsMdNudge,
    favoriteModels,
    configHost,
  );
```

Add the command and serializer registrations beside review's (lines 389-396):

```ts
    vscode.commands.registerCommand('marcode.review.open', () => { review.open(); }),
    vscode.commands.registerCommand('marcode.fleet.open', () => { fleet.open(); }),
    vscode.window.registerWebviewPanelSerializer(REVIEW_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { review.restore(panel); },
    }),
    vscode.window.registerWebviewPanelSerializer(FLEET_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { fleet.restore(panel); },
    }),
    { dispose: () => { review.dispose(); } },
    { dispose: () => { fleet.dispose(); } },
```

- [ ] **Step 10: Add the command contribution**

In `package.json`, beside `marcode.review.open` in `contributes.commands`:

```json
    { "command": "marcode.review.open", "title": "Marcode: Review fleet changes" },
    { "command": "marcode.fleet.open", "title": "Marcode: Open fleet view" }
```

- [ ] **Step 11: Fix every other `SessionPicker`/`PanelViewProvider` call site**

Run: `cd "e:/Efebia/hiiiid-code" && yarn check-types`

Fix any other test or call site TypeScript now flags for the added required props/params
(most likely `src/test/dom/*.test.tsx` files that render `<App>`/`<SessionPicker>` directly,
and `src/test/unit/*.test.ts` files that construct `PanelViewProvider` directly) by adding a
no-op `onFleet`/`onOpenFleet` argument matching the surrounding test's existing style for
`onReview`/`onOpenReview`.

- [ ] **Step 12: Run both new tests to verify they pass**

Run: `cd "e:/Efebia/hiiiid-code" && yarn test:dom --grep "open-fleet" && yarn test:unit --grep "open-fleet"`
Expected: PASS.

- [ ] **Step 13: Run the impeccable detector**

Run: `cd "e:/Efebia/hiiiid-code" && node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/session-picker.tsx src/webview/app.tsx`

- [ ] **Step 14: Run full gate and full test suites**

Run: `cd "e:/Efebia/hiiiid-code" && yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass.

- [ ] **Step 15: Manual verification**

Run: `cd "e:/Efebia/hiiiid-code" && yarn run` (or whichever script launches the Extension
Development Host per the project's `run` skill) and confirm: the fleet trigger opens an
editor tab; each roster session shows as a card with a live status and activity line;
clicking a card reveals the sidebar with that session in the split; opening a subagent's
full transcript replaces the pane and the breadcrumb returns to the session.

- [ ] **Step 16: Commit**

```bash
cd "e:/Efebia/hiiiid-code"
git add src/extension.ts package.json src/webview/components/session-picker.tsx src/webview/app.tsx src/protocol/messages.ts src/host/panel-view-provider.ts src/host/message-router.ts src/test/dom/session-picker.test.tsx src/test/unit/message-router.test.ts
git commit -m "feat: wire up the fleet view command and sidebar trigger"
```

---

## Explicitly out of scope (per spec)

- Sending new input into a running subagent (read-only transcript plus permission answers
  only).
- Sort/filter/search on the fleet grid.
- Nested subagents-of-subagents.

## Final check

- [ ] Run the closing `impeccable critique` over `src/webview`, `src/fleet`, and
  `src/review` in **two isolated agents, never the implementer** — per
  `CLAUDE.md`'s UI-changes-go-through-impeccable rule — before calling this feature merged.
