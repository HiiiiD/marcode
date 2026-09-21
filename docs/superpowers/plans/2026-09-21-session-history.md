# Session History and Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A history editor tab that shows every session's dates, archived state, provider+model and a digest, sortable by created/updated, plus a persisted pin flag surfaced in the sidebar picker.

**Architecture:** `pinned` and a cached `summary` ride `SessionState` (so `index.json` persists them and `sessions-changed` carries them to every client). A pure `digestSession()` builds the summary from the JSONL; `SessionManager.ensureSummaries()` fills stale ones on request. The tab is a third webview surface mirroring `ReviewPanel`/`FleetPanel` (own bundle, own narrow reducer, own `MessageRouter`, allow-list on `PostBus`). Sorting/grouping/filtering is one pure function.

**Tech Stack:** TypeScript, React 19, Tailwind v4, shadcn (Base UI) primitives in `src/webview/components/ui/`, mocha (`yarn test:unit`, `yarn test:dom`), esbuild.

**Spec:** `docs/superpowers/specs/2026-09-21-session-history-design.md` (amended in Task 0 — see "Deviations")

## Deviations from the spec (decided while planning)

- No `request-history`/`history` messages. `SessionState` already carries every column, so the tab reads `hydrate.sessions` + `sessions-changed` like the review tab does. Only `request-history-summaries` is new.
- The extractive summary is a **new** `digestSession()` (goal → last reply · files edited), not `ExtractiveSummarizer`, which yields first message + count — the thing this feature is meant to improve on. `ExtractiveSummarizer` and memory indexing are untouched.
- "Open in panes" reuses the existing `focus-session` message; its host logic is extracted from `FleetPanel` into a shared `focusSession()` helper.
- Sidebar **Pinned** group lists *all* pinned sessions (open or not) and removes them from the Live/Archived groups, so no row appears twice.

## Global Constraints

- `src/protocol/messages.ts` is types-only; nothing under `src/providers/`, `src/protocol/`, `src/host/message-router.ts` imports `vscode`.
- Every session-addressed message carries an explicit `SessionId` (`id`).
- Errors are state, never exceptions; no unhandled rejections.
- Filenames kebab-case. shadcn components only (no raw `<button>/<select>/<input>/<textarea>`); compose classes with `cn` from `@/lib/utils`.
- Never pass a DOM node to an assertion (compare booleans/strings/counts). DOM tests drive the real `StoreProvider` via `sendFromHost`; never mock `useStore`.
- Files over ~300 lines get split. Comments only for non-obvious "why".
- Run tests with `yarn test:unit` / `yarn test:dom` (RAM-guarded), never the `:raw` variants.
- Pinning and summary writes must **not** bump `updatedAt` (it is the sort key and the summary's cache key).
- `yarn lint`, `yarn check-types`, `yarn run compile` pass before every commit that touches code. Conventional-commit prefixes. **No Claude/Anthropic trailer in commit messages.**
- Pin every shell command with its own `cd /e/Efebia/hiiiid-code` and assert branch `feat/session-history` before committing.

## File Structure

| File | Responsibility |
|---|---|
| `src/protocol/messages.ts` (modify) | `pinned?`, `summary?` on `SessionState`; `set-pinned`, `request-history-summaries`, `open-history` |
| `src/memory/session-digest.ts` (create) | Pure `digestSession(items): string` |
| `src/host/session-manager.ts` (modify) | `setPinned`, `ensureSummaries` |
| `src/host/message-router.ts` (modify) | Route the three new tags |
| `src/host/post-bus.ts` (modify) | `HISTORY_WANTS` |
| `src/host/focus-session.ts` (create) | Shared "reveal this session in the sidebar" helper |
| `src/host/fleet-panel.ts` (modify) | Use `focusSession` |
| `src/host/history-panel.ts` (create) | The history tab host |
| `src/host/panel-view-provider.ts` (modify) | Intercept `open-history` |
| `src/extension.ts`, `package.json`, `esbuild.js` (modify) | Command, serializer, bundle |
| `src/history/history-rows.ts` (create) | Pure filter/sort/group |
| `src/history/format-when.ts` (create) | Date formatting |
| `src/history/reducer.ts`, `store.tsx`, `main.tsx`, `index.css` (create) | Client plumbing |
| `src/history/history-app.tsx`, `history-toolbar.tsx`, `history-table.tsx`, `history-row.tsx` (create) | Surface |
| `src/webview/components/session-row.tsx`, `session-picker.tsx` (modify) | Pin action, Pinned group, History item |
| `CLAUDE.md` (modify) | Architecture table + invariant |

---

### Task 0: Land the plan, amend the spec

**Files:** Modify `docs/superpowers/specs/2026-09-21-session-history-design.md`

- [ ] **Step 1:** Replace the spec's "Protocol" section with: `set-pinned {id, pinned}`, `request-history-summaries`, `open-history` (webview → host); no history reply — the tab reads `hydrate.sessions`/`sessions-changed`. Replace the summary bullet with the digest description (goal → last reply · N files edited) and the "Sidebar" pinned bullet with "Pinned group lists all pinned sessions and excludes them from Live/Archived".
- [ ] **Step 2:** Commit spec + this plan on **master**, then bring the branch up to date:

```bash
cd /e/Efebia/hiiiid-code && git checkout master && git add docs/superpowers && git commit -m "docs: session history plan, amend spec" && git checkout feat/session-history && git merge --ff-only master && git branch --show-current
```

Expected: `feat/session-history`.

---

### Task 1: Protocol fields, `setPinned`, router arms

**Files:**
- Modify: `src/protocol/messages.ts` (`SessionState` ~line 251; `WebviewToHost` near `focus-session` ~line 470)
- Modify: `src/host/session-manager.ts` (next to `rename`, ~line 565)
- Modify: `src/host/message-router.ts` (`route` switch near `rename-session`; `KNOWN_MESSAGE_TAGS` ~line 721)
- Test: `src/test/unit/session-manager-pin.test.ts` (create), `src/test/unit/history-router.test.ts` (create)

**Interfaces:**
- Produces: `SessionState.pinned?: boolean`; `SessionState.summary?: { text: string; forUpdatedAt: number }`; `WebviewToHost` arms `{ t: 'set-pinned'; id: SessionId; pinned: boolean }`, `{ t: 'request-history-summaries' }`, `{ t: 'open-history' }`; `SessionManager.setPinned(id: SessionId, pinned: boolean): void`; `SessionManager.ensureSummaries(): Promise<void>` (declared in Task 3, called by router here — add a temporary stub is NOT allowed: implement router arm for it in Task 3).

- [ ] **Step 1: Failing manager test.** Create `src/test/unit/session-manager-pin.test.ts`:

```ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { HostToWebview } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-pin-'));
  const store = new TranscriptStore(dir);
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(store, providers, (m) => sent.push(m));
  await manager.init();
  return { dir, store, sent, providers, manager };
}

suite('SessionManager pinning', () => {
  test('setPinned flips the flag, emits sessions-changed, and leaves updatedAt alone', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    const before = manager.summaries().find((s) => s.id === id)!.updatedAt;
    sent.length = 0;
    manager.setPinned(id, true);
    const after = manager.summaries().find((s) => s.id === id)!;
    assert.strictEqual(after.pinned, true);
    assert.strictEqual(after.updatedAt, before);
    assert.strictEqual(sent.some((m) => m.t === 'sessions-changed'), true);
    await manager.dispose();
  });

  test('a pin survives close and a restart', async () => {
    const { store, providers, manager } = await rig();
    const session = await manager.create('fake', '/repo');
    const id = session.state.id;
    manager.setPinned(id, true);
    await manager.close(id);
    await manager.dispose();
    const again = new SessionManager(store, providers, () => {});
    await again.init();
    const restored = again.summaries().find((s) => s.id === id)!;
    assert.strictEqual(restored.pinned, true);
    assert.strictEqual(restored.archived, true);
    await again.dispose();
  });

  test('unknown id and no-op changes emit nothing', async () => {
    const { manager, sent } = await rig();
    sent.length = 0;
    manager.setPinned('nope', true);
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });
});
```

- [ ] **Step 2:** Run `cd /e/Efebia/hiiiid-code && yarn test:unit` — new suite fails (`setPinned` missing / type error).
- [ ] **Step 3: Types.** In `SessionState`, above `archived: boolean;` add:

```ts
  /** Survives close/archive; absent means false so older index.json files load unchanged. */
  pinned?: boolean;
  /** Cache of `digestSession()`, stale once `forUpdatedAt !== updatedAt`. Never a source of truth. */
  summary?: { text: string; forUpdatedAt: number };
```

In `WebviewToHost`, beside `focus-session`, add (with a one-line "why" comment on `open-history`: intercepted by `PanelViewProvider`, needs `vscode`):

```ts
  | { t: 'set-pinned'; id: SessionId; pinned: boolean }
  | { t: 'request-history-summaries' }
  | { t: 'open-history' }
```

- [ ] **Step 4: Manager.** After `rename()`:

```ts
  /** Pinning is bookkeeping, not activity: it must not move `updatedAt`, which is the history sort key. */
  setPinned(id: SessionId, pinned: boolean): void {
    const state = this.meta.get(id);
    if (!state || (state.pinned ?? false) === pinned) { return; }
    state.pinned = pinned;
    this.changed();
  }
```

- [ ] **Step 5: Router.** In `route()` add `case 'set-pinned': this.manager.setPinned(msg.id, msg.pinned); return;`. Add `case 'open-history': return;` with the same "PanelViewProvider intercepts" comment style as `open-review`. Add `'set-pinned', 'request-history-summaries', 'open-history'` to `KNOWN_MESSAGE_TAGS`. (`request-history-summaries` gets its `case` in Task 3; until then TypeScript's exhaustive switch, if any, will complain — add `case 'request-history-summaries': return;` now and replace it in Task 3.)
- [ ] **Step 6: Router test.** Create `src/test/unit/history-router.test.ts` following `fleet-diff-router.test.ts`'s `routerWith()` shape with a manager stub `{ setPinned: (id, p) => calls.push(\`setPinned:${id}:${p}\`) }`; assert `set-pinned` reaches it and `open-history` is a silent no-op (no calls).
- [ ] **Step 7:** `yarn test:unit` passes; `yarn check-types` passes.
- [ ] **Step 8: Commit** (`git add` the six files) — `feat: pinned flag on sessions`.

---

### Task 2: `digestSession`

**Files:**
- Create: `src/memory/session-digest.ts`
- Test: `src/test/unit/session-digest.test.ts`

**Interfaces:**
- Produces: `digestSession(items: TranscriptItem[]): string` — `''` when there is no user text.

- [ ] **Step 1: Failing test:**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { digestSession } from '../../memory/session-digest';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'user', text });
const reply = (id: string, text: string): TranscriptItem => ({ id, ts: 2, role: 'assistant', text });
const edit = (id: string, ...paths: string[]): TranscriptItem => ({
  id, ts: 3, role: 'tool', toolId: id, state: 'ok',
  tool: { kind: 'file-edit', label: 'Edit', files: paths.map((path) => ({ path, op: 'modify' as const })) },
});

suite('digestSession', () => {
  test('goal, last reply and distinct files edited', () => {
    const out = digestSession([
      user('1', 'Fix the flaky   login test'),
      reply('2', 'Looking into it'),
      edit('3', '/r/a.ts', '/r/b.ts'),
      edit('4', '/r/a.ts'),
      reply('5', 'Fixed by awaiting the redirect.'),
    ]);
    assert.strictEqual(out, 'Fix the flaky login test → Fixed by awaiting the redirect. · 2 files edited');
  });

  test('no reply and no edits is just the goal', () => {
    assert.strictEqual(digestSession([user('1', 'Hello')]), 'Hello');
  });

  test('one file uses the singular', () => {
    assert.strictEqual(digestSession([user('1', 'x'), edit('2', '/r/a.ts')]), 'x · 1 file edited');
  });

  test('long goal and reply are truncated', () => {
    const out = digestSession([user('1', 'g'.repeat(500)), reply('2', 'r'.repeat(500))]);
    assert.strictEqual(out.includes('…'), true);
    assert.strictEqual(out.length < 400, true);
  });

  test('empty transcript digests to an empty string', () => {
    assert.strictEqual(digestSession([]), '');
  });
});
```

Adjust the `ItemBase` literal (`id`, `ts`) if `ItemBase` in `messages.ts` names them differently — read it first.

- [ ] **Step 2:** `yarn test:unit` — fails (module missing).
- [ ] **Step 3: Implement:**

```ts
import type { TranscriptItem } from '../protocol/messages';

const GOAL_MAX = 160;
const OUTCOME_MAX = 200;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Top-level items only: a subagent's children are its own work, summarised by its own spawn card. */
export function digestSession(items: TranscriptItem[]): string {
  let goal = '';
  let outcome = '';
  const edited = new Set<string>();
  for (const item of items) {
    if (item.role === 'user' && goal === '') { goal = squash(item.text); }
    if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { outcome = text; }
    }
    if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  if (goal === '') { return ''; }
  let out = clip(goal, GOAL_MAX);
  if (outcome !== '') { out += ` → ${clip(outcome, OUTCOME_MAX)}`; }
  if (edited.size > 0) { out += ` · ${edited.size} ${edited.size === 1 ? 'file' : 'files'} edited`; }
  return out;
}
```

- [ ] **Step 4:** `yarn test:unit` passes. **Step 5: Commit** — `feat: digest a session transcript into a one-line summary`.

---

### Task 3: `ensureSummaries` and the router arm

**Files:**
- Modify: `src/host/session-manager.ts` (import `digestSession` from `../memory/session-digest`; add near `indexForMemory`, ~line 1785)
- Modify: `src/host/message-router.ts` (replace the placeholder `request-history-summaries` case)
- Test: `src/test/unit/session-manager-summaries.test.ts` (create); extend `history-router.test.ts`

**Interfaces:**
- Consumes: `digestSession` (Task 2), `SessionState.summary` (Task 1).
- Produces: `SessionManager.ensureSummaries(): Promise<void>` — concurrent calls share one run; sessions titled `'Untitled'` are skipped; writes never touch `updatedAt`; emits one `sessions-changed` per run, only if something changed.

- [ ] **Step 1: Failing tests** (reuse the `rig()` shape from Task 1; put it in the new file, do not import across test files):

```ts
suite('SessionManager summaries', () => {
  test('fills a stale summary from the transcript and keys it to updatedAt', async () => {
    const { manager } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    const s = manager.summaries().find((x) => x.id === session.state.id)!;
    assert.strictEqual(s.summary?.text.startsWith('Investigate the flaky login test'), true);
    assert.strictEqual(s.summary?.forUpdatedAt, s.updatedAt);
    await manager.dispose();
  });

  test('a fresh summary is not recomputed and emits nothing', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    sent.length = 0;
    await manager.ensureSummaries();
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });

  test('untitled sessions are skipped', async () => {
    const { manager } = await rig();
    const session = await manager.create('fake', '/repo');
    await manager.ensureSummaries();
    assert.strictEqual(manager.summaries().find((x) => x.id === session.state.id)!.summary, undefined);
    await manager.dispose();
  });

  test('concurrent calls share one run', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello');
    await manager.close(session.state.id);
    sent.length = 0;
    await Promise.all([manager.ensureSummaries(), manager.ensureSummaries()]);
    assert.strictEqual(sent.filter((m) => m.t === 'sessions-changed').length, 1);
    await manager.dispose();
  });
});
```

- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3: Implement:**

```ts
  private summaryRun: Promise<void> | undefined;

  ensureSummaries(): Promise<void> {
    this.summaryRun ??= this.runSummaries().finally(() => { this.summaryRun = undefined; });
    return this.summaryRun;
  }

  private async runSummaries(): Promise<void> {
    const stale = [...this.meta.values()].filter(
      (s) => s.title !== 'Untitled' && s.summary?.forUpdatedAt !== s.updatedAt,
    );
    let touched = false;
    for (const state of stale) {
      if (this.disposed) { return; }
      const forUpdatedAt = state.updatedAt;
      try {
        const { items } = await this.store.tail(state.id, Number.MAX_SAFE_INTEGER);
        state.summary = { text: digestSession(items), forUpdatedAt };
        touched = true;
      } catch (err) {
        console.error('[mar-code] summary failed for', state.id, err);
      }
    }
    if (touched && !this.disposed) { this.changed(); }
  }
```

If `this.disposed` is not the actual field name, use the one `requestFleetDiff` checks.

- [ ] **Step 4: Router:** `case 'request-history-summaries': await this.manager.ensureSummaries(); return;`. Extend `history-router.test.ts`: manager stub gets `ensureSummaries`, assert it is called.
- [ ] **Step 5:** `yarn test:unit`, `yarn check-types` pass. **Step 6: Commit** — `feat: on-demand session summaries`.

---

### Task 4: Pure history query (filter, group, sort)

**Files:**
- Create: `src/history/history-rows.ts`
- Test: `src/test/unit/history-rows.test.ts`

**Interfaces:**
- Produces:

```ts
export type SortKey = 'updatedAt' | 'createdAt';
export type SortDir = 'asc' | 'desc';
export type StatusFilter = 'all' | 'active' | 'archived';
export interface HistoryQuery { sort: SortKey; dir: SortDir; status: StatusFilter; text: string }
export interface HistoryGroups { pinned: SessionSummary[]; rest: SessionSummary[] }
export const DEFAULT_QUERY: HistoryQuery; // { sort: 'updatedAt', dir: 'desc', status: 'all', text: '' }
export function queryHistory(sessions: SessionSummary[], q: HistoryQuery): HistoryGroups;
```

- [ ] **Step 1: Failing tests.** Build sessions with a local `mk(id, over)` helper producing a full `SessionSummary` (copy the required fields from an existing fixture — grep `src/test/fixtures/protocol.ts` for a session builder and import it instead if one exists). Cases: default query sorts by `updatedAt` desc; `dir: 'asc'` reverses; `sort: 'createdAt'` uses created; pinned partition first and sorted within itself; `status: 'archived'` and `'active'` filter on `archived`; `text` matches case-insensitively over `title`, `name`, `model`, `providerId`, `summary.text`; ties break by `id` ascending (stable); input array not mutated.
- [ ] **Step 2:** run, FAIL.
- [ ] **Step 3: Implement:**

```ts
import type { SessionSummary } from '../protocol/messages';

export type SortKey = 'updatedAt' | 'createdAt';
export type SortDir = 'asc' | 'desc';
export type StatusFilter = 'all' | 'active' | 'archived';
export interface HistoryQuery { sort: SortKey; dir: SortDir; status: StatusFilter; text: string }
export interface HistoryGroups { pinned: SessionSummary[]; rest: SessionSummary[] }

export const DEFAULT_QUERY: HistoryQuery = { sort: 'updatedAt', dir: 'desc', status: 'all', text: '' };

const matches = (s: SessionSummary, needle: string): boolean =>
  [s.title, s.name, s.model, s.providerId, s.summary?.text ?? '']
    .some((field) => field.toLowerCase().includes(needle));

export function queryHistory(sessions: SessionSummary[], q: HistoryQuery): HistoryGroups {
  const needle = q.text.trim().toLowerCase();
  const kept = sessions.filter((s) =>
    (q.status === 'all' || (q.status === 'archived') === s.archived)
    && (needle === '' || matches(s, needle)));
  const sign = q.dir === 'asc' ? 1 : -1;
  const order = (a: SessionSummary, b: SessionSummary): number =>
    sign * (a[q.sort] - b[q.sort]) || a.id.localeCompare(b.id);
  return {
    pinned: kept.filter((s) => s.pinned === true).sort(order),
    rest: kept.filter((s) => s.pinned !== true).sort(order),
  };
}
```

- [ ] **Step 4:** pass. **Step 5: Commit** — `feat: pure history query`.

---

### Task 5: Host side — `HISTORY_WANTS`, `focusSession`, `HistoryPanel`, wiring, bundle

**Files:**
- Modify: `src/host/post-bus.ts`; `src/host/fleet-panel.ts`; `src/host/panel-view-provider.ts`; `src/extension.ts`; `package.json`; `esbuild.js`
- Create: `src/host/focus-session.ts`, `src/host/history-panel.ts`, `src/history/main.tsx` (stub is not allowed — create with Task 6; for this task keep `esbuild.js` change and `main.tsx` together in Task 6 so the build never references a missing file)
- Test: `src/test/unit/post-bus.test.ts` (extend)

**Interfaces:**
- Produces: `HISTORY_WANTS(msg): boolean` (only `sessions-changed`); `focusSession(manager: SessionManager, id: SessionId): Promise<void>`; `HistoryPanel` with `open()`, `restore(panel)`, `dispose()`; `HISTORY_VIEW_TYPE = 'mar-code.history'`.

- [ ] **Step 1: Test** in `post-bus.test.ts`: a client registered with `HISTORY_WANTS` receives `sessions-changed` and does not receive `session-patch`, `session-status`, `fleet-diff`. Run — FAIL.
- [ ] **Step 2:** Add to `post-bus.ts`, with the same allow-list rationale in one sentence:

```ts
export const HISTORY_WANTS = (msg: HostToWebview): boolean => msg.t === 'sessions-changed';
```

- [ ] **Step 3: `focus-session.ts`** — lift the body of `FleetPanel`'s `focus-session` branch (lines ~130-141) verbatim:

```ts
import * as vscode from 'vscode';
import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
import { appendAtTop } from '../webview/components/pane-layout';
import { leafSessionIds } from '../webview/components/layout-tree';

export async function focusSession(manager: SessionManager, id: SessionId): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (!ids.includes(id)) {
    await manager.setVisible([...ids, id]);
    manager.setLayout({ ...manager.layout(), root: appendAtTop(manager.layout().root, id) });
  }
  await vscode.commands.executeCommand('workbench.view.extension.mar-code');
}
```

Change `FleetPanel` to `await focusSession(this.manager, raw.id); return;` and drop its now-unused imports (lint will say which).

- [ ] **Step 4: `history-panel.ts`.** Copy `review-panel.ts`'s structure with: `HISTORY_VIEW_TYPE = 'mar-code.history'`; title `'Session history'`; `dist/history.js`/`history.css`; bus registration `wants: HISTORY_WANTS`; no `review-visibility` messages and no `onDidChangeViewState`; message handler intercepts `focus-session` → `focusSession(this.manager, raw.id)` before `router.handle(raw)`; `MessageRouter` constructed as `new MessageRouter(this.manager, post, this.defaultCwd, this.editor)`. Keep `open`/`restore`/`dispose` and the identity-guarded dispose handler exactly as `ReviewPanel` has them; do not copy its long comments — one line each where the reason is non-obvious.
- [ ] **Step 5: `panel-view-provider.ts`:** append constructor param `private readonly onOpenHistory: () => void = () => {}` as the **last** parameter (positional — do not insert mid-list). Add beside the `open-review` intercept: `if (raw?.t === 'open-history') { this.onOpenHistory(); return; }`.
- [ ] **Step 6: `extension.ts`:** `import { HistoryPanel, HISTORY_VIEW_TYPE } from './host/history-panel';`; after `fleet` construct `const history = new HistoryPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);`; pass `() => { history.open(); }` as the new last argument to `new PanelViewProvider(...)` (after `showCacheTimer()`); in `context.subscriptions` add `vscode.commands.registerCommand('marcode.history.open', () => { history.open(); })`, a `registerWebviewPanelSerializer(HISTORY_VIEW_TYPE, { deserializeWebviewPanel: async (panel) => { history.restore(panel); } })`, and `{ dispose: () => { history.dispose(); } }`.
- [ ] **Step 7: `package.json`:** add to `contributes.commands`: `{ "command": "marcode.history.open", "title": "Marcode: Open session history" }`; if the file lists `activationEvents` per command or a `webviewPanel` serializer event, mirror what `marcode.fleet.open` has.
- [ ] **Step 8:** `yarn check-types` and `yarn lint` (the build itself waits for Task 6). `yarn test:unit` passes. **Step 9: Commit** — `feat: history tab host, shared focusSession`.

---

### Task 6: History client — reducer, store, bundle, surface

**Files:**
- Create: `src/history/reducer.ts`, `store.tsx`, `main.tsx`, `index.css`, `format-when.ts`, `history-app.tsx`, `history-toolbar.tsx`, `history-table.tsx`, `history-row.tsx`
- Modify: `esbuild.js`
- Test: `src/test/dom/history-harness.tsx`, `src/test/dom/history-app.test.tsx`, `src/test/unit/format-when.test.ts`

**Interfaces:**
- Consumes: `queryHistory`, `DEFAULT_QUERY`, `HistoryQuery`, `SortKey`, `SortDir`, `StatusFilter` (Task 4); `HISTORY_WANTS` (Task 5).
- Produces: `HistoryState { ready: boolean; sessions: SessionSummary[] }`, `reduceHistory`, `initialHistoryState`; `formatWhen(ts: number): string`.

- [ ] **Step 1: `reducer.ts`** (mirror `src/review/reducer.ts`, far narrower):

```ts
import type { HostToWebview, SessionSummary } from '../protocol/messages';

export interface HistoryState { ready: boolean; sessions: SessionSummary[] }
export const initialHistoryState: HistoryState = { ready: false, sessions: [] };

export function reduceHistory(state: HistoryState, msg: HostToWebview): HistoryState {
  switch (msg.t) {
    case 'hydrate': return { ready: true, sessions: msg.sessions };
    case 'sessions-changed': return { ...state, sessions: msg.sessions };
    default: return state;
  }
}
```

- [ ] **Step 2: `store.tsx`** — copy `src/review/store.tsx`, swap the reducer, and in the mount effect post `{ t: 'ready' }` then `{ t: 'request-history-summaries' }`. Keep `post` stable via `useCallback`.
- [ ] **Step 3: `main.tsx`** — as `src/review/main.tsx` with `HistoryApp`. **`index.css`:** `@import '../webview/index.css';`. **`esbuild.js`:** add `historyCtx` cloned from `fleetCtx` (`src/history/main.tsx` → `dist/history.js`, `tailwindPlugin('src/history/index.css', 'dist/history.css')`) and add it to the three `Promise.all` lists.
- [ ] **Step 4: `format-when.ts` + test.** `formatWhen(ts)` = `new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ts)`. Unit test only that it returns a non-empty string containing the year of a fixed timestamp (locale-agnostic).
- [ ] **Step 5: Failing DOM tests.** `history-harness.tsx` mirrors `review-harness.tsx` (`renderHistory()` renders `<StoreProvider><HistoryApp /></StoreProvider>`, re-exports `posted`, `resetHost`, `sendFromHost`). In `history-app.test.tsx`, build the `hydrate` message with whichever builder `review-app.test.tsx` uses, and cover:
  1. mount posts `ready` then `request-history-summaries`;
  2. a pinned session's row renders in a "Pinned" group before an unpinned newer one;
  3. each row shows its name/title, provider·model, created and updated text (`formatWhen`), an "Archived" badge only for archived, and the summary text (falling back to `title` when `summary` is absent);
  4. clicking the "Created" sort control reorders rows; clicking the direction control reverses them (assert on the ordered list of row names — strings);
  5. status tabs (All/Active/Archived) filter; typing in the search input filters by summary text;
  6. clicking a row's pin button posts `{ t: 'set-pinned', id, pinned: true }` (and `false` on a pinned row);
  7. clicking "Open" posts `{ t: 'focus-session', id }`;
  8. a later `sessions-changed` message updates the rendered rows;
  9. empty result shows an empty-state line (with filter text: "No sessions match"; with none at all: "No sessions yet").
  Compare strings/booleans/counts only.
- [ ] **Step 6:** `yarn test:dom` — FAIL (components missing).
- [ ] **Step 7: Components** (each file under ~150 lines):
  - `history-app.tsx`: `useStore()`; `useState<HistoryQuery>(DEFAULT_QUERY)`; `const groups = queryHistory(state.sessions, query)`; renders `<HistoryToolbar query onChange />` and `<HistoryTable groups />`. Query state is ephemeral by design.
  - `history-toolbar.tsx`: shadcn `Input` (search, `aria-label="Filter sessions"`), `Tabs` for status (All/Active/Archived), `Select` for sort key ("Last updated"/"Created"), and an icon `Button` with `aria-label` "Sort ascending"/"Sort descending" toggling `dir` (`ArrowUpIcon`/`ArrowDownIcon` from lucide-react). Use `cn` for any conditional classes.
  - `history-table.tsx`: shadcn `Table`; header columns Session, Model, Created, Updated, Summary, (actions). Renders a full-width group label row "Pinned" when `pinned.length > 0` then pinned rows, then the rest (label "Sessions" only when pinned exists). Empty states per test 9.
  - `history-row.tsx`: props `{ session: SessionSummary }`; `useStore().post`. Name cell = `title` (fallback `name`) with an `Archived` `Badge` when archived; model cell = `${providerId} · ${model}`; dates via `formatWhen`; summary cell = `summary?.text || title`, clamped to two lines (`line-clamp-2`) with a `title=` attribute holding the full text; actions = pin toggle `Button variant="ghost" size="icon-sm"` (`PinIcon`/`PinOffIcon`, `aria-pressed`, `aria-label` `Pin ${name}`/`Unpin ${name}`) and an "Open" `Button variant="outline" size="sm"` posting `focus-session`.
- [ ] **Step 8:** `yarn test:dom` passes; `node esbuild.js` produces `dist/history.js` and `dist/history.css`; `yarn lint`, `yarn check-types` pass.
- [ ] **Step 9: impeccable gate.** Invoke the `impeccable` skill for the new surface (Operate mode: scanability, native VS Code feel), apply its findings, then run its detector: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/history/*.tsx` — exit 0 required. (Detector targets `src/webview/components/`; run it on `src/history/` too and record any finding it cannot judge in the commit body.)
- [ ] **Step 10: Commit** — `feat: session history tab`.

---

### Task 7: Sidebar — pin action, Pinned group, History entry

**Files:**
- Modify: `src/webview/components/session-row.tsx`, `src/webview/components/session-picker.tsx`
- Test: `src/test/dom/session-picker.test.tsx` (extend — read it first and follow its harness usage)

**Interfaces:**
- Consumes: `SessionState.pinned`, `set-pinned`, `open-history` (Task 1).

- [ ] **Step 1: Failing DOM tests** in `session-picker.test.tsx`: (a) open the picker menu with one pinned and one unpinned session — a "Pinned (1)" label exists and the pinned session's row appears under it, exactly once in the whole menu; (b) a pinned archived session appears under Pinned and not under "Archived (…)"; (c) the row's More-actions submenu offers "Pin <title>" for an unpinned session and "Unpin <title>" for a pinned one, posting `{ t: 'set-pinned', id, pinned }`; (d) a "History…" menu item posts `{ t: 'open-history' }`.
- [ ] **Step 2:** `yarn test:dom` — FAIL.
- [ ] **Step 3: `session-row.tsx`:** first item in the actions submenu: `<DropdownMenuItem onClick={() => post({ t: 'set-pinned', id: session.id, pinned: session.pinned !== true })}>{session.pinned ? 'Unpin' : 'Pin'} {session.title}</DropdownMenuItem>`. Before the title span, when pinned, render `<PinIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />`.
- [ ] **Step 4: `session-picker.tsx`:** replace the two filters with

```tsx
const pinned = state.sessions.filter((s) => s.pinned === true);
const live = state.sessions.filter((s) => !s.archived && s.pinned !== true);
const archived = state.sessions.filter((s) => s.archived && s.pinned !== true);
```

Render, before the live rows and using the same `DropdownMenuGroup` + `DropdownMenuLabel` wrapping the Archived block already uses (the label throws without a `Menu.Group` ancestor), a `Pinned (${pinned.length})` group of `SessionRow`s, followed by a `DropdownMenuSeparator`, only when `pinned.length > 0`. Add a `History…` `DropdownMenuItem` (posting `open-history`, with a `HistoryIcon`) next to the picker's other footer entries, following how the existing Review/Fleet entries are declared (they are `onReview`/`onFleet` props today — this one posts directly).
- [ ] **Step 5:** `yarn test:dom` passes (existing picker tests must still pass unchanged); lint, types pass.
- [ ] **Step 6: impeccable gate:** `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/session-row.tsx src/webview/components/session-picker.tsx` — exit 0.
- [ ] **Step 7: Commit** — `feat: pinned group and history entry in the picker`.

---

### Task 8: Docs and full verification

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1:** Add rows to the architecture table: `src/host/history-panel.ts` (the history editor tab: creation, restore, transport; `HISTORY_WANTS` allow-list is `sessions-changed` only), `src/host/focus-session.ts`, `src/memory/session-digest.ts` (pure summary), `src/history/` (the history client: own narrow reducer/store/surface), `src/history/history-rows.ts` (pure filter/sort/group). Update the diagram's bundle sentence to three webview bundles → four (`dist/history.js`/`.css`). Add one invariant: *Pin and summary are host state on `SessionState`; neither writes `updatedAt`, because `updatedAt` is the history sort key and the summary's cache key.*
- [ ] **Step 2: Full gate**, each with its own `cd`:

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile
cd /e/Efebia/hiiiid-code && yarn test:unit
cd /e/Efebia/hiiiid-code && yarn test:dom
```

All green.
- [ ] **Step 3: Manual F5 check** (record in the PR description): open the panel, create two sessions and send a message in each, pin one, close both; the picker shows the pinned one under Pinned; run "Marcode: Open session history"; confirm dates, provider · model, Archived badge, summary; flip sort key and direction; filter by text; Open a closed session; reload the window and confirm pins and the tab persist.
- [ ] **Step 4: Commit** — `docs: history tab in architecture notes`.
- [ ] **Step 5:** Per the repo's convention the critique gate needs the controller: dispatch the `critique` run over `src/webview` and `src/history` from the controller session (implementers cannot run it), compare with `.impeccable/critique/`, and only then hand to `superpowers:finishing-a-development-branch`.
