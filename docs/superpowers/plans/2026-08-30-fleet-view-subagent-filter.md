# Fleet view: subagents-only, filtered to one session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire Fleet's session-card grid; replace it with a forced session picker (scoped to
the sidebar's visible panes) over a running-subagents-only list (toggle reveals settled ones),
each opening the existing unwindowed `SubagentTranscript`. The sidebar's `SubagentCard` "Open
full transcript" now opens Fleet instead of drilling the pane in place.

**Architecture:** Fleet gains `session-patch`/`layout-changed` on its existing `PostBus`
allow-list (`FLEET_WANTS`) — both already gated to the visible-pane set, so no new gating
logic is needed. Fleet's client drops its own narrow `FleetState`/`reduceFleet` and mounts the
sidebar's real `StoreProvider`/`reduce()` (`src/webview/store.tsx`) instead, because
`PermissionCard`/`ToolCard` — reused verbatim inside `SubagentTranscript` — import `useStore`
from that exact module and throw outside it. One new `WebviewToHost` message
(`open-fleet-subagent`) carries a sidebar drill-in request to the host; one new `HostToWebview`
message (`fleet-focus-subagent`) carries it on to the Fleet client.

**Tech Stack:** TypeScript, React 19, esbuild, mocha + `@testing-library/react` + jsdom
(DOM tests), mocha (unit tests), shadcn/Base UI components under `@/components/ui/*`.

**Spec:** `docs/superpowers/specs/2026-08-30-fleet-view-subagent-filter-design.md`

## Global Constraints

- Filenames kebab-case; component identifiers PascalCase.
- No bare HTML controls — `Button` etc. from `@/components/ui/*` only.
- `src/protocol/messages.ts` stays types-only, no runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/`, and not `src/host/message-router.ts`,
  imports `vscode`.
- `session-patch`/`sessions-changed`/`session-status` fan-out rules stay exactly as they are;
  this plan only widens which messages Fleet's `PostBus` registration admits, never who gets
  gated.
- DOM tests: state arrives via genuine `HostToWebview` messages through a real `StoreProvider`
  (`sendFromHost`), assertions read booleans/strings/counts only — never hand a DOM node to
  `assert.strictEqual`.
- `yarn lint`, `yarn check-types`, `yarn run compile` must all pass before a commit.
- Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`); commit after
  every task.

---

## File Structure

**Protocol / host (wire wiring):**
- Modify `src/protocol/messages.ts` — two new message variants.
- Modify `src/host/post-bus.ts` — `FLEET_WANTS` widened.
- Modify `src/host/message-router.ts` — `open-fleet-subagent` no-op case + `KNOWN_MESSAGE_TAGS`.
- Modify `src/host/panel-view-provider.ts` — intercepts `open-fleet-subagent`, widens
  `onOpenFleet`'s signature.
- Modify `src/host/fleet-panel.ts` — `open(focus?)`, pending-focus flush after `ready`.
- Modify `src/extension.ts` — one-line callback signature update.

**Sidebar:**
- Modify `src/webview/components/pane-group.tsx` — drops in-pane drill-in; the context now
  posts to the host instead of setting local state.
- Modify `src/test/dom/pane-group.test.tsx` — the two in-pane-drill-in tests become one
  "posts `open-fleet-subagent`" test; the title/model/no-fork test relocates.
- Create `src/test/dom/subagent-transcript.test.tsx` — the relocated test, mounting
  `SubagentTranscript` standalone.

**Fleet client:**
- Delete `src/fleet/store.tsx`, `src/fleet/reducer.ts`, `src/fleet/session-card.tsx`.
- Modify `src/fleet/main.tsx` — mounts the sidebar's real `StoreProvider`.
- Create `src/fleet/filter-subagents.ts` — pure filter/sort helper, plus
  `src/test/unit/filter-subagents.test.ts`.
- Create `src/fleet/session-picker.tsx` — the forced session picker.
- Create `src/fleet/subagent-list.tsx` — one session's subagent rows + the running/all toggle.
- Rewrite `src/fleet/fleet-app.tsx` — the three-state shell (picker / list / transcript) plus
  the `fleet-focus-subagent` listener.
- Rewrite `src/test/dom/fleet-harness.tsx` — mounts `FleetApp` under the real `StoreProvider`.
- Rewrite `src/test/dom/fleet-app.test.tsx` — full behavior coverage.

**Unit tests touched, not created new files for:**
- `src/test/unit/post-bus.test.ts`, `src/test/unit/protocol.test.ts`,
  `src/test/unit/message-router.test.ts`.

---

### Task 1: Protocol — two new wire message types

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Produces: `WebviewToHost` variant `{ t: 'open-fleet-subagent'; sessionId: SessionId; itemId: string }`.
- Produces: `HostToWebview` variant `{ t: 'fleet-focus-subagent'; sessionId: SessionId; itemId: string }`.

- [ ] **Step 1: Write the failing exhaustiveness assertions**

In `src/test/unit/protocol.test.ts`, add one case to each switch in `describeInbound`/
`describeOutbound` (both already exist in the file, right before their `default: return
assertNever(m);` lines):

```ts
    case 'open-fleet-subagent': return 'open-fleet-subagent';
```
(inside `describeInbound`, alongside the existing `focus-session`/`open-fleet` cases)

```ts
    case 'fleet-focus-subagent': return 'fleet-focus-subagent';
```
(inside `describeOutbound`, alongside the existing `layout-changed` case)

Then add two new tests in the `suite('protocol', ...)` block, after the existing
`'session-mcp is an outbound variant...'` test:

```ts
  test('open-fleet-subagent is an inbound variant carrying a target subagent', () => {
    assert.strictEqual(
      describeInbound({ t: 'open-fleet-subagent', sessionId: 's1' as SessionId, itemId: 't1' }),
      'open-fleet-subagent',
    );
  });

  test('fleet-focus-subagent is an outbound variant carrying a target subagent', () => {
    assert.strictEqual(
      describeOutbound({ t: 'fleet-focus-subagent', sessionId: 's1' as SessionId, itemId: 't1' }),
      'fleet-focus-subagent',
    );
  });
```

`SessionId` is already imported in this file's type-only import list only as a bare type —
check the top of the file; if `SessionId` is not already imported, add it to the existing
`import type { HostToWebview, StaleTree, TranscriptItem, WebviewToHost } from
'../../protocol/messages';` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep protocol`
Expected: FAIL — TypeScript compile error, `'open-fleet-subagent'`/`'fleet-focus-subagent'` are
not assignable to `WebviewToHost['t']`/`HostToWebview['t']` yet (the switch cases and the two
new tests reference variants that don't exist).

- [ ] **Step 3: Add the two variants to messages.ts**

In `src/protocol/messages.ts`, add to the `WebviewToHost` union, immediately after the
existing `| { t: 'focus-session'; id: SessionId }` line:

```ts
  /**
   * A sidebar `SubagentCard`'s "Open full transcript" affordance, asking the
   * host to open (or reveal) the Fleet tab focused on this subagent, rather
   * than drilling the sidebar pane itself in place — see the fleet-view
   * subagent-filter design for why the in-pane drill-in was retired.
   *
   * Handled in `PanelViewProvider`, not `MessageRouter` — same interception
   * `open-fleet` already gets, and for the same reason (needs the `vscode`
   * API to reach `FleetPanel`).
   */
  | { t: 'open-fleet-subagent'; sessionId: SessionId; itemId: string }
```

Add to the `HostToWebview` union, immediately after the existing
`| { t: 'layout-changed'; layout: PaneLayout }` line:

```ts
  /**
   * Pushes a specific subagent open in the Fleet tab — the answer to
   * `open-fleet-subagent`. Sent directly by `FleetPanel` (its own
   * `MessageRouter`'s `emit`, or a direct `postMessage` when the panel
   * already exists), never through `PostBus`: it addresses one already-open
   * client in direct reply to its own request, not a broadcast.
   */
  | { t: 'fleet-focus-subagent'; sessionId: SessionId; itemId: string }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep protocol`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/protocol/messages.ts src/test/unit/protocol.test.ts
git commit -m "feat: add open-fleet-subagent and fleet-focus-subagent wire messages"
```

---

### Task 2: Widen `FLEET_WANTS`

**Files:**
- Modify: `src/host/post-bus.ts`
- Modify: `src/test/unit/post-bus.test.ts`

**Interfaces:**
- Consumes: `HostToWebview` from Task 1 (no change needed here — `session-patch` and
  `layout-changed` already exist on the wire).
- Produces: `FLEET_WANTS(msg: HostToWebview): boolean` now returns `true` for
  `session-patch` and `layout-changed` in addition to `sessions-changed`/`session-status`.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/post-bus.test.ts`, replace the existing
`'FLEET_WANTS admits only sessions-changed and session-status'` test with:

```ts
  test('FLEET_WANTS admits sessions-changed, session-status, session-patch, layout-changed', () => {
    assert.strictEqual(FLEET_WANTS({ t: 'sessions-changed', sessions: [] } as unknown as HostToWebview), true);
    assert.strictEqual(FLEET_WANTS({ t: 'session-status', id: 's1' as SessionId, status: 'idle' } as HostToWebview), true);
    assert.strictEqual(
      FLEET_WANTS({ t: 'session-patch', id: 's1' as SessionId, patch: { op: 'append', item: {} } } as unknown as HostToWebview),
      true,
    );
    assert.strictEqual(
      FLEET_WANTS({ t: 'layout-changed', layout: { orientation: 'vertical', panes: [] } } as HostToWebview),
      true,
    );
    assert.strictEqual(FLEET_WANTS({ t: 'fleet-diff', trees: [] } as unknown as HostToWebview), false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep FLEET_WANTS`
Expected: FAIL — the `session-patch` and `layout-changed` assertions get `false`.

- [ ] **Step 3: Widen the predicate**

In `src/host/post-bus.ts`, replace:

```ts
export const FLEET_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status';
```

with:

```ts
/**
 * The fleet view's allow-list. `session-patch` and `layout-changed` joined
 * 2026-08-30, once Fleet started rendering a session's subagent transcripts
 * rather than just roster status: both are already gated to the sidebar's
 * visible-pane set (`session-patch` by `SessionManager`, `layout-changed`
 * simply by carrying the current `PaneLayout` itself), so admitting them here
 * inherits that scope for free rather than deciding it a second time. Never
 * `fleet-diff` — Fleet has no diff surface — so a new message type still
 * defaults to not reaching this client, the same discipline `REVIEW_WANTS`
 * documents.
 */
export const FLEET_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status'
  || msg.t === 'session-patch' || msg.t === 'layout-changed';
```

Update the doc comment directly above it (the one starting `/** The fleet view's allow-list.
One narrower than REVIEW_WANTS...`) — delete that old comment block since the new one above
replaces it (it now says something materially different: Fleet does receive transcript
content).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep FLEET_WANTS`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/post-bus.ts src/test/unit/post-bus.test.ts
git commit -m "feat: admit session-patch and layout-changed into FLEET_WANTS"
```

---

### Task 3: `message-router` accepts `open-fleet-subagent` as a no-op

**Files:**
- Modify: `src/host/message-router.ts`
- Modify: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `WebviewToHost` variant `open-fleet-subagent` from Task 1.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/message-router.test.ts`, add a test right after the existing
`'open-fleet survives the wire guard as a deliberate no-op, same as open-review'` test:

```ts
  test('open-fleet-subagent survives the wire guard as a deliberate no-op, same as open-fleet', async () => {
    // Same trap as `answer-relocation` above: a tag missing from
    // KNOWN_MESSAGE_TAGS is silently dropped as "malformed" at runtime while
    // every type check still passes. `PanelViewProvider` always intercepts
    // this before it reaches a router — the router only needs to not choke
    // on it if it ever does, backing both PanelViewProvider and FleetPanel.
    sent.length = 0;
    await router.handle({ t: 'open-fleet-subagent', sessionId: 's1' as any, itemId: 't1' });
    assert.deepStrictEqual(sent, []);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep open-fleet-subagent`
Expected: FAIL — `route()`'s `isWireMessage` guard rejects the tag (not in
`KNOWN_MESSAGE_TAGS`), logged via `console.error` as malformed rather than silently returning,
so `sent` stays `[]` regardless — **actually check this carefully**: the test as written
passes even before Step 3, because a "malformed" drop also results in `sent === []`. To make
the test meaningfully verify the no-op case (not just "nothing crashed"), assert on the
console error instead: wrap with a spy.

Revise Step 1's test to actually distinguish the two outcomes:

```ts
  test('open-fleet-subagent survives the wire guard as a deliberate no-op, same as open-fleet', async () => {
    sent.length = 0;
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await router.handle({ t: 'open-fleet-subagent', sessionId: 's1' as any, itemId: 't1' });
    } finally {
      console.error = originalError;
    }
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(errors, [], 'a known tag must not log as malformed');
  });
```

Run again: `yarn test:unit:raw --grep open-fleet-subagent`
Expected: FAIL — `errors` contains the `'dropping malformed message'` log, since
`open-fleet-subagent` is not yet in `KNOWN_MESSAGE_TAGS`.

- [ ] **Step 3: Add the case and the tag**

In `src/host/message-router.ts`, add to the `route()` switch, right after the existing
`case 'open-fleet': return;` block:

```ts
      // Same precedent as open-fleet: PanelViewProvider intercepts this
      // before delegating, since opening the fleet tab at a specific
      // subagent needs the vscode API this module must not import.
      case 'open-fleet-subagent':
        return;
```

Add `'open-fleet-subagent'` to `KNOWN_MESSAGE_TAGS`, in the same group as `'open-review',
'open-fleet', 'focus-session'`:

```ts
  'request-fleet-diff', 'open-file-diff', 'open-review', 'open-fleet', 'open-fleet-subagent',
  'focus-session',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep open-fleet-subagent`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: accept open-fleet-subagent as a router no-op"
```

---

### Task 4: `PaneGroup` posts `open-fleet-subagent` instead of drilling in-place

**Files:**
- Modify: `src/webview/components/pane-group.tsx`
- Modify: `src/test/dom/pane-group.test.tsx`

**Interfaces:**
- Consumes: `WebviewToHost` variant `open-fleet-subagent` (Task 1), `posted()`/`sendFromHost`
  from `src/test/dom/harness.tsx`.
- Produces: `PaneGroup` no longer renders `SubagentTranscript` or holds `drilledIn` state.

- [ ] **Step 1: Write the failing test**

In `src/test/dom/pane-group.test.tsx`, replace the entire
`'opening a subagent transcript replaces the pane, and the breadcrumb returns'` test (currently
lines 334–365) with:

```ts
  test('opening a subagent posts open-fleet-subagent instead of drilling the pane in place', async () => {
    renderApp();
    const subagentItem: TranscriptItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      state: 'ok', children: [],
    };
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [snapshot('a', { items: [subagentItem] })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /explore/i }));
    fireEvent.click(screen.getByRole('button', { name: /open full transcript/i }));

    // The pane itself is untouched — no breadcrumb, composer still present —
    // and the request went to the host instead.
    assert.strictEqual(screen.queryByRole('button', { name: /back to/i }) === null, true);
    assert.strictEqual(screen.queryAllByRole('textbox').length, 1);
    const messages = posted().filter((m) => m.t === 'open-fleet-subagent');
    assert.deepStrictEqual(messages, [{ t: 'open-fleet-subagent', sessionId: 'a', itemId: 't1' }]);
  });
```

Also **delete** the next test, `'a subagent transcript shows a visible session title and the
model, and offers no dead fork'` (currently lines 367–402) — it moves to
`src/test/dom/subagent-transcript.test.tsx` in Task 5. Leave the `SubagentTranscript`-specific
children array/subagentItem fixtures inside it untouched; they are being relocated, not
rewritten. Remove the now-unused `Array.from` children fixture in the test you deleted here —
double check no other test in this file references `children` from that block (it does not;
each test in this file declares its own local `children`).

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom:raw --grep "open-fleet-subagent"`
Expected: FAIL — `PaneGroup` still drills in place, so no `open-fleet-subagent` message is
posted, and the breadcrumb button IS present, failing the `queryByRole(...) === null` assertion.

- [ ] **Step 3: Simplify `PaneGroup`**

In `src/webview/components/pane-group.tsx`:

Remove the `drilledIn` state declaration and its doc comment (currently around line 83–89):

```ts
  const [drilledIn, setDrilledIn] = useState<Record<string, string>>({});
```

Remove the `SubagentTranscript` import and the `useState` import stays (still used elsewhere in
the file for other state — check before removing the import entirely; `useState` is also used
by other hooks in this file, so only remove the `SubagentTranscript` import line):

```ts
import { SubagentTranscript } from "./subagent-transcript";
```

Replace the whole `(() => { const openItemId = ...; ... })()` IIFE block (currently lines
287–345) — the one that branches between `SubagentTranscript` and the normal
`SessionHeader`+`Transcript`+`Composer` — with the normal branch unconditionally, and change
what `SubagentDrillInContext.Provider` supplies:

```tsx
                  <div className="flex h-full flex-col">
                    <SessionHeader
                      pane={paneState}
                      accessibleTitle={names.get(paneState.summary.id)!}
                    />
                    <SubagentDrillInContext.Provider
                      value={(itemId) =>
                        post({ t: "open-fleet-subagent", sessionId: pane.sessionId, itemId })
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
```

(This replaces the `{(() => { ... })()}` expression directly inside
`<MessageScrollerProvider autoScroll defaultScrollPosition="end">`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom:raw --grep "PaneGroup"`
Expected: PASS — including every other `PaneGroup` test untouched by this change (e.g. the
`layout-changed` test at the bottom of the file, which does not touch drill-in at all).

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/pane-group.tsx src/test/dom/pane-group.test.tsx
git commit -m "feat: PaneGroup opens Fleet for a subagent instead of drilling in place"
```

---

### Task 5: Relocate the `SubagentTranscript` rendering test

**Files:**
- Create: `src/test/dom/subagent-transcript.test.tsx`

**Interfaces:**
- Consumes: `SubagentTranscript` from `src/webview/components/subagent-transcript.tsx`
  (unchanged), `renderWithStore` from `src/test/dom/harness.tsx`,
  `MessageScrollerProvider` from `@/components/ui/message-scroller`.

- [ ] **Step 1: Write the test (this is the relocation, not new coverage — no separate "make
it fail" step makes sense here since nothing production-side changes; write it, then run it,
since a copy-paste move can still typo an import)**

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { MessageScrollerProvider } from '@/components/ui/message-scroller';
import { SubagentTranscript } from '@/components/subagent-transcript';
import { renderWithStore, resetHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

suite('SubagentTranscript', () => {
  setup(() => { resetHost(); });

  test('shows a visible session title and the model, and offers no dead fork', () => {
    const children: TranscriptItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, ts: i + 1, role: 'tool', toolId: `c${i}`,
      tool: { kind: 'other', label: `Tool${i}`, raw: {} }, state: 'ok',
    }));
    const subagentItem: ToolItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore', model: 'opus' },
      state: 'ok', children,
    };

    renderWithStore(
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <SubagentTranscript
          item={subagentItem}
          sessionId={'a' as TranscriptItem['id']}
          title="My Session"
          onBack={() => {}}
        />
      </MessageScrollerProvider>,
    );

    // The session title is visible text, not only an aria-label.
    assert.strictEqual(screen.getByText('My Session') !== undefined, true);
    // The model rides along on the "Subagent: …" line.
    assert.strictEqual(screen.getByText(/subagent:.*explore.*opus/i) !== undefined, true);
    // No child offers a fork: subagent children aren't top-level JSONL
    // items, so TranscriptStore.upTo() can never find one and the control
    // would silently do nothing. (Idle-session TranscriptItemView would
    // offer "Fork from here" on every top-level 'tool' item if these
    // children were ever routed through it — exactly the bug this must not
    // reintroduce.)
    assert.strictEqual(screen.queryAllByRole('button', { name: /fork from here/i }).length, 0);
  });

  test('unwindowed: renders every child, not just the last ten', () => {
    const children: TranscriptItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, ts: i + 1, role: 'tool', toolId: `c${i}`,
      tool: { kind: 'other', label: `Tool${i}`, raw: {} }, state: 'ok',
    }));
    const subagentItem: ToolItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      state: 'ok', children,
    };

    renderWithStore(
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <SubagentTranscript
          item={subagentItem}
          sessionId={'a' as TranscriptItem['id']}
          title="My Session"
          onBack={() => {}}
        />
      </MessageScrollerProvider>,
    );

    assert.strictEqual(screen.getByText('Tool0') !== undefined, true, 'the oldest child is present');
    assert.strictEqual(screen.getByText('Tool24') !== undefined, true, 'the newest child is present');
  });
});
```

Note: `sessionId={'a' as TranscriptItem['id']}` is wrong — `SessionId` is its own type, not
`TranscriptItem['id']`. Use `import type { SessionId, TranscriptItem } from
'../../protocol/messages';` and `sessionId={'a' as SessionId}`.

- [ ] **Step 2: Run the test**

Run: `yarn test:dom:raw --grep "SubagentTranscript"`
Expected: PASS immediately — this is a relocation of already-working behavior, so a failure
here means the copy introduced a real regression (e.g. wrong import path), not a missing
feature.

- [ ] **Step 3: Commit**

```bash
git add src/test/dom/subagent-transcript.test.tsx
git commit -m "test: relocate SubagentTranscript rendering coverage out of pane-group"
```

---

### Task 6: `filter-subagents.ts` — pure filter/sort helper

**Files:**
- Create: `src/fleet/filter-subagents.ts`
- Create: `src/test/unit/filter-subagents.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` from `src/protocol/messages.ts`.
- Produces: `filterSubagents(items: TranscriptItem[], opts: { includeSettled: boolean }):
  Extract<TranscriptItem, { role: 'tool' }>[]`, oldest-first.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/unit/filter-subagents.test.ts
import * as assert from 'assert';
import { filterSubagents } from '../../fleet/filter-subagents';
import type { TranscriptItem } from '../../protocol/messages';

function subagent(id: string, ts: number, state: 'running' | 'ok' | 'error'): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: `Agent${id}` },
    state,
  };
}

function plainTool(id: string, ts: number): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'other', label: 'Read', raw: {} },
    state: 'ok',
  };
}

suite('filterSubagents', () => {
  test('excludes non-subagent tool items and every non-tool role', () => {
    const items: TranscriptItem[] = [
      plainTool('p1', 1),
      { id: 'u1', ts: 2, role: 'user', text: 'hi' },
      subagent('s1', 3, 'running'),
    ];
    const result = filterSubagents(items, { includeSettled: true });
    assert.deepStrictEqual(result.map((i) => i.id), ['s1']);
  });

  test('running-only by default, oldest first', () => {
    const items: TranscriptItem[] = [
      subagent('s1', 10, 'ok'),
      subagent('s2', 5, 'running'),
      subagent('s3', 20, 'running'),
    ];
    const result = filterSubagents(items, { includeSettled: false });
    assert.deepStrictEqual(result.map((i) => i.id), ['s2', 's3']);
  });

  test('includeSettled reveals ok and error subagents too, still oldest first', () => {
    const items: TranscriptItem[] = [
      subagent('s1', 10, 'ok'),
      subagent('s2', 5, 'running'),
      subagent('s3', 1, 'error'),
    ];
    const result = filterSubagents(items, { includeSettled: true });
    assert.deepStrictEqual(result.map((i) => i.id), ['s3', 's2', 's1']);
  });

  test('empty input yields an empty list', () => {
    assert.deepStrictEqual(filterSubagents([], { includeSettled: false }), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep filterSubagents`
Expected: FAIL — `Cannot find module '../../fleet/filter-subagents'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/fleet/filter-subagents.ts
// Pure helper for FleetApp's per-session subagent list — kept free of React
// so it unit-tests without mounting anything, the same split
// active-subagents.ts and subagent-window.ts use.
import type { TranscriptItem } from '../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A session's top-level subagent tool calls — never a subagent's own
 * children (depth stays capped at 1, same as everywhere else in this
 * codebase), never a plain tool call, and never a non-tool item. Running by
 * default; `includeSettled` reveals `ok`/`error` ones too. Oldest first,
 * matching `active-subagents.ts`'s ordering, so a list that grows over a
 * session's lifetime doesn't reorder rows the user has already scanned.
 */
export function filterSubagents(
  items: TranscriptItem[],
  opts: { includeSettled: boolean },
): ToolItem[] {
  return items
    .filter((item): item is ToolItem => item.role === 'tool' && item.tool.kind === 'subagent')
    .filter((item) => opts.includeSettled || item.state === 'running')
    .sort((a, b) => a.ts - b.ts);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep filterSubagents`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fleet/filter-subagents.ts src/test/unit/filter-subagents.test.ts
git commit -m "feat: add pure subagent-list filter for fleet view"
```

---

### Task 7: Host wiring — `FleetPanel.open(focus?)`, `PanelViewProvider` interception, `extension.ts`

**Files:**
- Modify: `src/host/fleet-panel.ts`
- Modify: `src/host/panel-view-provider.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `WebviewToHost['open-fleet-subagent']`, `HostToWebview['fleet-focus-subagent']`
  (Task 1).
- Produces: `FleetPanel.open(focus?: { sessionId: SessionId; itemId: string }): void`.
  `PanelViewProvider`'s constructor parameter (currently typed `onOpenFleet: () => void`)
  becomes `onOpenFleet: (focus?: { sessionId: SessionId; itemId: string }) => void`.

No automated test for this task: `FleetPanel`/`PanelViewProvider` both `import * as vscode from
'vscode'` directly and are only exercised today by the `@vscode/test-cli` integration tier via
full extension activation — neither `open-review`/`open-fleet`/`focus-session`'s existing
interceptions have a unit or integration test either (confirmed: nothing in
`src/test/integration/extension.test.ts` exercises `resolveWebviewView`'s
`onDidReceiveMessage` callback at all). This task matches that existing precedent rather than
inventing a new test tier unprompted. Verify by running the extension (`run` skill or F5) and
clicking "Open full transcript" on a subagent card once Task 11 lands the client-side trigger.

- [ ] **Step 1: `FleetPanel.open(focus?)`**

In `src/host/fleet-panel.ts`:

Add a field alongside the existing `private panel`/`private unregister`/`private
subscriptions`:

```ts
  /**
   * A drill-in requested before the panel existed (or before its `ready`
   * handshake completed) — held until `adopt()`'s message handler sees this
   * panel's own `ready` produce a `hydrate` the target session is guaranteed
   * to be inside, then sent and cleared. Never sent early: a client asked to
   * select a subagent it has no items for yet would just fail to find it.
   */
  private pendingFocus: { sessionId: SessionId; itemId: string } | undefined;
```

Add `SessionId` to the existing type-only import from `'../protocol/messages'` at the top of
the file (currently just `WebviewToHost` — check the exact import line and extend it, e.g.
`import type { SessionId, WebviewToHost } from '../protocol/messages';`).

Replace the `open()` method:

```ts
  open(focus?: { sessionId: SessionId; itemId: string }): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      if (focus) {
        void this.panel.webview.postMessage({ t: 'fleet-focus-subagent', ...focus });
      }
      return;
    }
    this.pendingFocus = focus;
    const panel = vscode.window.createWebviewPanel(
      FLEET_VIEW_TYPE, 'Fleet', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }
```

In `adopt()`, inside the `onDidReceiveMessage` handler, change the `'ready'`-adjacent
handling: currently every message not explicitly intercepted (`focus-session`) falls through
to `await router.handle(raw);` at the end of the `try` block. Add an explicit branch for
`'ready'` right before that fallthrough call, so the flush happens once and only once, right
after this panel's own hydrate goes out:

```ts
        if (raw?.t === 'ready') {
          await router.handle(raw);
          if (this.pendingFocus) {
            void panel.webview.postMessage({ t: 'fleet-focus-subagent', ...this.pendingFocus });
            this.pendingFocus = undefined;
          }
          return;
        }
        await router.handle(raw);
```

(Insert this immediately above the existing `if (raw?.t === 'focus-session') { ... }` block, or
below it — order between the two doesn't matter, they're disjoint tags.)

Clear `pendingFocus` alongside the rest of this panel's bookkeeping in both places that already
reset it (`restore()`'s pre-adopt cleanup and `onDidDispose`), so a focus meant for a panel that
never sent `ready` doesn't leak into the next one:

In `restore()`, inside the `if (old !== undefined)` block, add `this.pendingFocus = undefined;`
next to the existing `this.panel = undefined;`.

In the `onDidDispose` handler inside `adopt()`, add `this.pendingFocus = undefined;` next to
its existing `this.panel = undefined;`.

- [ ] **Step 2: `PanelViewProvider` — widen `onOpenFleet` and intercept `open-fleet-subagent`**

In `src/host/panel-view-provider.ts`:

Change the constructor parameter type (currently `private readonly onOpenFleet: () => void,`):

```ts
    private readonly onOpenFleet: (focus?: { sessionId: SessionId; itemId: string }) => void,
```

(`SessionId` is already imported in this file's top-level type-only import.)

In `resolveWebviewView`'s `onDidReceiveMessage` handler, add a branch right after the existing
`if (raw?.t === 'open-fleet') { ... }` block:

```ts
        if (raw?.t === 'open-fleet-subagent') {
          this.onOpenFleet({ sessionId: raw.sessionId, itemId: raw.itemId });
          return;
        }
```

- [ ] **Step 3: `extension.ts` — pass the focus through**

In `src/extension.ts`, change:

```ts
    () => { fleet.open(); },
```

to:

```ts
    (focus) => { fleet.open(focus); },
```

(This is the sixth positional argument to `new PanelViewProvider(...)`, currently the line
right after `() => { review.open(); },`.)

- [ ] **Step 4: Verify types**

Run: `yarn check-types`
Expected: PASS — no test to run for this task; this is the type-check gate mentioned above.

- [ ] **Step 5: Commit**

```bash
git add src/host/fleet-panel.ts src/host/panel-view-provider.ts src/extension.ts
git commit -m "feat: open Fleet focused on a specific subagent from the sidebar"
```

---

### Task 8: Delete Fleet's standalone store/reducer; mount the real one

**Files:**
- Delete: `src/fleet/store.tsx`
- Delete: `src/fleet/reducer.ts`
- Modify: `src/fleet/main.tsx`

**Interfaces:**
- Consumes: `StoreProvider`, `useStore` from `src/webview/store.tsx` (unchanged there).

No new test in this task — `src/fleet/reducer.ts` had no dedicated unit test file (confirmed:
nothing under `src/test/` imports `fleet/reducer` or `fleet/store` except
`src/test/dom/fleet-harness.tsx`, which Task 11 rewrites). `main.tsx` has no test coverage
today either (it's an entry point, not exported logic) and gains none here, matching
`src/webview/main.tsx`/`src/review/main.tsx`'s own precedent.

- [ ] **Step 1: Delete the two files**

```bash
rm src/fleet/store.tsx src/fleet/reducer.ts
```

- [ ] **Step 2: Update `main.tsx`**

Replace `src/fleet/main.tsx` entirely:

```tsx
import { createRoot } from 'react-dom/client';
import { FleetApp } from './fleet-app';
import { StoreProvider } from '../webview/store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <FleetApp />
    </StoreProvider>,
  );
}
```

- [ ] **Step 3: Confirm nothing else references the deleted files**

Run: `grep -rn "fleet/reducer\|fleet/store" src` (excluding this plan doc and the spec doc)
Expected: no matches outside `src/fleet/main.tsx`'s old import (already replaced) and
`src/test/dom/fleet-harness.tsx` (rewritten in Task 11 — leave it broken between this task and
Task 11; Tasks 9–10 land first and don't touch it, so run the full check again at the end of
Task 11, not here).

- [ ] **Step 4: Commit**

```bash
git add -A src/fleet/main.tsx
git rm src/fleet/store.tsx src/fleet/reducer.ts
git commit -m "refactor: fleet client mounts the sidebar's real store, not a duplicate"
```

(Fleet won't type-check or build cleanly again until Task 9 lands `fleet-app.tsx`'s new
shape — that's expected; Tasks 8–10 are one coherent unit of work checkpointed for review
granularity, not independently shippable. Run `yarn check-types` again only after Task 10.)

---

### Task 9: `FleetApp`, `session-picker.tsx`, `subagent-list.tsx`

**Files:**
- Create: `src/fleet/session-picker.tsx`
- Create: `src/fleet/subagent-list.tsx`
- Rewrite: `src/fleet/fleet-app.tsx`
- Delete: `src/fleet/session-card.tsx`

**Interfaces:**
- Consumes: `ClientState`, `useStore` from `src/webview/store.tsx`; `PaneState` from
  `src/webview/reducer.ts`; `filterSubagents` from `src/fleet/filter-subagents.ts`;
  `subagentLabel`, `summarizeSubagent`, `formatElapsed`, `subagentStateLabel` from
  `src/webview/components/subagent-window.ts`; `SubagentTranscript` from
  `src/webview/components/subagent-transcript.tsx`; `MessageScrollerProvider` from
  `@/components/ui/message-scroller`; `StatusBadge` from `src/webview/components/status-badge.tsx`.
- Produces: `SessionPicker({ layout: PaneLayout, byId: Record<SessionId, PaneState>, onPick:
  (id: SessionId) => void })`; `SubagentList({ pane: PaneState, showSettled: boolean,
  onToggleSettled: () => void, onOpen: (itemId: string) => void, onBack: () => void })`;
  `FleetApp()` (no props — reads `useStore()` itself). This task does not yet wire the
  `fleet-focus-subagent` listener (Task 10) — `FleetApp` here only handles picker/list/back
  driven by clicks, with `selectedSessionId`/`selectedSubagentId`/`showSettled` as local state.

- [ ] **Step 1: `session-picker.tsx`**

```tsx
// src/fleet/session-picker.tsx
import { Button } from '@/components/ui/button';
import { StatusBadge } from '../webview/components/status-badge';
import type { PaneLayout, PaneState } from '../webview/reducer';
import type { SessionId } from '../protocol/messages';

/**
 * The forced first step of the fleet tab: pick which of the sidebar's
 * visible sessions to look at. No "all sessions" option — see the fleet
 * subagent-filter design for why a merged view was rejected. `layout.panes`
 * (not the roster) is the source of the row order: a session split into the
 * sidebar is exactly Fleet's scope, nothing more.
 */
export function SessionPicker({
  layout, byId, onPick,
}: {
  layout: PaneLayout;
  byId: Record<SessionId, PaneState>;
  onPick: (id: SessionId) => void;
}) {
  if (layout.panes.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No sessions in the sidebar's split. Open one there first.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="text-xs text-muted-foreground">Pick a session to see its subagents.</p>
      {layout.panes.map((pane) => {
        const paneState = byId[pane.sessionId];
        if (!paneState) { return null; }
        return (
          <Button
            key={pane.sessionId}
            variant="outline"
            className="flex h-auto w-full items-center justify-between gap-2 p-2 text-left text-xs font-normal"
            onClick={() => onPick(pane.sessionId)}
          >
            <span className="truncate font-medium">{paneState.summary.title}</span>
            <StatusBadge status={paneState.summary.status} />
          </Button>
        );
      })}
    </div>
  );
}
```

`PaneState` needs to be an exported type from `src/webview/reducer.ts` — check whether it
already is (it's referenced as `PaneState` throughout `pane-group.tsx`, so it's very likely
already `export interface PaneState { ... }`; if it is declared without `export`, add `export`
to that one declaration — this is the only change `reducer.ts` needs in this whole plan).

- [ ] **Step 2: `subagent-list.tsx`**

```tsx
// src/fleet/subagent-list.tsx
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { filterSubagents } from './filter-subagents';
import {
  formatElapsed, subagentLabel, subagentStateLabel, summarizeSubagent,
} from '../webview/components/subagent-window';
import type { PaneState } from '../webview/reducer';

/**
 * One session's subagents — running by default, `showSettled` reveals
 * finished/failed ones too. Each row's summary line is computed the same way
 * `SubagentCard`'s collapsed header is, so this list and the sidebar's
 * inline card never describe one subagent two different ways.
 */
export function SubagentList({
  pane, showSettled, onToggleSettled, onOpen, onBack,
}: {
  pane: PaneState;
  showSettled: boolean;
  onToggleSettled: () => void;
  onOpen: (itemId: string) => void;
  onBack: () => void;
}) {
  const subagents = filterSubagents(pane.items, { includeSettled: showSettled });
  const now = Date.now();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-6 gap-1 px-1 font-normal text-muted-foreground"
        >
          <ChevronLeftIcon aria-hidden className="size-3.5" />
          <span className="truncate">{pane.summary.title}</span>
        </Button>
        <Button
          variant={showSettled ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={showSettled}
          className="h-6 px-2 font-normal"
          onClick={onToggleSettled}
        >
          {showSettled ? 'Showing all' : 'Running only'}
        </Button>
      </div>
      {subagents.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          {showSettled ? 'No subagents yet.' : 'No subagents running right now.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-2">
          {subagents.map((item) => {
            const summary = summarizeSubagent(item, now);
            return (
              <Button
                key={item.id}
                variant="outline"
                className="flex h-auto w-full items-center justify-between gap-2 p-2 text-left text-xs font-normal"
                onClick={() => onOpen(item.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{subagentLabel(item)}</span>
                  <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
                  {summary.blocked && (
                    <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
                      Needs you
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
                  {' · '}{formatElapsed(summary.elapsedMs)}
                </span>
                <ChevronRightIcon aria-hidden className="shrink-0 size-3.5 text-muted-foreground" />
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `fleet-app.tsx`**

```tsx
// src/fleet/fleet-app.tsx
import { useState } from 'react';
import { MessageScrollerProvider } from '@/components/ui/message-scroller';
import { useStore } from '../webview/store';
import { SubagentTranscript } from '../webview/components/subagent-transcript';
import { SessionPicker } from './session-picker';
import { SubagentList } from './subagent-list';
import type { SessionId } from '../protocol/messages';

export function FleetApp() {
  const { state } = useStore();
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | null>(null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  if (!state.ready) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!selectedSessionId) {
    return (
      <SessionPicker
        layout={state.layout}
        byId={state.byId}
        onPick={setSelectedSessionId}
      />
    );
  }

  const pane = state.byId[selectedSessionId];
  if (!pane) {
    // The session left the sidebar's split (closed, hidden) while Fleet had
    // it selected — back out to the picker rather than rendering a session
    // that no longer exists here.
    setSelectedSessionId(null);
    return null;
  }

  if (selectedSubagentId) {
    const item = pane.items.find((i) => i.id === selectedSubagentId);
    if (item && item.role === 'tool') {
      return (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <SubagentTranscript
            item={item}
            sessionId={pane.summary.id}
            title={pane.summary.title}
            onBack={() => setSelectedSubagentId(null)}
          />
        </MessageScrollerProvider>
      );
    }
    // A stale id (the item aged out, or the session reset) falls through to
    // the list instead of throwing — same tolerance PaneGroup's old drill-in
    // gave a stale id.
  }

  return (
    <SubagentList
      pane={pane}
      showSettled={showSettled}
      onToggleSettled={() => setShowSettled((v) => !v)}
      onOpen={setSelectedSubagentId}
      onBack={() => setSelectedSessionId(null)}
    />
  );
}
```

Delete `src/fleet/session-card.tsx` — nothing imports it once `fleet-app.tsx` above no longer
does.

```bash
rm src/fleet/session-card.tsx
```

- [ ] **Step 4: Type-check**

Run: `yarn check-types`
Expected: PASS. If `PaneState` was not already exported from `src/webview/reducer.ts`, this is
where that surfaces — add the `export` there and re-run.

- [ ] **Step 5: Commit**

```bash
git add -A src/fleet/fleet-app.tsx src/fleet/session-picker.tsx src/fleet/subagent-list.tsx src/webview/reducer.ts
git rm src/fleet/session-card.tsx
git commit -m "feat: fleet view shows a session picker over a subagent list"
```

---

### Task 10: `fleet-focus-subagent` listener in `FleetApp`

**Files:**
- Modify: `src/fleet/fleet-app.tsx`

**Interfaces:**
- Consumes: `onHostMessage` from `@/vscode-api`; `HostToWebview['fleet-focus-subagent']`
  (Task 1).

- [ ] **Step 1: Add the listener**

In `src/fleet/fleet-app.tsx`, add an import and a `useEffect`:

```tsx
import { useEffect, useState } from 'react';
import { onHostMessage } from '@/vscode-api';
```

(merge with the existing `import { useState } from 'react';` line, replacing it)

Inside `FleetApp`, right after the three `useState` calls:

```tsx
  // Independent of the ClientState reducer's own onHostMessage subscription
  // (mounted by StoreProvider) — this is Fleet-only UI state with no home in
  // ClientState, so it listens for the one message type that reducer has no
  // case for (and correctly no-ops on, via its exhaustive switch's default
  // branch) rather than routing it through dispatch.
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.t !== 'fleet-focus-subagent') { return; }
      setSelectedSessionId(msg.sessionId);
      setSelectedSubagentId(msg.itemId);
    });
  }, []);
```

- [ ] **Step 2: Write the DOM test**

This is covered together with Task 11's `fleet-app.test.tsx` rewrite (that file needs the
rewritten harness from Task 11 to exist first) — see Task 11, Step 1, test 6
("`fleet-focus-subagent` selects both the session and the subagent").

- [ ] **Step 3: Type-check**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/fleet/fleet-app.tsx
git commit -m "feat: fleet view jumps to a subagent on fleet-focus-subagent"
```

---

### Task 11: Fleet DOM test harness and full behavior coverage

**Files:**
- Rewrite: `src/test/dom/fleet-harness.tsx`
- Rewrite: `src/test/dom/fleet-app.test.tsx`

**Interfaces:**
- Consumes: `renderWithStore`, `posted`, `resetHost`, `sendFromHost` from
  `src/test/dom/harness.tsx`; `catalog`, `layoutOf`, `snapshot`, `summary` from
  `src/test/fixtures/protocol`; `FleetApp` from `src/fleet/fleet-app.tsx`.

- [ ] **Step 1: Rewrite the harness**

```tsx
// src/test/dom/fleet-harness.tsx
import type { RenderResult } from '@testing-library/react';
import type * as FleetAppModule from '../../fleet/fleet-app';
import { renderWithStore } from './harness';

// Re-exported so a fleet spec imports one module, same precedent as before.
export { posted, resetHost, sendFromHost } from './harness';

const { FleetApp } = require('../../fleet/fleet-app') as typeof FleetAppModule;

/** Same assertion warning as `renderApp`/`renderWithStore` — never assert on a node. */
export function renderFleet(): RenderResult {
  return renderWithStore(<FleetApp />);
}
```

- [ ] **Step 2: Rewrite `fleet-app.test.tsx`**

```tsx
// src/test/dom/fleet-app.test.tsx
import { suite, test } from 'mocha';
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderFleet, resetHost, sendFromHost } from './fleet-harness';
import type { TranscriptItem } from '../../protocol/messages';

function subagent(id: string, ts: number, state: 'running' | 'ok' | 'error', agent = 'Explore'): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent },
    state, children: [],
  };
}

function hydrateWith(paneIds: string[], itemsBySession: Record<string, TranscriptItem[]> = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: paneIds.map((id) => summary(id)),
    layout: layoutOf(...paneIds),
    snapshots: paneIds.map((id) => snapshot(id, { items: itemsBySession[id] ?? [] })),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('FleetApp', () => {
  setup(() => { resetHost(); });

  test('forces a session pick before showing anything else', () => {
    renderFleet();
    hydrateWith(['a', 'b']);
    assert.strictEqual(screen.getByText(/pick a session/i) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('b').title) !== undefined, true);
  });

  test('an empty sidebar split says so, with no session to pick', () => {
    renderFleet();
    hydrateWith([]);
    assert.strictEqual(screen.getByText(/open one there first/i) !== undefined, true);
  });

  test('picking a session narrows to its running subagents by default', async () => {
    renderFleet();
    hydrateWith(['a'], {
      a: [subagent('s1', 1, 'running', 'Explore'), subagent('s2', 2, 'ok', 'Plan')],
    });
    await userEvent.click(screen.getByText(summary('a').title));

    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
    assert.strictEqual(screen.queryByText(/plan/i) === null, true);
  });

  test('toggling reveals settled subagents too', async () => {
    renderFleet();
    hydrateWith(['a'], {
      a: [subagent('s1', 1, 'running', 'Explore'), subagent('s2', 2, 'ok', 'Plan')],
    });
    await userEvent.click(screen.getByText(summary('a').title));
    await userEvent.click(screen.getByRole('button', { name: /running only/i }));

    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
    assert.strictEqual(screen.getByText(/plan/i) !== undefined, true);
  });

  test('opening a subagent shows its transcript, and back returns to the list, not the picker', async () => {
    renderFleet();
    hydrateWith(['a'], { a: [subagent('s1', 1, 'running', 'Explore')] });
    await userEvent.click(screen.getByText(summary('a').title));
    await userEvent.click(screen.getByText(/explore/i));

    assert.strictEqual(screen.getByText(/subagent:.*explore/i) !== undefined, true);

    // SubagentTranscript's own breadcrumb button is labelled "Back to
    // <title>" — the same session title used throughout this file.
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`back to ${summary('a').title}`, 'i') }));

    assert.strictEqual(screen.queryByText(/pick a session/i) === null, true);
    // Back from the transcript returns to the list (session still selected,
    // not all the way to the picker) — the row is visible again.
    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
  });

  test('fleet-focus-subagent selects both the session and the subagent from the picker', () => {
    renderFleet();
    hydrateWith(['a'], { a: [subagent('s1', 1, 'running', 'Explore')] });
    // Still on the picker — nothing selected yet.
    assert.strictEqual(screen.getByText(/pick a session/i) !== undefined, true);

    sendFromHost({ t: 'fleet-focus-subagent', sessionId: 'a', itemId: 's1' });

    assert.strictEqual(screen.getByText(/subagent:.*explore/i) !== undefined, true);
  });

  test('layout-changed hides a pane the sidebar closed, without a fresh hydrate', () => {
    renderFleet();
    hydrateWith(['a', 'b']);
    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('b').title) !== undefined, true);

    // The sidebar's split dropped 'b' — Fleet's own PostBus registration
    // receives this echo (Task 2's FLEET_WANTS) the same way the sidebar
    // does, and the picker (driven by `state.layout`, not a cached list)
    // must reflect it without a full re-`ready`.
    sendFromHost({ t: 'layout-changed', layout: layoutOf('a') });

    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.queryByText(summary('b').title) === null, true);
  });
});

- [ ] **Step 3: Run tests, fix what fails**

Run: `yarn test:dom:raw --grep "FleetApp"`

This is the first end-to-end run of Tasks 8–10's composition, so treat any failure as real
signal rather than an expected red step. Likely first-pass issues to check if something fails:
- `state.byId`/`state.layout` not present on `ClientState` under the names used here — confirm
  against `src/webview/reducer.ts`'s actual field names (they are `byId` and `layout`, per the
  `hydrate` case read during planning; if a rename ever occurred, match the current names).
- `SubagentTranscript`'s `sessionId` prop type — confirm it is `SessionId`, and that
  `pane.summary.id` (used in `fleet-app.tsx`) satisfies it.
- The `SessionPicker` row's clickable text vs. the `StatusBadge` inside the same `Button`
  swallowing the click target — if `getByText(summary('a').title)` matches more than one node
  (unlikely here, but check), scope the query with `within()`.

Iterate on `fleet-app.tsx`/`session-picker.tsx`/`subagent-list.tsx` until every test in this
suite passes. Do not weaken an assertion to make it pass — a failing assertion here means the
component tree doesn't yet do what Task 9/10's spec said it would.

Expected once fixed: PASS, all six tests.

- [ ] **Step 4: Run the full DOM suite**

Run: `yarn test:dom`
Expected: PASS — this also re-runs `pane-group.test.tsx` (Task 4) and
`subagent-transcript.test.tsx` (Task 5), confirming nothing in this task's changes to shared
components (`SubagentTranscript`, `subagent-window.ts`) regressed them.

- [ ] **Step 5: Commit**

```bash
git add src/test/dom/fleet-harness.tsx src/test/dom/fleet-app.test.tsx
git commit -m "test: cover fleet view's picker, subagent list, and drill-in"
```

---

### Task 12: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `yarn lint`
Expected: PASS. Fix any reported issue (unused imports are the likely one — e.g. if
`src/webview/components/pane-group.tsx` no longer uses `useState` for anything else, or if
`SubagentDrillInContext`'s import in `pane-group.tsx` needs re-checking) and re-run.

- [ ] **Step 2: Type-check**

Run: `yarn check-types`
Expected: PASS.

- [ ] **Step 3: Full unit suite**

Run: `yarn test:unit`
Expected: PASS — every test from Tasks 1, 2, 3, 6 plus the untouched existing suite.

- [ ] **Step 4: Full DOM suite**

Run: `yarn test:dom`
Expected: PASS — every test from Tasks 4, 5, 11 plus the untouched existing suite.

- [ ] **Step 5: Compile**

Run: `yarn run compile`
Expected: PASS (this also re-runs `check-types` and `lint`, per its script definition — a
final confirmation that `esbuild.js`'s four bundles, including `dist/fleet.js`, still build
cleanly now that `src/fleet/main.tsx` imports across into `src/webview/`).

- [ ] **Step 6: Manual verification (the one path this plan cannot automate)**

Per Task 7's note, `FleetPanel`/`PanelViewProvider`'s message interception has no automated
coverage, matching this codebase's existing precedent for `open-review`/`open-fleet`/
`focus-session`. Launch the extension (F5, or the `run` skill) and confirm by hand:
1. Start a session that spawns a subagent (or use a scripted `FakeProvider` fixture that does).
2. In the sidebar, expand the subagent card and click "Open full transcript".
3. The Fleet tab opens (or reveals), lands directly on that subagent's transcript — not the
   picker, not the list.
4. If the subagent is blocked on a permission, approve it from inside the Fleet tab and confirm
   the sidebar's own copy of that same session reflects the answer (proving both panels really
   do share one `SessionManager`).

- [ ] **Step 7: Final commit**

If Steps 1–5 needed any fixes beyond what earlier tasks already committed, commit them now:

```bash
git add -A
git commit -m "chore: fix lint/type/test fallout from fleet view rework"
```

If nothing needed fixing, this task produces no commit — say so rather than committing an
empty change.
