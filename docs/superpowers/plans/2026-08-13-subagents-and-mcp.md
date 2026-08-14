# Subagent and MCP Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Task` tool call renders as a live, collapsible card containing its subagent's tool activity, and every MCP tool call is attributed to its server alongside a per-session server-health strip.

**Architecture:** `AgentEvent` gains an optional `parentId` (a tool-use id) on `tool-start` / `tool-end` / `permission`, plus an `mcp-servers` snapshot variant. `AgentSession` buffers a subagent's child items on the parent tool item and writes them inline when the parent settles, so one JSONL line stays one settled top-level item. The webview renders at most the last 10 children of an expanded card, inline, with no scroll container of its own.

**Tech Stack:** TypeScript, esbuild (node/CJS host + browser/IIFE webview), React 19, Tailwind v4, vendored shadcn (Base UI), `@anthropic-ai/claude-agent-sdk` 0.3.228, mocha (unit) + `@vscode/test-cli` (integration).

**Spec:** [docs/superpowers/specs/2026-08-13-subagents-and-mcp-design.md](../specs/2026-08-13-subagents-and-mcp-design.md)

**Prerequisite:** v1 plus the webview UX overhaul (PR #3) are on `master`. This plan was re-verified against that tree on 2026-08-14: the host modules (`agent-session.ts`, `session-manager.ts`, `reducer.ts`, the Claude provider) are unchanged from what Tasks 1–7 assume, but the webview components were substantially rebuilt, so Tasks 8 and 9 were rewritten against what actually shipped.

**Design brief:** shaped through the `impeccable` skill (Operate mode, 300–500px sidebar). Three decisions from that pass bind this plan:

- **This extends the incumbent visual world; it does not replace it.** `TranscriptItemShell`, the shipped `ToolCard`, and `StatusBadge` are inherited idioms, not starting points.
- **MCP health lives in the roster, not the pane header.** The header already carries eight elements.
- **A subagent gets its own gutter identity** — the same shell, its own label and rule colour.

**Escalation is already solved and this plan adds nothing above the card.** `statusView` gives `awaiting-approval` the distinct `Needs you`/attention tone, `StatusBadge` announces it over `aria-live`, and `session-picker.tsx:48` renders a roster-level `N needs you`. A nested permission calls `setStatus('awaiting-approval')` exactly like a top-level one (Task 3), so all of that lights up for free. The only new burial risk is a collapsed card, which Task 8's force-open covers.

## Global Constraints

Everything in the v1 plan's Global Constraints still applies. Repeating the ones this plan trips over most:

- **Filenames are kebab-case** throughout, including `.tsx`. Component *identifiers* stay PascalCase.
- **`src/protocol/messages.ts` is types-only.** No runtime code, no `import ... from 'vscode'`.
- **No module under `src/providers/` or `src/protocol/` may import `vscode`.**
- **Use shadcn components, never raw HTML controls** — `Button`, `Select`, `DropdownMenu`, `Textarea` from `@/components/ui/*`.
- **Use short Tailwind utilities** — `border-border`, `bg-muted`, `text-muted-foreground`. No `[var(--…)]` in component code.
- **Errors are state, never exceptions across `postMessage`.**
- **Commit after every task.** Conventional-commit prefixes.
- **Transcript items are keyed by `role`, not `kind`.** The spec's `ToolItem` sketch writes `kind: 'tool'`; the shipped type in `src/protocol/messages.ts` uses `role: 'tool'`. Follow the code.
- **One level of nesting, enforced in `AgentSession`.** A child whose parent is itself a child resolves to the nearest depth-1 ancestor.
- **`forwardSubagentText` must never be set on the SDK `Options`.** Leaving it at its `false` default is the mechanism that keeps subagent prose out of the transcript.

---

## File Structure

| Path | Responsibility | Change |
|---|---|---|
| `src/providers/types.ts` | `AgentEvent.parentId`, `mcp-servers` variant, `McpServerStatus` | Modify |
| `src/protocol/messages.ts` | `children`/`mcpServer` on the tool item, `parentItemId` on patches, `session-mcp`, `SessionSnapshot.mcpServers` | Modify |
| `src/host/mcp-tool-name.ts` | Parse `mcp__<server>__<tool>` | Create |
| `src/host/agent-session.ts` | Child buffering, depth-1 resolution, abandoned-parent flush, MCP snapshot | Modify |
| `src/host/session-manager.ts` | `SessionSink.mcp` → `session-mcp`; `mcpServers` on archived snapshots | Modify |
| `src/providers/claude/map-events.ts` | `parent_tool_use_id` → `parentId`; drop subagent prose; init `mcp_servers` | Modify |
| `src/providers/claude/claude-provider.ts` | Export `buildOptions`; pull `mcpServerStatus()` | Modify |
| `src/webview/reducer.ts` | Nested `append`/`replace`; `session-mcp` | Modify |
| `src/webview/components/subagent-window.ts` | `SUBAGENT_CHILD_WINDOW`, `windowChildren`, `summarizeSubagent` | Create |
| `src/webview/components/subagent-card.tsx` | The nested card | Create |
| `src/webview/components/transcript-item-shell.tsx` | A `subagent` role in the gutter map | Modify |
| `src/webview/components/tool-card.tsx` | MCP badge — **badge only, no rewrite** | Modify |
| `src/webview/components/transcript-item.tsx` | Route tool items with children | Modify |
| `src/webview/components/mcp-status.ts` | Worst-state rollup and cross-pane aggregation | Create |
| `src/webview/components/session-picker.tsx` | MCP group in the roster dropdown | Modify |

Pure logic lives in `.ts` modules (`mcp-tool-name.ts`, `subagent-window.ts`, `mcp-status.ts`) rather than inside components, following the existing `tool-card-format.ts` / `pane-layout.ts` / `status.ts` pattern: the mocha unit harness requires those directly without pulling in Base UI or the DOM.

**`session-header.tsx` is deliberately not in this table.** It already renders a status badge, an `h2` title, the cwd, the bypass pill, a model `Select`, effort, tokens, an optional provider label, and a close button. Adding a ninth element to the narrowest row in the app is what pushed MCP health into the roster.

**Two components are extended, never rewritten.** `tool-card.tsx` gains exactly one element — the server badge. Its lucide state icon, `sr-only` state name, `aria-expanded`/`aria-controls` pair and `size="sm"` height discipline all shipped in PR #3 and must survive this plan intact. Same for `transcript-item-shell.tsx`, which gains one map entry and nothing else.

---

## Parallelization

```
T1 (types) ─┬─→ T2 (mcp name) ─→ T3 (nesting) ─→ T4 (mcp plumbing) ─┐
            │                                                        │
            ├─→ T5 (map-events) ─→ T6 (claude-provider) ─────────────┤
            │                                                        │
            └─→ T7 (reducer) ─┬─→ T8 (subagent card) ────────────────┤
                              └─→ T9 (mcp roster) ───────────────────┴─→ done
```

| Wave | Concurrent | Why they don't collide |
|---|---|---|
| 1 | **T1** alone | Everything imports these types |
| 2 | **T2**, **T5**, **T7** | `src/host/mcp-tool-name.ts` vs `src/providers/claude/` vs `src/webview/reducer.ts` |
| 3 | **T3**, **T6**, **T8**, **T9** | `src/host/agent-session.ts` vs `src/providers/claude/` vs the transcript components vs `session-picker.tsx` |
| 4 | **T4** alone | `src/host/session-manager.ts` |

T3 depends on T2 (it imports `parseToolName`). T8 and T9 both depend on T7 — T8 for the shape of a nested item, T9 for `PaneState.mcpServers` — but not on each other, which is what moving MCP health out of the pane header bought: T8 owns `subagent-card.tsx`, `tool-card.tsx`, `transcript-item*.tsx`; T9 owns `mcp-status.ts` and `session-picker.tsx`. No shared file.

**T4 can be moved earlier** if you would rather see the roster group with real data: T9 renders from `PaneState.mcpServers`, which stays empty until T4 emits `session-mcp`. Its DOM tests drive that message directly, so T9 is fully testable before T4 lands — it just has nothing to show in a live window.

---

## Task 1: Types for nesting and MCP status

The wire and seam contract. Types only, so a mismatch between the two bundles becomes a compile error rather than a runtime surprise.

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Produces: `McpServerStatus` from `src/providers/types.ts`, re-exported from `src/protocol/messages.ts`.
- Produces: `AgentEvent` variants `tool-start` / `tool-end` / `permission` each with optional `parentId?: string`, plus `{ kind: 'mcp-servers'; servers: McpServerStatus[] }`.
- Produces: `TranscriptItem` tool variant with `children?: TranscriptItem[]` and `mcpServer?: string`.
- Produces: `TranscriptPatch` `append` / `replace` each with optional `parentItemId?: string`.
- Produces: `HostToWebview` variant `{ t: 'session-mcp'; id: SessionId; servers: McpServerStatus[] }`.
- Produces: `SessionSnapshot.mcpServers: McpServerStatus[]`.

- [ ] **Step 1: Add `McpServerStatus` and extend `AgentEvent` in `src/providers/types.ts`**

Replace the `AgentEvent` type and add `McpServerStatus` above it:

```ts
/**
 * Status of one configured MCP server. Mirrors the SDK's own union
 * (sdk.d.ts:1083) including 'disabled' — a configured-but-off server is a
 * different thing from a broken one, and the user needs to tell them apart.
 */
export type McpServerStatus = {
  name: string;
  state: 'pending' | 'connected' | 'failed' | 'needs-auth' | 'disabled';
  toolCount?: number;
  error?: string;
};

export type AgentEvent =
  | { kind: 'session'; resumeToken: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown; parentId?: string }
  | { kind: 'permission'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'mcp-servers'; servers: McpServerStatus[] };
```

`parentId` is a **tool-use id** — the id of the `tool-start` that spawned the subagent. It is never a session id.

- [ ] **Step 2: Extend the protocol types in `src/protocol/messages.ts`**

Add `McpServerStatus` to the existing import and re-export:

```ts
import type {
  EffortLevel, McpServerStatus, ModelInfo, PermissionMode, ToolDecision,
} from '../providers/types';

export type { EffortLevel, McpServerStatus, ModelInfo, PermissionMode, ToolDecision };
```

Replace the tool variant of `TranscriptItem`:

```ts
  | (ItemBase & {
      role: 'tool'; toolId: string; name: string; input: unknown;
      state: 'running' | 'ok' | 'error'; output?: unknown;
      /**
       * A subagent's tool activity. Depth 1 only — a child never has
       * children of its own. Absent for the overwhelming majority of tool
       * calls, and absent on every item v1 wrote, which is why adding it
       * needs no migration.
       */
      children?: TranscriptItem[];
      /** Parsed from an `mcp__<server>__<tool>` name; `name` holds the bare tool. */
      mcpServer?: string;
    })
```

Replace `TranscriptPatch`:

```ts
export type TranscriptPatch =
  | { op: 'append'; item: TranscriptItem; parentItemId?: string }
  | { op: 'delta'; itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem; parentItemId?: string };
```

`delta` deliberately has no parent: subagent prose never reaches the transcript, so deltas are top-level by construction.

Add `mcpServers` to `SessionSnapshot`:

```ts
export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
  /**
   * Live provider state, not persisted. Always [] for an archived session —
   * there is no run to ask, and a stale snapshot presented as current would
   * be a lie. Deliberately NOT on SessionState, which is what index.json
   * stores.
   */
  mcpServers: McpServerStatus[];
}
```

Add the new outbound message to `HostToWebview`:

```ts
  | { t: 'session-mcp'; id: SessionId; servers: McpServerStatus[] }
```

- [ ] **Step 3: Extend the exhaustiveness test**

In `src/test/unit/protocol.test.ts`, add a case to `describeOutbound` before the `default`:

```ts
    case 'session-mcp': return 'session-mcp';
```

Add a test inside the `protocol` suite:

```ts
  test('session-mcp is an outbound variant carrying a server list', () => {
    assert.strictEqual(
      describeOutbound({
        t: 'session-mcp',
        id: 's1',
        servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
      }),
      'session-mcp',
    );
  });
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit`
Expected: PASS. The whole existing suite still passes — every new field is optional or additive, so no existing construction site breaks.

- [ ] **Step 5: Verify the types-only constraint still holds**

Run: `grep -n "vscode" src/protocol/messages.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/protocol/messages.ts src/test/unit/protocol.test.ts
git commit -m "feat: add subagent nesting and MCP status to the wire types"
```

---

## Task 2: MCP tool-name parsing

One pure function, host-side. Parsing once at item creation is what makes a tool card's server badge a permanent record: removing an MCP server later cannot rewrite what already happened, because nothing re-resolves the name at render time.

**Files:**
- Create: `src/host/mcp-tool-name.ts`
- Create: `src/test/unit/mcp-tool-name.test.ts`

**Interfaces:**
- Produces: `parseToolName(raw: string): { name: string; mcpServer?: string }` from `src/host/mcp-tool-name.ts`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/mcp-tool-name.test.ts`:

```ts
import * as assert from 'assert';
import { parseToolName } from '../../host/mcp-tool-name';

suite('parseToolName', () => {
  test('splits an mcp tool name into server and bare tool', () => {
    assert.deepStrictEqual(parseToolName('mcp__github__create_pr'), {
      name: 'create_pr', mcpServer: 'github',
    });
  });

  test('leaves an ordinary tool name untouched', () => {
    assert.deepStrictEqual(parseToolName('Bash'), { name: 'Bash' });
  });

  test('keeps separators inside the tool name', () => {
    assert.deepStrictEqual(parseToolName('mcp__github__list__repos'), {
      name: 'list__repos', mcpServer: 'github',
    });
  });

  test('leaves a malformed mcp name as-is rather than guessing', () => {
    assert.deepStrictEqual(parseToolName('mcp__weird'), { name: 'mcp__weird' });
    assert.deepStrictEqual(parseToolName('mcp__'), { name: 'mcp__' });
    assert.deepStrictEqual(parseToolName('mcp____tool'), { name: 'mcp____tool' });
    assert.deepStrictEqual(parseToolName('mcp__server__'), { name: 'mcp__server__' });
  });

  test('does not treat a name merely containing mcp__ as an mcp tool', () => {
    assert.deepStrictEqual(parseToolName('run_mcp__thing'), { name: 'run_mcp__thing' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../host/mcp-tool-name`.

- [ ] **Step 3: Write `src/host/mcp-tool-name.ts`**

```ts
const PREFIX = 'mcp__';
const SEP = '__';

export interface ParsedToolName {
  /** The bare tool name, with any `mcp__<server>__` prefix removed. */
  name: string;
  /** The MCP server, when the name carried one. */
  mcpServer?: string;
}

/**
 * Splits `mcp__<server>__<tool>`.
 *
 * The server is the first segment after the prefix; everything after the
 * next separator is the tool, separators included. Requiring exactly three
 * segments would mis-handle a legitimate `mcp__github__list__repos`, whose
 * tool name simply contains the separator.
 *
 * Anything that does not split cleanly is returned unchanged with no
 * `mcpServer`. A guess would put a wrong server badge on a transcript item
 * that is then persisted and never re-derived.
 */
export function parseToolName(raw: string): ParsedToolName {
  if (!raw.startsWith(PREFIX)) { return { name: raw }; }
  const rest = raw.slice(PREFIX.length);
  const at = rest.indexOf(SEP);
  if (at <= 0) { return { name: raw }; }
  const server = rest.slice(0, at);
  const tool = rest.slice(at + SEP.length);
  if (!tool) { return { name: raw }; }
  return { name: tool, mcpServer: server };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 5 new tests in the `parseToolName` suite.

- [ ] **Step 5: Commit**

```bash
git add src/host/mcp-tool-name.ts src/test/unit/mcp-tool-name.test.ts
git commit -m "feat: parse mcp tool names into server and bare tool"
```

---

## Task 3: Nested subagent items in AgentSession

The core of the feature. Children buffer in memory on the parent, stream to the webview as they happen, and land on disk inline with the parent when it settles.

**Files:**
- Modify: `src/host/agent-session.ts`
- Create: `src/test/unit/agent-session-nesting.test.ts`

**Interfaces:**
- Consumes: `parseToolName` from `src/host/mcp-tool-name` (Task 2); `AgentEvent.parentId`, `TranscriptItem.children`, `TranscriptPatch.parentItemId` (Task 1).
- Produces: no new exports. `AgentSession`'s existing public surface is unchanged.

A new test file rather than additions to `agent-session.test.ts`: nesting is a self-contained behaviour with its own fixtures, and the existing file is already long.

- [ ] **Step 1: Write the failing test**

`src/test/unit/agent-session-nesting.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  SessionId, SessionState, SessionStatus, TranscriptItem, TranscriptPatch,
} from '../../protocol/messages';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  servers: unknown[] = [];
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

function toolItems(items: TranscriptItem[]) {
  return items.filter((i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool');
}

suite('AgentSession subagent nesting', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-nest-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a child tool nests under its parent instead of appearing top-level', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: { subagent_type: 'Explore' } },
      { kind: 'tool-start', id: 'c1', name: 'Read', input: { path: 'a.ts' }, parentId: 'task1' },
      { kind: 'tool-end', id: 'c1', ok: true, output: 'contents', parentId: 'task1' },
      { kind: 'tool-end', id: 'task1', ok: true, output: 'found it' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('explore');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1, 'only the parent is a top-level item');
    assert.strictEqual(tools[0].name, 'Task');
    assert.strictEqual(tools[0].state, 'ok');
    assert.strictEqual(tools[0].children?.length, 1);
    assert.strictEqual((tools[0].children![0] as { name: string }).name, 'Read');
    assert.strictEqual((tools[0].children![0] as { state: string }).state, 'ok');
    await session.dispose();
  });

  test('child patches carry parentItemId so the webview can nest them', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Grep', input: {}, parentId: 'task1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const appends = sink.patches
      .map((p) => p.patch)
      .filter((p): p is Extract<TranscriptPatch, { op: 'append' }> => p.op === 'append');
    const parent = appends.find((p) => p.item.role === 'tool' && p.item.name === 'Task');
    const child = appends.find((p) => p.item.role === 'tool' && p.item.name === 'Grep');
    assert.ok(parent && child);
    assert.strictEqual(parent!.parentItemId, undefined);
    assert.strictEqual(child!.parentItemId, parent!.item.id);
    await session.dispose();
  });

  test('nesting is capped at depth 1 — a grandchild flattens to the top parent', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Task', input: {}, parentId: 'task1' },
      { kind: 'tool-start', id: 'g1', name: 'Read', input: {}, parentId: 'c1' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].children?.length, 2, 'grandchild flattened alongside the child');
    const names = tools[0].children!.map((c) => (c as { name: string }).name);
    assert.deepStrictEqual(names, ['Task', 'Read']);
    for (const child of tools[0].children!) {
      assert.strictEqual((child as { children?: unknown }).children, undefined);
    }
    await session.dispose();
  });

  test('a child whose parent was never seen is promoted to top-level', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'c1', name: 'Read', input: {}, parentId: 'ghost' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'Read');
    assert.strictEqual(tools[0].children, undefined);
    await session.dispose();
  });

  test('an abandoned subagent is still written, with its children and an error state', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Read', input: {}, parentId: 'task1' },
      { kind: 'turn-end', reason: 'interrupted' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();
    await session.dispose();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    const tools = toolItems(items);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].state, 'error');
    assert.strictEqual(tools[0].children?.length, 1);
  });

  test('a permission raised inside a subagent nests under it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'task1', name: 'Task', input: {} },
      { kind: 'tool-start', id: 'c1', name: 'Bash', input: { command: 'ls' }, parentId: 'task1' },
      { kind: 'permission', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const appends = sink.patches
      .map((p) => p.patch)
      .filter((p): p is Extract<TranscriptPatch, { op: 'append' }> => p.op === 'append');
    const perm = appends.find((p) => p.item.role === 'permission');
    assert.ok(perm, 'a permission item was appended');
    assert.ok(perm!.parentItemId, 'it nests under the subagent that raised it');

    const snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 1, 'still a top-level pending approval');
    assert.strictEqual(session.state.status, 'awaiting-approval');
    await session.dispose();
  });

  test('an mcp tool name is split onto the item at creation', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'mcp__github__create_pr', input: {} },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools[0].name, 'create_pr');
    assert.strictEqual(tools[0].mcpServer, 'github');
    await session.dispose();
  });

  test('a plain tool call still produces no children field at all', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'Read', input: {} },
      { kind: 'tool-end', id: 't1', ok: true, output: 'x' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const tools = toolItems(snap.items);
    assert.strictEqual(tools[0].children, undefined);
    assert.strictEqual(tools[0].mcpServer, undefined);
    await session.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — the first nesting test reports 2 top-level tool items instead of 1, because `parentId` is currently ignored.

- [ ] **Step 3: Add child tracking state to `AgentSession`**

In `src/host/agent-session.ts`, add the import:

```ts
import { parseToolName } from './mcp-tool-name';
```

Add these fields alongside the existing `toolItems` / `permissionItems` maps:

```ts
  /** Provider tool id -> the buffered children of that (parent) tool call. */
  private childrenByParent = new Map<string, TranscriptItem[]>();
  /** Provider tool id of a child -> the provider tool id of its parent. */
  private childOf = new Map<string, string>();
```

Add the depth-1 resolver as a private method:

```ts
  /**
   * Resolves a reported parent to the top-level tool call it belongs under.
   *
   * Claude subagents cannot spawn subagents, so a reported grandchild means
   * a provider we did not anticipate. Walking up to the nearest depth-1
   * ancestor flattens it rather than growing the data model into a tree.
   * The iteration cap keeps a malformed cycle from hanging the pump.
   */
  private resolveParent(parentId: string): string {
    let current = parentId;
    for (let hops = 0; hops < 8; hops++) {
      const next = this.childOf.get(current);
      if (next === undefined) { return current; }
      current = next;
    }
    return current;
  }

  /** The transcript item id of a resolved parent, if we ever saw its tool-start. */
  private parentItemIdFor(parentId: string): string | undefined {
    const root = this.resolveParent(parentId);
    const item = this.toolItems.get(root);
    return item && item.role === 'tool' ? item.id : undefined;
  }
```

- [ ] **Step 4: Route child items in `handle()`**

Replace the `tool-start`, `tool-end`, and `permission` cases in `handle()`:

```ts
      case 'tool-start': {
        const parsed = parseToolName(event.name);
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, name: parsed.name, input: event.input, state: 'running',
          ...(parsed.mcpServer ? { mcpServer: parsed.mcpServer } : {}),
        };
        this.toolItems.set(event.id, item);

        const parentItemId = event.parentId
          ? this.parentItemIdFor(event.parentId)
          : undefined;
        if (event.parentId && parentItemId) {
          const root = this.resolveParent(event.parentId);
          this.childOf.set(event.id, root);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          // Deliberately no closeAssistant() here: a subagent's tool
          // activity interleaves with the parent's prose, and splitting the
          // open assistant item on every child would shred one reply into
          // a dozen bubbles.
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
          return;
        }

        this.closeAssistant();
        this.appendItem(item);
        return;
      }

      case 'tool-end': {
        const existing = this.toolItems.get(event.id);
        if (!existing || existing.role !== 'tool') { return; }
        const children = this.childrenByParent.get(event.id);
        const settled: TranscriptItem = {
          ...existing,
          state: event.ok ? 'ok' : 'error',
          output: event.output,
          ...(children ? { children: [...children] } : {}),
        };
        this.toolItems.set(event.id, settled);

        const parentRoot = this.childOf.get(event.id);
        if (parentRoot) {
          this.replaceChild(parentRoot, settled);
          return;
        }
        this.childrenByParent.delete(event.id);
        this.replaceItem(settled);
        return;
      }

      case 'permission': {
        // The permission id is the tool-use id of the call being approved,
        // so a permission raised inside a subagent resolves through the
        // same child map its tool-start populated. Providers that report a
        // parent explicitly are honoured first.
        const parentSource = event.parentId ?? this.childOf.get(event.id);
        const parentItemId = parentSource
          ? this.parentItemIdFor(parentSource)
          : undefined;

        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, name: parseToolName(event.name).name,
          input: event.input, state: 'pending',
        };
        this.permissionItems.set(event.id, item);
        this.pending.set(event.id, {
          requestId: event.id, name: event.name, input: event.input,
        });

        if (parentSource && parentItemId) {
          const root = this.resolveParent(parentSource);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          this.permissionChildOf.set(event.id, root);
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
        } else {
          this.closeAssistant();
          this.appendItem(item);
        }
        this.setStatus('awaiting-approval');
        return;
      }
```

Add the companion map next to `childOf`:

```ts
  /** Permission request id -> the provider tool id of the subagent it nests under. */
  private permissionChildOf = new Map<string, string>();
```

And the child-replace helper:

```ts
  /**
   * Settles an item that lives inside a parent's children buffer. The child
   * is not in the store yet — it lands there inline when the parent settles
   * — so this updates the buffer and streams a patch, with no store write.
   */
  private replaceChild(parentRoot: string, item: TranscriptItem): void {
    const children = this.childrenByParent.get(parentRoot);
    if (children) {
      const at = children.findIndex((c) => c.id === item.id);
      if (at >= 0) { children[at] = item; } else { children.push(item); }
    }
    const parentItemId = this.parentItemIdFor(parentRoot);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'replace', item, parentItemId });
  }
```

- [ ] **Step 5: Route settled permissions through the child path**

In `respondToPermission`, both places that call `this.replaceItem(settled)` must instead route through the child buffer when the permission nests. Replace each `this.replaceItem(settled);` in that method with:

```ts
      const parentRoot = this.permissionChildOf.get(requestId);
      if (parentRoot) { this.replaceChild(parentRoot, settled); }
      else { this.replaceItem(settled); }
```

There are two such call sites — the error path and the success path. Both need it, or an approved subagent permission would be written to the store as a phantom top-level item while its card stayed pending.

- [ ] **Step 6: Flush abandoned parents on turn-end**

Replace the `turn-end` case in `handle()`:

```ts
      case 'turn-end':
        this.closeAssistant();
        this.flushUnsettledParents();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          this.setStatus('idle');
          void this.scheduleFlush();
        }
        return;
```

And add:

```ts
  /**
   * Settles any parent tool call still running when the turn ended.
   *
   * Interrupt, provider crash, or a turn ending mid-Task means the parent's
   * `tool-end` never arrives, so its buffered children would be dropped on
   * the floor — discarding, on disk, subagent work the user watched happen
   * on screen.
   */
  private flushUnsettledParents(): void {
    for (const [parentId, children] of this.childrenByParent) {
      const existing = this.toolItems.get(parentId);
      if (!existing || existing.role !== 'tool' || existing.state !== 'running') { continue; }
      const settled: TranscriptItem = {
        ...existing, state: 'error', children: [...children],
      };
      this.toolItems.set(parentId, settled);
      this.replaceItem(settled);
    }
    this.childrenByParent.clear();
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS — all 8 nesting tests, and the existing `AgentSession` suite still green.

- [ ] **Step 8: Commit**

```bash
git add src/host/agent-session.ts src/test/unit/agent-session-nesting.test.ts
git commit -m "feat: nest subagent tool activity under its parent tool call"
```

---

## Task 4: MCP status plumbing

The provider reports server health; the host forwards it to visible sessions and includes it in snapshots. Nothing here is persisted.

**Files:**
- Modify: `src/host/agent-session.ts`
- Modify: `src/host/session-manager.ts`
- Modify: `src/test/unit/agent-session.test.ts`
- Modify: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Produces: `SessionSink.mcp(id: SessionId, servers: McpServerStatus[]): void` from `src/host/agent-session.ts`.
- Produces: `SessionManager` emitting `{ t: 'session-mcp'; id; servers }` for visible sessions.

**Every existing `SessionSink` implementation must gain an `mcp` method** — `SessionManager` and the `RecordingSink` classes in `agent-session.test.ts` and `agent-session-nesting.test.ts`. `tsc` will point at each one.

- [ ] **Step 1: Write the failing tests**

Add to the `AgentSession` suite in `src/test/unit/agent-session.test.ts`:

```ts
  test('an mcp-servers event reaches the sink and the snapshot', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'mcp-servers', servers: [
        { name: 'github', state: 'connected', toolCount: 12 },
        { name: 'stripe', state: 'failed', error: 'spawn ENOENT' },
      ] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    assert.strictEqual(sink.servers.length, 1, 'one snapshot forwarded');
    const snap = await session.snapshot();
    assert.strictEqual(snap.mcpServers.length, 2);
    assert.strictEqual(snap.mcpServers[0].name, 'github');
    await session.dispose();
  });

  test('a later mcp-servers event replaces the previous snapshot wholesale', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'mcp-servers', servers: [{ name: 'github', state: 'pending' }] },
      { kind: 'mcp-servers', servers: [{ name: 'github', state: 'connected', toolCount: 12 }] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    assert.strictEqual(snap.mcpServers.length, 1);
    assert.strictEqual(snap.mcpServers[0].state, 'connected');
    assert.strictEqual(snap.mcpServers[0].toolCount, 12);
    await session.dispose();
  });
```

Extend the `RecordingSink` in that file (and in `agent-session-nesting.test.ts`, which already declares `servers: unknown[] = []`):

```ts
  servers: unknown[] = [];
  mcp(_id: SessionId, servers: unknown[]) { this.servers.push(servers); }
```

Add to the `SessionManager` suite in `src/test/unit/session-manager.test.ts`. The suite's `setup` already provides `manager`, `sent`, `store` and a `fake` provider, so these tests use them directly:

```ts
  test('session-mcp reaches a visible session and is withheld from a hidden one', async () => {
    const a = await manager.create('fake', '/tmp');
    const b = await manager.create('fake', '/tmp');
    await manager.setVisible([a.state.id]);
    sent.length = 0;

    manager.mcp(a.state.id, [{ name: 'github', state: 'connected', toolCount: 12 }]);
    manager.mcp(b.state.id, [{ name: 'github', state: 'connected', toolCount: 12 }]);

    const emitted = sent.filter((m) => m.t === 'session-mcp');
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual((emitted[0] as { id: string }).id, a.state.id);
  });

  test('an archived session snapshot reports no mcp servers', async () => {
    const a = await manager.create('fake', '/tmp');
    a.send('hello');
    await settle();
    const id = a.state.id;
    await manager.close(id);
    sent.length = 0;

    await manager.setVisible([id]);
    const snapshot = sent.find((m) => m.t === 'session-snapshot');
    assert.ok(snapshot);
    assert.deepStrictEqual(
      (snapshot as { session: { mcpServers: unknown[] } }).session.mcpServers, [],
    );
  });
```

The second test pins the spec's rule that an archived session shows no strip at all. It is served from the `store.tail` branch of `setVisible`, not from a live `AgentSession`, so it is the branch that would otherwise be missed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `Property 'mcp' does not exist` / `snap.mcpServers` is undefined.

- [ ] **Step 3: Extend `SessionSink` and `AgentSession`**

In `src/host/agent-session.ts`, add `McpServerStatus` to the protocol import, then extend the interface:

```ts
export interface SessionSink {
  patch(id: SessionId, patch: TranscriptPatch): void;
  status(id: SessionId, status: SessionStatus): void;
  mcp(id: SessionId, servers: McpServerStatus[]): void;
  changed(): void;
}
```

Add the field:

```ts
  /**
   * Live provider state only — never persisted, never on SessionState.
   * An archived session reports none, because there is no run to ask.
   */
  private mcpServers: McpServerStatus[] = [];
```

Add the case to `handle()`, before `turn-end`:

```ts
      case 'mcp-servers':
        // Replace-whole, not a merge: the provider always sends the full
        // array, so hydrate and live update are the same code path.
        this.mcpServers = event.servers;
        this.sink.mcp(this._state.id, event.servers);
        return;
```

Include it in `snapshot()`:

```ts
  async snapshot(): Promise<SessionSnapshot> {
    await this.scheduleFlush();
    const { items, hasMore } = await this.store.tail(this._state.id);
    return {
      ...this._state, items, hasMore,
      pending: [...this.pending.values()],
      mcpServers: this.mcpServers,
    };
  }
```

- [ ] **Step 4: Implement `mcp` on `SessionManager`**

In `src/host/session-manager.ts`, add `McpServerStatus` to the protocol import and add the sink method next to `status`:

```ts
  mcp(id: SessionId, servers: McpServerStatus[]): void {
    if (!this.visible.has(id)) { return; }
    this.emit({ t: 'session-mcp', id, servers });
  }
```

Gated on `visible` for the same reason `patch` is: a background session's server list is not rendered anywhere, so pushing it is traffic for nothing.

In `setVisible`, the archived branch builds a snapshot inline. Add the empty list:

```ts
      const { items, hasMore } = await this.store.tail(id);
      this.emit({
        t: 'session-snapshot',
        session: { ...state, items, hasMore, pending: [], mcpServers: [] },
      });
```

Unlike `patch`, `mcp` does not need the `snapshotting` buffer: `session-mcp` carries the entire state rather than a delta against it, so a late-arriving one is correct on its own and an early-arriving one is superseded by the snapshot with nothing lost.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

Run: `yarn check-types`
Expected: no output. If it reports a missing `mcp` on some sink, that is a test double the compiler caught — add the method there too.

- [ ] **Step 6: Commit**

```bash
git add src/host/agent-session.ts src/host/session-manager.ts src/test/unit
git commit -m "feat: forward MCP server status to visible sessions"
```

---

## Task 5: Claude event mapping for subagents and MCP

Where `parent_tool_use_id` becomes `parentId`, subagent prose gets dropped, and the init message's server list becomes an `mcp-servers` event.

**Files:**
- Modify: `src/providers/claude/map-events.ts`
- Modify: `src/test/unit/map-events.test.ts`

**Interfaces:**
- Consumes: `AgentEvent.parentId`, `McpServerStatus` (Task 1).
- Produces: no signature change — `mapEvent(msg: unknown): AgentEvent[]` as before.

- [ ] **Step 1: Write the failing tests**

Add to the suite in `src/test/unit/map-events.test.ts`:

```ts
  test('a subagent tool_use carries its parent tool id', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'a.ts' } },
      ] },
    });
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'c1', name: 'Read', input: { path: 'a.ts' }, parentId: 'task1' },
    ]);
  });

  test('subagent text and thinking are dropped, tool activity is kept', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'text', text: 'let me look' },
        { type: 'thinking', thinking: 'hmm', signature: 'x' },
        { type: 'tool_use', id: 'c1', name: 'Grep', input: {} },
      ] },
    });
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'c1', name: 'Grep', input: {}, parentId: 'task1' },
    ]);
  });

  test('top-level text and thinking are still emitted', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm', signature: 'x' },
      ] },
    });
    assert.deepStrictEqual(events, [
      { kind: 'text', delta: 'hello' },
      { kind: 'thinking', delta: 'hmm' },
    ]);
  });

  test('a subagent tool_result carries its parent tool id', () => {
    const events = mapEvent({
      type: 'user',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      ] },
    });
    assert.deepStrictEqual(events, [
      { kind: 'tool-end', id: 'c1', ok: true, output: 'ok', parentId: 'task1' },
    ]);
  });

  test('a top-level tool_result has no parentId key at all', () => {
    const [event] = mapEvent({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    assert.strictEqual('parentId' in (event as object), false);
  });

  test('the init message yields both a session and an mcp-servers event', () => {
    const events = mapEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      mcp_servers: [
        { name: 'github', status: 'connected' },
        { name: 'stripe', status: 'failed' },
      ],
    });
    assert.deepStrictEqual(events, [
      { kind: 'session', resumeToken: 'sess-1' },
      { kind: 'mcp-servers', servers: [
        { name: 'github', state: 'connected' },
        { name: 'stripe', state: 'failed' },
      ] },
    ]);
  });

  test('an unrecognized server status degrades to pending rather than being dropped', () => {
    const events = mapEvent({
      type: 'system', subtype: 'init', session_id: 's',
      mcp_servers: [{ name: 'weird', status: 'reticulating' }],
    });
    assert.deepStrictEqual(events[1], {
      kind: 'mcp-servers', servers: [{ name: 'weird', state: 'pending' }],
    });
  });

  test('an init message with no mcp servers emits no mcp-servers event', () => {
    const events = mapEvent({ type: 'system', subtype: 'init', session_id: 's' });
    assert.deepStrictEqual(events, [{ kind: 'session', resumeToken: 's' }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `parentId` missing from the mapped events, and no `mcp-servers` event.

- [ ] **Step 3: Add the server-status mapping to `map-events.ts`**

Add near the top, after the `Block` interface:

```ts
import type { AgentEvent, McpServerStatus } from '../types';

const SERVER_STATES = new Set<McpServerStatus['state']>([
  'pending', 'connected', 'failed', 'needs-auth', 'disabled',
]);

/**
 * `SDKSystemMessage.mcp_servers` types `status` as a bare `string`
 * (sdk.d.ts:4610), so an unknown value is possible on any SDK bump. Degrade
 * to 'pending' rather than dropping the server — a server missing from the
 * strip reads as "not configured", which is a worse lie than "still
 * starting".
 */
function toServerState(raw: unknown): McpServerStatus['state'] {
  return SERVER_STATES.has(raw as McpServerStatus['state'])
    ? (raw as McpServerStatus['state'])
    : 'pending';
}

function parentIdOf(msg: unknown): string | undefined {
  const raw = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
```

`parentIdOf` returns `undefined` rather than `null` so the spread below omits the key entirely — a top-level event stays byte-identical to what v1 produced.

- [ ] **Step 4: Emit `mcp-servers` from the init message**

Replace the `type === 'system'` branch:

```ts
  if (type === 'system') {
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype !== 'init') { return []; }
    const out: AgentEvent[] = [];
    const sessionId = (msg as { session_id?: string }).session_id;
    if (sessionId) { out.push({ kind: 'session', resumeToken: sessionId }); }

    const servers = (msg as { mcp_servers?: unknown }).mcp_servers;
    if (Array.isArray(servers) && servers.length > 0) {
      out.push({
        kind: 'mcp-servers',
        servers: servers
          .filter((s): s is { name: string; status?: unknown } =>
            typeof (s as { name?: unknown }).name === 'string')
          .map((s) => ({ name: s.name, state: toServerState(s.status) })),
      });
    }
    return out;
  }
```

The init message carries name and status only. The richer shape — `error`, `toolCount` — arrives from the `mcpServerStatus()` pull in Task 6, which supersedes this snapshot wholesale.

- [ ] **Step 5: Propagate `parentId` and drop subagent prose**

Replace the `type === 'assistant'` branch:

```ts
  if (type === 'assistant') {
    const out: AgentEvent[] = [];
    const parentId = parentIdOf(msg);
    for (const block of blocks(msg)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // Subagent prose is dropped. The SDK's `forwardSubagentText` option
        // defaults to false, so these blocks should not arrive at all — this
        // is a defensive assertion, kept so a future default flip or a
        // second provider cannot silently reintroduce the token volume that
        // the nested-card design exists to avoid.
        if (parentId) { continue; }
        out.push({ kind: 'text', delta: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (parentId) { continue; }
        out.push({ kind: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({
          kind: 'tool-start', id: block.id, name: block.name, input: block.input,
          ...(parentId ? { parentId } : {}),
        });
      }
    }
    return out;
  }
```

Replace the `type === 'user'` branch:

```ts
  if (type === 'user') {
    const out: AgentEvent[] = [];
    const parentId = parentIdOf(msg);
    for (const block of blocks(msg)) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        out.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          output: block.content,
          ...(parentId ? { parentId } : {}),
        });
      }
    }
    return out;
  }
```

- [ ] **Step 6: Record the new SDK facts in the header comment**

Append to the header comment block, after the existing `SDKMessage` notes:

```
//   - Subagent correlation: `parent_tool_use_id: string | null` is present on
//     `SDKAssistantMessage` (sdk.d.ts:3022) and on the `user` messages that
//     carry tool results. Non-null means the message came from a subagent,
//     and its value is the tool_use id of the `Task` call that spawned it —
//     which is exactly the id our own `tool-start` for that Task already
//     carries, so no extra correlation event is needed.
//   - `Options.forwardSubagentText` (sdk.d.ts:1662) defaults to false, and
//     at that default "only tool_use/tool_result blocks from subagents are
//     emitted". That default IS the mechanism behind our tool-activity-only
//     subagent cards; claude-provider.ts must never set it to true. The
//     text/thinking drop below is a belt-and-braces assertion on top.
//   - `SDKSystemMessage` (subtype 'init') carries `mcp_servers: { name:
//     string; status: string }[]` (sdk.d.ts:4610) — name and status only.
//     `status` is typed as a bare string, hence toServerState()'s fallback.
//     The richer per-server shape (error, tools[]) comes from
//     `Query.mcpServerStatus()` (sdk.d.ts:2500), pulled in claude-provider.ts.
//   - `canUseTool`'s options give `agentID` (the subagent instance id), NOT
//     the spawning Task's tool_use id, so a permission cannot be nested from
//     the SDK payload alone. AgentSession derives it instead: the permission
//     id IS the tool_use id of the call being approved, so it resolves
//     through the same child map that tool-start populated.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS — the 8 new mapping tests, and every existing `map-events` test still green.

- [ ] **Step 8: Commit**

```bash
git add src/providers/claude/map-events.ts src/test/unit/map-events.test.ts
git commit -m "feat: map subagent parent ids and MCP server status from SDK messages"
```

---

## Task 6: Claude provider options guard and status pull

Two small changes with outsized consequences: never enable subagent text, and pull the rich server status once per run.

**Files:**
- Modify: `src/providers/claude/claude-provider.ts`
- Create: `src/test/unit/claude-options.test.ts`

**Interfaces:**
- Produces: `buildOptions(opts: StartOptions, canUseTool: CanUseTool): Options` exported from `src/providers/claude/claude-provider.ts`.

`buildOptions` is extracted purely so the guard is testable. The alternative — a test that greps the source for a string — asserts on text rather than behaviour and passes happily if the option is set through a spread.

- [ ] **Step 1: Write the failing test**

`src/test/unit/claude-options.test.ts`:

```ts
import * as assert from 'assert';
import { buildOptions } from '../../providers/claude/claude-provider';

const noopCanUseTool = (async () => ({ behavior: 'allow' as const, updatedInput: undefined })) as never;

suite('claude buildOptions', () => {
  test('never enables forwardSubagentText', () => {
    const options = buildOptions(
      { cwd: '/tmp', permissionMode: 'default' }, noopCanUseTool,
    );
    assert.strictEqual(
      'forwardSubagentText' in options, false,
      'enabling this streams every subagent token into the transcript, which is exactly what the nested-card design avoids',
    );
  });

  test('maps our permission mode onto the SDK union', () => {
    const options = buildOptions(
      { cwd: '/tmp', permissionMode: 'bypass' }, noopCanUseTool,
    );
    assert.strictEqual(options.permissionMode, 'bypassPermissions');
  });

  test('omits effort entirely when none is set', () => {
    const options = buildOptions(
      { cwd: '/tmp', permissionMode: 'default' }, noopCanUseTool,
    );
    assert.strictEqual('effort' in options, false);
  });

  test('passes cwd, model and resume through', () => {
    const options = buildOptions(
      { cwd: '/work', model: 'claude-opus-5', permissionMode: 'default', resumeToken: 'sess-9' },
      noopCanUseTool,
    );
    assert.strictEqual(options.cwd, '/work');
    assert.strictEqual(options.model, 'claude-opus-5');
    assert.strictEqual(options.resume, 'sess-9');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `buildOptions` is not exported.

- [ ] **Step 3: Extract `buildOptions` in `claude-provider.ts`**

Add above the `ClaudeProvider` class:

```ts
/**
 * Builds the SDK `Options` for one run.
 *
 * Extracted and exported so the `forwardSubagentText` guard is a real
 * assertion on the produced object rather than a grep over this file.
 *
 * `forwardSubagentText` is deliberately absent. Its default (false) means
 * only tool_use/tool_result blocks from subagents are emitted, which is
 * precisely the tool-activity-only subagent card this codebase renders.
 * Setting it true would stream every subagent token through
 * patch -> postMessage -> render, multiplied by every concurrent subagent.
 */
export function buildOptions(opts: StartOptions, canUseTool: CanUseTool): Options {
  return {
    cwd: opts.cwd,
    model: opts.model,
    resume: opts.resumeToken,
    permissionMode: PERMISSION_MODE[opts.permissionMode],
    canUseTool,
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  };
}
```

In `start()`, replace the inline `const options: Options = { ... }` with:

```ts
    const options = buildOptions(opts, canUseTool);
```

The local `let effort = opts.effort;` stays — `setEffort` still reads and updates it for `applyFlagSettings`.

- [ ] **Step 4: Pull the rich server status once the query exists**

In `start()`, inside the `pump` async IIFE, immediately after `queryRef = session;`:

```ts
        // The init message already produced a name+status snapshot via
        // map-events. This pull supersedes it with the full shape — error
        // text and a real tool count. Fire-and-forget: a failure here means
        // the strip keeps the coarser init data, which is a degraded strip
        // rather than a failed turn.
        void session.mcpServerStatus().then(
          (servers) => {
            if (disposed || servers.length === 0) { return; }
            events.push({
              kind: 'mcp-servers',
              servers: servers.map((s) => ({
                name: s.name,
                state: s.status === 'connected' || s.status === 'failed'
                  || s.status === 'needs-auth' || s.status === 'pending'
                  || s.status === 'disabled' ? s.status : 'pending',
                ...(s.tools ? { toolCount: s.tools.length } : {}),
                ...(s.error ? { error: redactSecrets(s.error) } : {}),
              })),
            });
          },
          () => { /* see comment above: degraded strip, not a failed turn */ },
        );
```

`s.error` goes through `redactSecrets` for the same reason `errorMessage` does: a server that failed to start can put a URL or token into its error text, and that text is about to become a rendered UI string.

- [ ] **Step 5: Run the tests and type check**

Run: `yarn test:unit`
Expected: PASS, 4 new tests in `claude buildOptions`.

Run: `yarn check-types`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-options.test.ts
git commit -m "feat: pull MCP server status and guard subagent text forwarding"
```

---

## Task 7: Nested patches in the webview reducer

The client half of the nesting contract, plus the new `session-mcp` message.

**Files:**
- Modify: `src/webview/reducer.ts`
- Modify: `src/test/unit/webview-reducer.test.ts`

**Interfaces:**
- Produces: `PaneState.mcpServers: McpServerStatus[]`.
- Consumes: `TranscriptPatch.parentItemId`, `session-mcp` (Task 1).

- [ ] **Step 1: Write the failing tests**

Add to the `webview reducer` suite in `src/test/unit/webview-reducer.test.ts`, following the harness the existing tests use to build a hydrated state:

```ts
  test('an append with parentItemId nests under the parent tool item', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 't1' },
    });

    const items = state.byId['s1'].items;
    assert.strictEqual(items.length, 1, 'the child is not a top-level item');
    assert.strictEqual((items[0] as { children?: unknown[] }).children?.length, 1);
  });

  test('a replace with parentItemId settles the child in place', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 't1' },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'replace', item: { ...child, state: 'ok' as const }, parentItemId: 't1' },
    });

    const children = (state.byId['s1'].items[0] as { children: { state: string }[] }).children;
    assert.strictEqual(children.length, 1, 'settled in place, not appended again');
    assert.strictEqual(children[0].state, 'ok');
  });

  test('a child whose parent is not in the loaded window is promoted to top-level', () => {
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    const state = reduce(hydrated(), {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 'gone' },
    });
    assert.strictEqual(state.byId['s1'].items.length, 1);
    assert.strictEqual(state.byId['s1'].items[0].id, 't2');
  });

  test('a nested pending permission still reaches the pane pending list', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const perm = {
      id: 'p1', ts: 2, role: 'permission' as const, requestId: 'r1', name: 'Bash',
      input: {}, state: 'pending' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: perm, parentItemId: 't1' },
    });
    assert.strictEqual(state.byId['s1'].pending.length, 1);
  });

  test('session-mcp replaces the pane server list wholesale', () => {
    let state = reduce(hydrated(), {
      t: 'session-mcp', id: 's1', servers: [{ name: 'github', state: 'pending' }],
    });
    state = reduce(state, {
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
    });
    assert.deepStrictEqual(state.byId['s1'].mcpServers, [
      { name: 'github', state: 'connected', toolCount: 12 },
    ]);
  });

  test('session-mcp for an unknown session is ignored', () => {
    const before = hydrated();
    const after = reduce(before, { t: 'session-mcp', id: 'nope', servers: [] });
    assert.strictEqual(after, before);
  });
```

`hydrated()` is a helper to add near the top of the file if one does not already exist — read the file first and reuse its existing setup if it does:

```ts
function hydrated() {
  return reduce(initialState, {
    t: 'hydrate',
    sessions: [],
    layout: { orientation: 'vertical', panes: [] },
    catalog: [],
    snapshots: [{
      id: 's1', providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
      status: 'idle', permissionMode: 'default',
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: 1, updatedAt: 1,
      items: [], hasMore: false, pending: [], mcpServers: [],
    }],
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — the child lands as a top-level item, and `session-mcp` falls through to the default no-op.

- [ ] **Step 3: Add `mcpServers` to `PaneState`**

In `src/webview/reducer.ts`, extend the import with `McpServerStatus`, then:

```ts
export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  mcpServers: McpServerStatus[];
}
```

Populate it in `hydrate` and `session-snapshot`, both of which build a `PaneState` from a `SessionSnapshot`:

```ts
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
          mcpServers: s.mcpServers ?? [],
        };
```

```ts
          [s.id]: {
            summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
            mcpServers: s.mcpServers ?? [],
          },
```

The `?? []` guards a host that shipped before this webview bundle — the same defensive posture the existing `default:` no-op takes.

- [ ] **Step 4: Handle `session-mcp`**

Add a case to `reduce`, before the `default`:

```ts
    case 'session-mcp': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, mcpServers: msg.servers } },
      };
    }
```

- [ ] **Step 5: Route nested patches in `applyPatch`**

Replace `applyPatch` in `src/webview/reducer.ts`:

```ts
function applyPatch(pane: PaneState, patch: Patch): PaneState {
  switch (patch.op) {
    case 'append': {
      const pending = patch.item.role === 'permission' && patch.item.state === 'pending'
        ? [...pane.pending, {
            requestId: patch.item.requestId,
            name: patch.item.name,
            input: patch.item.input,
          }]
        : pane.pending;

      // A nested append targets a parent already in the loaded window: the
      // parent's tool-start is appended before its subagent can emit
      // anything, so no orphan buffer is needed. If the parent genuinely is
      // not here, promote the child to top-level rather than dropping it —
      // losing nesting degrades rendering; dropping hides real work.
      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, patch.item);
        if (nested) { return { ...pane, items: nested, pending }; }
      }

      return { ...pane, items: [...pane.items, patch.item], pending };
    }

    case 'replace': {
      const replaced = patch.item;
      const pending = replaced.role === 'permission' && replaced.state !== 'pending'
        ? pane.pending.filter((p) => p.requestId !== replaced.requestId)
        : pane.pending;

      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, replaced);
        if (nested) { return { ...pane, items: nested, pending }; }
      }

      const items = pane.items.map((i) => (i.id === replaced.id ? replaced : i));
      return { ...pane, items, pending };
    }

    case 'delta': {
      const items = pane.items.map((i) => {
        if (i.id !== patch.itemId || i.role !== 'assistant') { return i; }
        return { ...i, [patch.field]: (i[patch.field] ?? '') + patch.delta };
      });
      return { ...pane, items };
    }
  }
}

/**
 * Inserts or replaces `child` inside `parentItemId`'s children, immutably.
 * Returns undefined when the parent is not in the loaded window, which is
 * the caller's signal to fall back to a top-level append.
 */
function withChild(
  items: TranscriptItem[],
  parentItemId: string,
  child: TranscriptItem,
): TranscriptItem[] | undefined {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== parentItemId || item.role !== 'tool') { return item; }
    found = true;
    const children = item.children ?? [];
    const at = children.findIndex((c) => c.id === child.id);
    const updated = at >= 0
      ? children.map((c, i) => (i === at ? child : c))
      : [...children, child];
    return { ...item, children: updated };
  });
  return found ? next : undefined;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 6 new reducer tests, existing reducer tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/webview/reducer.ts src/test/unit/webview-reducer.test.ts
git commit -m "feat: nest child items and track MCP status in the webview reducer"
```

---

## Task 8: The subagent card

A collapsed row that ticks, an expanded card capped at the last 10 children, and no scroll container anywhere.

**Files:**
- Create: `src/webview/components/subagent-window.ts`
- Create: `src/webview/components/subagent-card.tsx`
- Modify: `src/webview/components/transcript-item-shell.tsx`
- Modify: `src/webview/components/tool-card.tsx`
- Modify: `src/webview/components/transcript-item.tsx`
- Create: `src/test/unit/subagent-window.test.ts`
- Create: `src/test/dom/subagent-card.test.tsx`

**Interfaces:**
- Produces: `SUBAGENT_CHILD_WINDOW: number`, `windowChildren(children: TranscriptItem[]): TranscriptItem[]`, `summarizeSubagent(item: ToolItem, now: number): SubagentSummary`, `formatElapsed(ms: number): string` from `src/webview/components/subagent-window.ts`.
- Produces: `SubagentCard({ item, sessionId })` from `src/webview/components/subagent-card.tsx`.
- Consumes: `TranscriptItemShell` with a new `subagent` role; the existing `ToolCard` and `PermissionCard`, unchanged.

**Read these three files before editing anything.** This task extends shipped work and the most likely failure mode is reverting it:

- `src/webview/components/transcript-item-shell.tsx` — the gutter idiom every role already uses.
- `src/webview/components/tool-card.tsx` — lucide state icon, `sr-only` state name, `aria-expanded` + `aria-controls`, `size="sm"` height discipline. **All of it stays.**
- `src/webview/components/status-badge.tsx` — the attention/failed tone spellings this card borrows.

- [ ] **Step 1: Write the failing unit test**

`src/test/unit/subagent-window.test.ts`:

```ts
import * as assert from 'assert';
import {
  SUBAGENT_CHILD_WINDOW, formatElapsed, summarizeSubagent, windowChildren,
} from '../../webview/components/subagent-window';
import type { TranscriptItem } from '../../protocol/messages';

function child(id: string, state: 'running' | 'ok' | 'error' = 'ok'): TranscriptItem {
  return { id, ts: 1, role: 'tool', toolId: id, name: 'Read', input: {}, state };
}

function parent(children: TranscriptItem[], ts = 1000): TranscriptItem {
  return {
    id: 't1', ts, role: 'tool', toolId: 'task1', name: 'Task',
    input: {}, state: 'running', children,
  };
}

suite('subagent window', () => {
  test('the window is ten', () => {
    assert.strictEqual(SUBAGENT_CHILD_WINDOW, 10);
  });

  test('renders every child when there are fewer than the window', () => {
    assert.deepStrictEqual(
      windowChildren([child('a'), child('b')]).map((c) => c.id), ['a', 'b'],
    );
  });

  test('keeps the LAST N so the newest child is always rendered', () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`));
    const shown = windowChildren(children);
    assert.strictEqual(shown.length, 10);
    assert.strictEqual(shown[0].id, 'c15');
    assert.strictEqual(shown[9].id, 'c24');
  });

  test('summary counts tools, running children and elapsed time', () => {
    const summary = summarizeSubagent(
      parent([child('a'), child('b', 'running')]) as never, 4000,
    );
    assert.strictEqual(summary.toolCount, 2);
    assert.strictEqual(summary.running, 1);
    assert.strictEqual(summary.elapsedMs, 3000);
    assert.strictEqual(summary.blocked, false);
  });

  test('a pending permission child marks the subagent blocked', () => {
    const item = parent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1', name: 'Bash',
      input: {}, state: 'pending',
    }]);
    assert.strictEqual(summarizeSubagent(item as never, 2).blocked, true);
  });

  test('a settled permission child does not mark it blocked', () => {
    const item = parent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1', name: 'Bash',
      input: {}, state: 'allowed',
    }]);
    assert.strictEqual(summarizeSubagent(item as never, 2).blocked, false);
  });

  test('a settled subagent stops counting from its last child, not from now', () => {
    const settled = {
      ...parent([child('a')], 1000), state: 'ok' as const,
    };
    settled.children![0] = { ...settled.children![0], ts: 3000 };
    assert.strictEqual(summarizeSubagent(settled as never, 99999).elapsedMs, 2000);
  });

  test('elapsed reads as minutes and seconds past a minute', () => {
    assert.strictEqual(formatElapsed(34_000), '34s');
    assert.strictEqual(formatElapsed(252_000), '4m 12s');
    assert.strictEqual(formatElapsed(0), '0s');
  });
});
```

A running subagent measures elapsed against `now` (the second argument), so the tests pass a fixed value rather than reading the clock — the helper stays pure and the assertions stay deterministic.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../webview/components/subagent-window`.

- [ ] **Step 3: Write `src/webview/components/subagent-window.ts`**

```ts
// Pure helpers for SubagentCard, kept free of React and UI imports so the
// mocha unit harness can require them directly — the same split
// tool-card-format.ts and status.ts use.
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * How many of a subagent's children an expanded card renders.
 *
 * The card is a live activity indicator, not a log reader: ten rows show
 * what the subagent is doing now. Rendering more would imitate a full log
 * view that does not exist, and would make an expanded card taller than the
 * viewport for a subagent that ran hundreds of tools.
 *
 * Because the window is the LAST N, the newest child is always on screen —
 * which is what makes live tailing free, with no scroll container, no
 * follow logic and no scrolled-up detection.
 */
export const SUBAGENT_CHILD_WINDOW = 10;

export function windowChildren(children: TranscriptItem[]): TranscriptItem[] {
  return children.length <= SUBAGENT_CHILD_WINDOW
    ? children
    : children.slice(children.length - SUBAGENT_CHILD_WINDOW);
}

export interface SubagentSummary {
  toolCount: number;
  running: number;
  /** A child is waiting on the user, so the card must force itself open. */
  blocked: boolean;
  elapsedMs: number;
}

/**
 * Everything the collapsed header shows, derived from the children already
 * on the item. Nothing here is transmitted — a `summary` field on the wire
 * would be one more thing to drift from what it summarizes.
 */
export function summarizeSubagent(item: ToolItem, now: number): SubagentSummary {
  const children = item.children ?? [];
  let running = 0;
  let blocked = false;
  let toolCount = 0;
  for (const child of children) {
    if (child.role === 'tool') {
      toolCount++;
      if (child.state === 'running') { running++; }
    } else if (child.role === 'permission' && child.state === 'pending') {
      blocked = true;
    }
  }
  // A settled subagent must stop ticking, and its own item carries no end
  // timestamp — the last thing it did is the best available end.
  const end = item.state === 'running' ? now : lastTs(children, item.ts);
  return { toolCount, running, blocked, elapsedMs: Math.max(0, end - item.ts) };
}

function lastTs(children: TranscriptItem[], fallback: number): number {
  let max = fallback;
  for (const child of children) { if (child.ts > max) { max = child.ts; } }
  return max;
}

/** `4m 12s`, `34s`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

/** The word a screen reader gets for a subagent's state. */
export function subagentStateLabel(item: ToolItem, blocked: boolean): string {
  if (blocked) { return 'needs you'; }
  return item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'failed';
}

/**
 * The agent type from a `Task` call's input, when it carries one. This is
 * the identifying fact — "Explore" tells the user what is running, where
 * "Task" is only SDK vocabulary.
 */
export function subagentLabel(item: ToolItem): string {
  const input = item.input;
  if (input && typeof input === 'object' && 'subagent_type' in input) {
    const type = (input as Record<string, unknown>).subagent_type;
    if (typeof type === 'string' && type.length > 0) { return type; }
  }
  return item.name;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 8 tests in the `subagent window` suite.

- [ ] **Step 5: Give a subagent its own gutter in `transcript-item-shell.tsx`**

Add one member to the role union and one entry to the map. Change nothing else in the file.

```ts
export type TranscriptItemRole = 'user' | 'assistant' | 'tool' | 'permission' | 'subagent' | 'error';

const RULE: Record<TranscriptItemRole, string> = {
  user: 'border-l-muted-foreground/40',
  assistant: 'border-l-primary/40',
  tool: 'border-l-border',
  // A subagent is a container of tool calls, not one call: a rule the eye
  // can separate from `tool` while scanning, without introducing a colour
  // that competes with `permission`/`error` (destructive) or `assistant`
  // (primary), both of which already mean something urgent here.
  subagent: 'border-l-muted-foreground',
  permission: 'border-l-destructive',
  error: 'border-l-destructive',
};
```

- [ ] **Step 6: Write `src/webview/components/subagent-card.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PermissionCard } from './permission-card';
import { ToolCard } from './tool-card';
import { TranscriptItemShell } from './transcript-item-shell';
import {
  formatElapsed, subagentLabel, subagentStateLabel, summarizeSubagent, windowChildren,
} from './subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function SubagentCard({ item, sessionId }: { item: ToolItem; sessionId: SessionId }) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A collapsed card must still tick: a row reading "12 tools · 34s" is not
  // a hang, and a static row is. One interval per running card, cleared the
  // moment it settles — a settled card's elapsed comes from its last child,
  // so nothing needs to re-render after that.
  useEffect(() => {
    if (item.state !== 'running') { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [item.state]);

  const summary = summarizeSubagent(item, now);
  const children = item.children ?? [];
  const shown = windowChildren(children);

  // A blocked subagent forces itself open — an approval buried in a
  // collapsed row would be worse than a flat transcript, where it was at
  // least visible. Once the user collapses it deliberately it stays
  // collapsed, and the header keeps reporting the block, so the card never
  // fights them.
  const expanded = open || (summary.blocked && !manuallyCollapsed);
  const panelId = `subagent-${item.toolId}`;

  return (
    <TranscriptItemShell role="subagent" label="Subagent" ts={item.ts}>
      <div className="rounded border border-border text-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = !expanded;
            setOpen(next);
            if (!next) { setManuallyCollapsed(true); }
          }}
          aria-expanded={expanded}
          aria-controls={panelId}
          // Matches tool-card.tsx: override the size variant's gap/padding
          // and justification, never its height.
          className="flex w-full items-center justify-start gap-2 px-2 font-normal"
        >
          {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          <span className="truncate font-medium">{subagentLabel(item)}</span>
          <span className="shrink-0 text-muted-foreground">
            {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
            {' · '}{formatElapsed(summary.elapsedMs)}
          </span>
          {/*
            The visible state is carried by the chevron and, when blocked, by
            the chip below. Everything else gets a text equivalent here, for
            the same reason tool-card.tsx does: an icon-only state has no
            accessible name at all.
          */}
          <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
          {summary.blocked && (
            // The `attention` tone from status-badge.tsx, spelled the same
            // way: text plus a quiet fill, never colour alone. A subagent
            // blocked on the user says the same thing the session badge
            // says, so it must not look like a different kind of event.
            <span className="ml-auto shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
              Needs you
            </span>
          )}
        </Button>

        {expanded && (
          <div id={panelId} className="border-t border-border px-2 py-1">
            {children.length > shown.length && (
              // A statement of fact, not a control. "Show all" would dump
              // 200 rows into the transcript and undo the bound; the escape
              // hatch is a future subagent pane, not a button here.
              <p className="pb-1 text-muted-foreground">
                showing last {shown.length} of {children.length}
              </p>
            )}
            <div className={cn('flex flex-col gap-1')}>
              {shown.map((child) =>
                child.role === 'permission' ? (
                  <PermissionCard key={child.id} item={child} sessionId={sessionId} />
                ) : child.role === 'tool' ? (
                  <ToolCard key={child.id} item={child} />
                ) : null,
              )}
            </div>
          </div>
        )}
      </div>
    </TranscriptItemShell>
  );
}
```

There is no `overflow`, `max-height` or scroll container anywhere in this component, deliberately. The pane's `MessageScroller` stays the only scroller, so its anchor and autoscroll behaviour is untouched; the last-N window bounds the height instead.

A collapsed card renders no children at all — not hidden with CSS, not rendered. Five collapsed subagents must not cost what five open ones do.

- [ ] **Step 7: Add the MCP badge to `ToolCard` — one element, nothing else**

In `src/webview/components/tool-card.tsx`, insert the badge between the `sr-only` state span and the tool name. Do not touch the icon, the `sr-only` span, the `aria-expanded`/`aria-controls` pair, the `size="sm"` class comment, or the `<pre>`.

```tsx
        <span className="sr-only">{item.state}</span>
        {item.mcpServer && (
          // Muted, not colour-per-server: a palette per server would collide
          // with the status tones already in use and buys nothing when the
          // name is right beside it. This is a permanent record — the value
          // is parsed host-side at item creation, so removing the server
          // later cannot rewrite what already happened.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {item.mcpServer}
          </span>
        )}
        <span className="font-medium">{item.name}</span>
```

- [ ] **Step 8: Route items with children in `transcript-item.tsx`**

Add the import and replace only the `tool` case:

```tsx
import { SubagentCard } from './subagent-card';
```

```tsx
    case 'tool':
      // A tool item only grows `children` once its subagent actually does
      // something, so a Task that ran nothing renders as an ordinary tool
      // card — correct, since there is nothing nested to show.
      return item.children && item.children.length > 0
        ? <SubagentCard item={item} sessionId={sessionId} />
        : <ToolCard item={item} />;
```

- [ ] **Step 9: Write the DOM test**

`src/test/dom/subagent-card.test.tsx`. Read `src/test/dom/transcript-item.test.tsx` first and mirror its setup — state arrives as real `HostToWebview` messages through the real `StoreProvider`, never as a hand-built `ClientState`.

```tsx
import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubagentCard } from '@/components/subagent-card';
import { renderWithStore, resetHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

function child(id: string, name: string): TranscriptItem {
  return { id, ts: 2, role: 'tool', toolId: id, name, input: {}, state: 'ok' };
}

function subagent(children: TranscriptItem[], over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 't1', ts: 1000, role: 'tool', toolId: 'task1', name: 'Task',
    input: { subagent_type: 'Explore' }, state: 'running', children, ...over,
  } as ToolItem;
}

suite('SubagentCard', () => {
  setup(() => { resetHost(); });

  test('collapsed by default, and renders none of its children', async () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);

    const toggle = screen.getByRole('button', { expanded: false });
    assert.ok(toggle.textContent?.includes('Explore'), 'names the agent type, not "Task"');
    assert.ok(toggle.textContent?.includes('1 tool'));
    assert.strictEqual(screen.queryByText('Read'), null, 'no child is rendered while collapsed');
  });

  test('expanding reveals the children through the shipped ToolCard', async () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    const panel = document.getElementById('subagent-task1');
    assert.ok(panel);
    assert.ok(within(panel!).getByText('Read'));
  });

  test('caps the rendered children at ten and says so', async () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`, `Tool${i}`));
    renderWithStore(<SubagentCard item={subagent(children)} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    assert.ok(screen.getByText('showing last 10 of 25'));
    assert.ok(screen.getByText('Tool24'), 'the newest child is rendered');
    assert.strictEqual(screen.queryByText('Tool14'), null, 'the eleventh-from-last is not');
    assert.strictEqual(
      screen.queryByRole('button', { name: /show all/i }), null,
      'no overflow control',
    );
  });

  test('a pending permission child forces the card open and is announced', () => {
    const item = subagent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1', name: 'Bash',
      input: { command: 'ls' }, state: 'pending',
    }]);
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    assert.ok(screen.getByRole('button', { expanded: true }), 'force-opened');
    assert.ok(screen.getByText('Needs you'));
  });

  test('a deliberate collapse sticks even while still blocked', async () => {
    const item = subagent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1', name: 'Bash',
      input: { command: 'ls' }, state: 'pending',
    }]);
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    await userEvent.click(screen.getByRole('button', { expanded: true }));
    assert.ok(screen.getByRole('button', { expanded: false }), 'stays collapsed');
    assert.ok(screen.getByText('Needs you'), 'and keeps reporting the block');
  });

  test('the card has no scroll container of its own', async () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`, `Tool${i}`));
    const { container } = renderWithStore(
      <SubagentCard item={subagent(children)} sessionId="s1" />,
    );
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    for (const el of container.querySelectorAll('*')) {
      const cls = el.className;
      if (typeof cls !== 'string') { continue; }
      assert.ok(
        !/overflow-(y-|x-)?(auto|scroll)|max-h-/.test(cls),
        `nested scrolling would break the pane's MessageScroller: ${cls}`,
      );
    }
  });
});
```

The last test is the one worth keeping: the bounded window exists precisely so that no nested scroller is needed, and a well-meaning later edit adding `max-h-48 overflow-auto` would silently undo the whole design decision.

- [ ] **Step 10: Run everything, including the design detector**

Run: `yarn test:unit`
Expected: PASS.

Run: `yarn test:dom`
Expected: PASS, 6 new `SubagentCard` tests plus the existing DOM suite.

Run: `yarn check-types && yarn lint`
Expected: no output, no errors.

Run the mechanical detector over the changed UI, as CLAUDE.md requires:

```bash
node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json \
  src/webview/components/subagent-card.tsx \
  src/webview/components/tool-card.tsx \
  src/webview/components/transcript-item.tsx \
  src/webview/components/transcript-item-shell.tsx
```

Expected: exit 0. Exit 2 means findings, which is a failing check and not a suggestion.

- [ ] **Step 11: Commit**

```bash
git add src/webview/components src/test/unit/subagent-window.test.ts src/test/dom/subagent-card.test.tsx
git commit -m "feat: render subagent activity as a live, bounded nested card"
```

---

## Task 9: MCP health in the roster

Server health is a workspace-level fact, so it is reported once in the roster rather than repeated in every pane header.

**Files:**
- Create: `src/webview/components/mcp-status.ts`
- Modify: `src/webview/components/session-picker.tsx`
- Create: `src/test/unit/mcp-status.test.ts`
- Create: `src/test/dom/session-picker-mcp.test.tsx`

**Interfaces:**
- Produces: `worstState(servers: McpServerStatus[]): McpServerStatus['state'] | undefined`, `isUnhealthy(state: McpServerStatus['state']): boolean`, `aggregateServers(byId: Record<SessionId, { mcpServers: McpServerStatus[] }>): McpServerStatus[]` from `src/webview/components/mcp-status.ts`.
- Consumes: `PaneState.mcpServers` (Task 7).

- [ ] **Step 1: Write the failing unit test**

`src/test/unit/mcp-status.test.ts`:

```ts
import * as assert from 'assert';
import { aggregateServers, isUnhealthy, worstState } from '../../webview/components/mcp-status';

suite('mcp status rollup', () => {
  test('no servers means no state to report', () => {
    assert.strictEqual(worstState([]), undefined);
  });

  test('all connected reports connected', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' }, { name: 'b', state: 'connected' },
    ]), 'connected');
  });

  test('failed outranks connected, pending and needs-auth', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' },
      { name: 'b', state: 'pending' },
      { name: 'c', state: 'needs-auth' },
      { name: 'd', state: 'failed' },
    ]), 'failed');
  });

  test('needs-auth outranks pending and disabled', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'pending' },
      { name: 'b', state: 'disabled' },
      { name: 'c', state: 'needs-auth' },
    ]), 'needs-auth');
  });

  test('disabled is not treated as a problem', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' }, { name: 'b', state: 'disabled' },
    ]), 'connected');
    assert.strictEqual(isUnhealthy('disabled'), false);
    assert.strictEqual(isUnhealthy('pending'), false);
    assert.strictEqual(isUnhealthy('connected'), false);
    assert.strictEqual(isUnhealthy('failed'), true);
    assert.strictEqual(isUnhealthy('needs-auth'), true);
  });

  test('aggregation dedupes by name and keeps the worst report', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [
        { name: 'github', state: 'connected', toolCount: 12 },
        { name: 'stripe', state: 'connected' },
      ] },
      s2: { mcpServers: [
        { name: 'github', state: 'failed', error: 'spawn ENOENT' },
      ] },
    });
    assert.strictEqual(merged.length, 2);
    const github = merged.find((s) => s.name === 'github');
    assert.strictEqual(github?.state, 'failed');
    assert.strictEqual(github?.error, 'spawn ENOENT');
  });

  test('aggregation keeps a tool count the worse report lacks', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [{ name: 'github', state: 'connected', toolCount: 12 }] },
      s2: { mcpServers: [{ name: 'github', state: 'pending' }] },
    });
    assert.strictEqual(merged[0].state, 'pending');
    assert.strictEqual(merged[0].toolCount, 12);
  });

  test('aggregation is sorted worst-first, then by name', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [
        { name: 'zulip', state: 'connected' },
        { name: 'alpha', state: 'connected' },
        { name: 'stripe', state: 'failed' },
      ] },
    });
    assert.deepStrictEqual(merged.map((s) => s.name), ['stripe', 'alpha', 'zulip']);
  });

  test('no panes means nothing to report', () => {
    assert.deepStrictEqual(aggregateServers({}), []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../webview/components/mcp-status`.

- [ ] **Step 3: Write `src/webview/components/mcp-status.ts`**

```ts
// Pure rollup helpers for the roster's MCP group — no React, no UI imports,
// so the mocha unit harness requires them directly.
import type { McpServerStatus, SessionId } from '../../protocol/messages';

/**
 * Severity order, worst last.
 *
 * `disabled` ranks below `connected`: a server the user turned off is not a
 * problem, and colouring it like one trains people to ignore the signal.
 */
const RANK: Record<McpServerStatus['state'], number> = {
  disabled: 0,
  connected: 1,
  pending: 2,
  'needs-auth': 3,
  failed: 4,
};

export function worstState(
  servers: McpServerStatus[],
): McpServerStatus['state'] | undefined {
  let worst: McpServerStatus['state'] | undefined;
  for (const server of servers) {
    if (worst === undefined || RANK[server.state] > RANK[worst]) { worst = server.state; }
  }
  return worst;
}

/**
 * Worth interrupting the roster trigger for.
 *
 * `pending` is excluded deliberately: every server is pending for the first
 * moment of every session, and a warning that always fires at startup is a
 * warning nobody reads.
 */
export function isUnhealthy(state: McpServerStatus['state']): boolean {
  return state === 'failed' || state === 'needs-auth';
}

/**
 * One list across every pane currently in the split, deduped by server name.
 *
 * Sessions share the workspace's MCP configuration, so the same server
 * appearing under two sessions is one server. When two sessions disagree,
 * the worse report wins — a server that failed for one session is a real
 * problem even if another session got it up. Fields the worse report lacks
 * (a tool count it never learned because it never connected) are carried
 * over from the better one.
 *
 * Only panes appear here because status only flows for visible sessions;
 * the roster labels the group accordingly rather than implying it has
 * surveyed sessions it has never opened.
 */
export function aggregateServers(
  byId: Record<SessionId, { mcpServers: McpServerStatus[] }>,
): McpServerStatus[] {
  const merged = new Map<string, McpServerStatus>();
  for (const pane of Object.values(byId)) {
    for (const server of pane.mcpServers ?? []) {
      const existing = merged.get(server.name);
      if (!existing) { merged.set(server.name, { ...server }); continue; }
      const worse = RANK[server.state] > RANK[existing.state] ? server : existing;
      const other = worse === server ? existing : server;
      merged.set(server.name, {
        ...worse,
        toolCount: worse.toolCount ?? other.toolCount,
        error: worse.error ?? other.error,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => RANK[b.state] - RANK[a.state] || a.name.localeCompare(b.name),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 9 tests in `mcp status rollup`.

- [ ] **Step 5: Add the MCP group to `session-picker.tsx`**

Read the file first. It already imports `DropdownMenuGroup`, `DropdownMenuLabel` and `DropdownMenuSeparator`, and already computes `needing` for the trigger.

Add the imports:

```tsx
import { PlugZapIcon } from 'lucide-react';
import { aggregateServers, isUnhealthy, worstState } from './mcp-status';
```

Compute alongside `needing`:

```tsx
  const servers = aggregateServers(state.byId);
  const worst = worstState(servers);
  const serversNeedAttention = worst !== undefined && isUnhealthy(worst);
```

In the trigger, the `ml-auto` slot belongs to `needs you` — a blocked agent outranks a broken server, and only one of the two may claim it:

```tsx
          {needing > 0 ? (
            <span className="ml-auto text-primary">
              {needing} needs you
            </span>
          ) : serversNeedAttention && (
            // Only when something is actually wrong. Every server is
            // `pending` at startup and connected thereafter, so a permanent
            // health chip would spend the narrowest row in the app on a
            // value that is almost always "fine".
            <span className="ml-auto text-destructive">
              MCP: {worst === 'needs-auth' ? 'needs auth' : 'failed'}
            </span>
          )}
```

At the end of `DropdownMenuContent`, after the archived group:

```tsx
          {servers.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>MCP servers (open sessions)</DropdownMenuLabel>
                {servers.map((server) => (
                  <DropdownMenuItem key={server.name} disabled className="flex-col items-start gap-0.5">
                    <span className="flex w-full items-center gap-2">
                      <PlugZapIcon aria-hidden />
                      <span className="truncate font-medium">{server.name}</span>
                      <span className={cn(
                        'ml-auto shrink-0',
                        isUnhealthy(server.state) ? 'text-destructive' : 'text-muted-foreground',
                      )}>
                        {server.state === 'needs-auth' ? 'needs auth' : server.state}
                      </span>
                    </span>
                    {server.toolCount !== undefined && (
                      <span className="text-muted-foreground">
                        {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
                      </span>
                    )}
                    {server.state === 'needs-auth' && (
                      // No button: the extension host cannot run an OAuth
                      // flow, so a control here would be a lie. The honest
                      // action is a terminal one.
                      <span className="text-muted-foreground">
                        Authorize in a terminal, then reopen the session.
                      </span>
                    )}
                    {server.error && (
                      <span className="wrap-break-word text-destructive">{server.error}</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
```

The rows are `disabled` because there is nothing to activate — they are a report, not a menu of actions. The group label says *open sessions* rather than implying the panel has surveyed sessions it has never opened.

`cn` must be imported from `@/lib/utils` if the file does not already import it.

- [ ] **Step 6: Write the DOM test**

`src/test/dom/session-picker-mcp.test.tsx`. Mirror `src/test/dom/session-picker.test.tsx` — read it first, and drive state through real `HostToWebview` messages.

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSnapshot } from '../../protocol/messages';

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1', providerId: 'claude', model: 'claude-opus-5', title: 'hiiiid-code',
    cwd: '/work/hiiiid-code', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
    items: [], hasMore: false, pending: [], mcpServers: [], ...over,
  };
}

function hydrate(snap: SessionSnapshot) {
  sendFromHost({
    t: 'hydrate',
    sessions: [snap],
    layout: { orientation: 'vertical', panes: [{ sessionId: snap.id, size: 100 }] },
    catalog: [{ id: 'claude', displayName: 'Claude', models: [] }],
    snapshots: [snap],
  });
}

suite('roster MCP group', () => {
  setup(() => { resetHost(); });

  test('no group and no trigger warning when there are no servers', async () => {
    renderApp();
    hydrate(snapshot());

    assert.strictEqual(screen.queryByText(/MCP:/), null);
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.strictEqual(screen.queryByText(/MCP servers/i), null);
  });

  test('healthy servers are listed but do not warn on the trigger', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
    });

    assert.strictEqual(screen.queryByText(/MCP:/), null, 'silent when healthy');
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(screen.getByText('github'));
    assert.ok(screen.getByText('12 tools'));
  });

  test('a failed server warns on the trigger and explains itself in the list', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'stripe', state: 'failed', error: 'spawn ENOENT' }],
    });

    assert.ok(screen.getByText('MCP: failed'));
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(screen.getByText('spawn ENOENT'));
  });

  test('needs-auth offers no button, because the host cannot run OAuth', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'drive', state: 'needs-auth' }],
    });

    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(screen.getByText(/Authorize in a terminal/i));
    assert.strictEqual(screen.queryByRole('button', { name: /authorize/i }), null);
  });

  test('a blocked agent outranks a broken server in the trigger slot', async () => {
    renderApp();
    hydrate(snapshot({ status: 'awaiting-approval' }));
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'stripe', state: 'failed' }],
    });

    assert.ok(screen.getByText('1 needs you'));
    assert.strictEqual(screen.queryByText('MCP: failed'), null);
  });
});
```

- [ ] **Step 7: Run everything, including the detector**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS.

Run: `yarn check-types && yarn lint && yarn compile`
Expected: no output, no errors.

```bash
node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json \
  src/webview/components/session-picker.tsx
```

Expected: exit 0.

- [ ] **Step 8: Manually verify against a real run**

Press F5, open the panel, and run a prompt that dispatches a subagent (for example: "use the Explore agent to find every file that imports react"). Confirm:

1. The subagent row appears collapsed under a `SUBAGENT` gutter label, and its tool count and elapsed tick upward while it runs.
2. Expanding shows child tool cards, and a subagent with more than ten children shows `showing last 10 of 25`.
3. The transcript has exactly one scrollbar — the pane's. The card itself never scrolls.
4. With an MCP server configured, the roster dropdown lists it; with one broken, the trigger reads `MCP: failed`.
5. Collapsing the panel mid-run and reopening restores the card with its children intact.

Point 3 is the one to actually look at: a nested scroll container here means the bounded window was bypassed.

- [ ] **Step 9: Commit**

```bash
git add src/webview/components src/test/unit/mcp-status.test.ts src/test/dom/session-picker-mcp.test.tsx
git commit -m "feat: report MCP server health in the session roster"
```

---

## Self-Review Notes

Checked against the spec:

- **Subagent nesting, depth 1, flatten deeper** — Task 3, with `resolveParent`'s hop cap.
- **Prose dropped at the seam / never requested** — Task 5 (defensive filter) and Task 6 (`forwardSubagentText` guard).
- **Permission nests and force-opens** — Task 3 (derivation), Task 8 (`blocked` + sticky manual collapse).
- **Children inline on parent settle, one JSONL line per top-level item** — Task 3; children never hit the store independently.
- **Abandoned subagent still written** — Task 3, `flushUnsettledParents`.
- **Migration is a no-op** — no task, because none is needed: `children` and `mcpServer` are optional, so v1 lines parse unchanged. The reducer's `?? []` covers the reverse direction.
- **`mcpServer` parsed once host-side** — Task 2 + Task 3.
- **MCP status live-only, absent when archived** — Task 4; `mcpServers` lives on `SessionSnapshot` and `PaneState`, never on `SessionState`, so it cannot reach `index.json`.
- **`'disabled'` in the union** — Task 1, ranked below `connected` in Task 9.
- **Bounded child window of 10, no nested scroll, no windowing library** — Task 8, with a DOM test that fails if any descendant gains an `overflow-*` or `max-h-*` class.
- **No overflow affordance** — Task 8 renders `showing last 10 of N` as plain text with no control, asserted by a DOM test.

Checked against the `impeccable` design brief (2026-08-14, Operate mode):

- **Extends the incumbent world, never replaces it** — Task 8 adds one entry to `TranscriptItemShell`'s `RULE` map and one element to `ToolCard`. The pre-overhaul rewrite of `tool-card.tsx` that an earlier draft of this plan carried is withdrawn; it would have deleted the lucide state icon, the `sr-only` accessible name, the `aria-expanded`/`aria-controls` pair and `wrap-break-word`.
- **MCP health in the roster, not the pane header** — Task 9. The header already carries nine elements.
- **A blocked agent outranks a broken server** — Task 9 gives the trigger's `ml-auto` slot to `needs you` and shows the MCP warning only when that slot is free.
- **Health is an exception report** — Task 9 warns on the trigger only for `failed`/`needs-auth`; `pending` is excluded because every server is pending at startup.
- **Text, never colour alone** — the blocked chip in Task 8 and every state in Task 9 carry a word; icon-only states get an `sr-only` equivalent.
- **DOM tests through the real `StoreProvider`** — Tasks 8 and 9 each add one, driven by genuine `HostToWebview` messages via `sendFromHost`, per CLAUDE.md.
- **The mechanical detector runs on the changed components** — Task 8 Step 10 and Task 9 Step 7. Exit 2 is a failing check, not a suggestion.

Three places where this plan deliberately departs from the spec's letter:

1. **`parseToolName` does not require exactly three `__`-separated segments.** The spec says a name that "does not split into three parts" is left alone; that rule would mangle a legitimate `mcp__github__list__repos`. The plan splits on the first separator after the prefix and treats the remainder as the tool name.
2. **Permission `parentId` is derived, not read from the SDK.** The spec assumed the provider reports it. `canUseTool` supplies `agentID` (the subagent instance) rather than the spawning `Task`'s tool-use id, so `AgentSession` resolves it from the child map instead — the permission id is the tool-use id of the call being approved. The `parentId` field stays on the event for providers that can supply it directly, and an unresolvable permission degrades to top-level.
3. **There is no per-pane MCP status strip.** The spec put one in the pane chrome, collapsed to a dot and a count. That was written against a header carrying three elements; the header shipped in PR #3 carries nine, and the strip would have been the tenth. Health moved to the roster instead, where it is reported once for the whole split rather than repeated per pane. The spec's rules survive the move intact — absent when there are no servers, absent for an archived session, no authorize button, and the historical record staying on the tool-card badges.
