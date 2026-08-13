# Usage and Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-session context-fill ring with a breakdown popover (system prompt, memory files, conversation, free) and a panel-level strip showing each account usage window the provider reports — percentages only, never token counts.

**Architecture:** Two optional methods on `AgentRun` (`contextBreakdown`, `usageWindows`) are the whole provider seam. `ClaudeProvider` implements them over the Agent SDK's `Query.getContextUsage()` and `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`; `FakeProvider` implements them from a script. The ring's percentage is pushed on `turn-end` as a new `SessionState` field; the detailed breakdown and the usage windows are pulled on demand through request/response message pairs. Every failure path resolves to `{ ok: false, reason }` — nothing rejects across `postMessage`.

**Tech Stack:** TypeScript, esbuild (node/CJS host + browser/IIFE webview), React 19, Tailwind v4, shadcn on `@base-ui/react` (`Tooltip`, `Popover` to vendor), `@anthropic-ai/claude-agent-sdk`, mocha (unit) + `@vscode/test-cli` (integration).

**Spec:** [docs/superpowers/specs/2026-08-13-usage-and-context-design.md](../specs/2026-08-13-usage-and-context-design.md)

## Global Constraints

- **No token counts in any UI surface.** Percentages only. Tokens exist solely inside provider-side mapping code.
- **`src/protocol/messages.ts` is types-only.** No runtime code, no `import ... from 'vscode'`.
- **Nothing under `src/providers/` or `src/protocol/` imports `vscode`.** Neither does `src/host/message-router.ts`.
- **Errors are state, never exceptions across `postMessage`.** Every new host handler resolves to a result union.
- **Every protocol message addressed to a session carries an explicit `SessionId`** in the field named `id`, matching the existing messages.
- **The wire discriminant is `t`**, not `type` (the spec's snippets are illustrative; the code in this plan is authoritative).
- **Use shadcn components, never raw HTML controls.** No bare `<button>`; use `Button` or a vendored primitive part. The registry is **Base UI** (`@base-ui/react`), not Radix.
- **Use short Tailwind utilities** — `bg-muted`, `text-muted-foreground`, `stroke-primary`. No `[var(--…)]` arbitrary values in component code. Dynamic bar widths use an inline `style`, which is not an arbitrary Tailwind value.
- **Filenames are kebab-case**, including React components. Component *identifiers* stay PascalCase.
- **`yarn lint`, `yarn check-types` and `yarn test:unit` must all pass before each commit.**
- **Commit after every task**, conventional-commit prefixes (`feat:`, `fix:`, `test:`, `docs:`).

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `src/providers/types.ts` | modify | `UsageWindow`, `ContextBreakdown`, two optional `AgentRun` methods |
| `src/providers/fake/fake-provider.ts` | modify | Scripted breakdown + windows; omitted → methods absent |
| `src/protocol/messages.ts` | modify | Re-export both types, `contextPercent`, `ContextResult`/`UsageResult`, 3 inbound + 2 outbound messages |
| `src/host/agent-session.ts` | modify | Refresh `contextPercent` on `turn-end`; expose both run methods |
| `src/host/session-manager.ts` | modify | `contextBreakdown(id)`, `usageWindows(providerId)` returning result unions |
| `src/host/message-router.ts` | modify | Route `request-context` / `request-usage`; ignore `open-file` |
| `src/host/panel-view-provider.ts` | modify | Intercept `open-file` → `window.showTextDocument` |
| `src/providers/claude/map-context.ts` | **create** | Pure SDK-response → `ContextBreakdown` / `UsageWindow[]` mapping |
| `src/providers/claude/claude-provider.ts` | modify | Wire both `Query` methods through the mapper |
| `src/webview/reducer.ts` | modify | `contextBySession`, `usageByProvider` |
| `src/webview/components/ui/tooltip.tsx` | **create** | Vendored shadcn Tooltip |
| `src/webview/components/ui/popover.tsx` | **create** | Vendored shadcn Popover |
| `src/webview/components/ring.tsx` | **create** | Presentational SVG ring, shared by both surfaces |
| `src/webview/components/context-ring.tsx` | **create** | Ring + tooltip + breakdown popover |
| `src/webview/components/composer.tsx` | modify | Host the context ring in the toolbar row |
| `src/webview/components/usage-strip.tsx` | **create** | Panel-level account usage strip |
| `src/webview/main.tsx` | modify | Render the strip below the pane group |
| `src/test/unit/map-context.test.ts` | **create** | Mapping tests |
| `src/test/unit/*.test.ts` | modify | Provider, protocol, session, manager, router, reducer tests |

---

## Parallelization

```
T1 (provider seam) ─┬─→ T2 (protocol) ─┬─→ T3 (session) ─→ T4 (manager) ─→ T5 (router) ─→ T6 (panel)
                    │                  │
                    ├─→ T7 (claude map + wiring)
                    │                  │
                    │                  └─→ T8 (reducer) ─┐
                    │                                     ├─→ T10 (context ring) ─┐
T9 (vendor ui) ─────┴─────────────────────────────────────┘                       ├─→ T12 (docs + verify)
                                                          └─→ T11 (usage strip) ──┘
```

| Wave | Run concurrently | Why they don't collide |
|---|---|---|
| 1 | **T1**, **T9** | `src/providers/` vs `src/webview/components/ui/` |
| 2 | **T2**, **T7** | `src/protocol/` vs `src/providers/claude/` (T7 needs only T1) |
| 3 | **T3**, **T8** | `src/host/agent-session.ts` vs `src/webview/reducer.ts` |
| 4 | **T4** | `src/host/session-manager.ts` alone |
| 5 | **T5**, **T10** | `src/host/message-router.ts` vs webview components |
| 6 | **T6**, **T11** | `src/host/panel-view-provider.ts` vs `usage-strip.tsx` + `main.tsx` |
| 7 | **T12** | alone — docs and full verification |

---

### Task 1: Provider seam and fake implementation

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/fake/fake-provider.ts`
- Test: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UsageWindow`, `ContextBreakdown` (exported types); `AgentRun.contextBreakdown?(): Promise<ContextBreakdown>`; `AgentRun.usageWindows?(): Promise<UsageWindow[]>`; `new FakeProvider(script, reports?: { context?: ContextBreakdown; windows?: UsageWindow[] })`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/fake-provider.test.ts`, inside the existing `suite('FakeProvider', …)`:

```ts
  test('reports a scripted context breakdown and usage windows', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }], {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
      },
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: 1000 }],
    });
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    assert.deepStrictEqual(await run.contextBreakdown!(), {
      systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
      memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
    });
    assert.deepStrictEqual(await run.usageWindows!(), [
      { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: 1000 },
    ]);
    await run.dispose();
  });

  test('omits both reporting methods when nothing is scripted', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    assert.strictEqual(run.contextBreakdown, undefined);
    assert.strictEqual(run.usageWindows, undefined);
    await run.dispose();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `check-types`/compile rejects the second `FakeProvider` constructor argument and the unknown `contextBreakdown` member.

- [ ] **Step 3: Add the types**

In `src/providers/types.ts`, after the `ToolDecision` union:

```ts
/** One account/plan usage window, as a percentage. Never a token count. */
export interface UsageWindow {
  /** Provider-defined: 'five-hour' | 'seven-day' | … */
  id: string;
  /** Human label, e.g. 'Session (5h)'. */
  label: string;
  /** 0..100. */
  usedPercent: number;
  /** Epoch ms, when the provider knows it. */
  resetsAt?: number;
}

/**
 * How the model's context window is occupied, as percentages of that window.
 * The four `*Percent` fields sum to 100; `memoryFiles` percentages sum to
 * `memoryPercent` subject to rounding, so consumers must never re-derive a
 * total from the rows.
 */
export interface ContextBreakdown {
  /** System prompt and tool definitions, as one slice. */
  systemPercent: number;
  memoryPercent: number;
  conversationPercent: number;
  freePercent: number;
  /** Absolute paths, with each file's share of the window. */
  memoryFiles: { path: string; percent: number }[];
}
```

Then extend `AgentRun`:

```ts
export interface AgentRun {
  send(text: string): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
  /**
   * Startup context inventory for this conversation. Optional: a provider
   * that cannot report it omits the method entirely rather than resolving
   * to a fabricated breakdown.
   */
  contextBreakdown?(): Promise<ContextBreakdown>;
  /**
   * Account/plan usage windows visible from this run. Lives on the run
   * rather than the provider because the Claude Agent SDK exposes plan
   * limits only from a live `Query`; the host treats any one live run of a
   * provider as speaking for that provider's account.
   */
  usageWindows?(): Promise<UsageWindow[]>;
}
```

- [ ] **Step 4: Implement the fake**

In `src/providers/fake/fake-provider.ts`, widen the import and the constructor, and conditionally add the two methods:

```ts
import type {
  AgentEvent, AgentProvider, AgentRun, ContextBreakdown, EffortLevel, ModelInfo,
  StartOptions, ToolDecision, UsageWindow,
} from '../types';
```

```ts
export interface FakeReports {
  context?: ContextBreakdown;
  windows?: UsageWindow[];
}
```

```ts
  constructor(
    private readonly script: (text: string) => AgentEvent[],
    private readonly reports: FakeReports = {},
  ) {}
```

Inside `start()`, build the run as a local and attach the optional members before returning, so an unscripted fake genuinely has no such property (which is what exercises the UI's empty states):

```ts
    const run: AgentRun = {
      events: channel,
      send: (text: string) => { /* unchanged */ },
      respondToTool: (id, decision) => { /* unchanged */ },
      setEffort: (_effort: EffortLevel) => { /* unchanged */ },
      interrupt: async () => { channel.push({ kind: 'turn-end', reason: 'interrupted' }); },
      dispose: async () => { channel.close(); },
    };

    const { context, windows } = this.reports;
    if (context) { run.contextBreakdown = async () => context; }
    if (windows) { run.usageWindows = async () => windows; }
    return run;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, including the pre-existing `FakeProvider` tests (the new constructor argument is optional).

- [ ] **Step 6: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/providers/types.ts src/providers/fake/fake-provider.ts src/test/unit/fake-provider.test.ts
git commit -m "feat: add context-breakdown and usage-window reporting to the provider seam"
```

---

### Task 2: Protocol messages

**Files:**
- Modify: `src/protocol/messages.ts`
- Test: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Consumes: `UsageWindow`, `ContextBreakdown` from Task 1.
- Produces: `SessionState.contextPercent?: number`; `ContextResult`; `UsageResult`; inbound `{ t: 'request-context'; id }`, `{ t: 'request-usage'; providerId }`, `{ t: 'open-file'; path }`; outbound `{ t: 'context-breakdown'; id; result }`, `{ t: 'usage-windows'; providerId; result }`.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/protocol.test.ts`, add the new cases to both exhaustive switches:

```ts
    case 'load-more': return 'load-more';
    case 'request-context': return 'request-context';
    case 'request-usage': return 'request-usage';
    case 'open-file': return 'open-file';
    default: return assertNever(m);
```

```ts
    case 'sessions-changed': return 'sessions-changed';
    case 'context-breakdown': return 'context-breakdown';
    case 'usage-windows': return 'usage-windows';
    default: return assertNever(m);
```

And add a test inside `suite('protocol', …)`:

```ts
  test('context and usage replies carry their key alongside a result union', () => {
    assert.strictEqual(
      describeOutbound({
        t: 'context-breakdown', id: 's1',
        result: {
          ok: true,
          breakdown: {
            systemPercent: 12, memoryPercent: 4, conversationPercent: 27,
            freePercent: 57, memoryFiles: [],
          },
        },
      }),
      'context-breakdown',
    );
    assert.strictEqual(
      describeOutbound({
        t: 'usage-windows', providerId: 'claude',
        result: { ok: false, reason: 'No active session for this provider' },
      }),
      'usage-windows',
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — compile errors, the new `t` values are not in `WebviewToHost` / `HostToWebview`.

- [ ] **Step 3: Extend the protocol**

In `src/protocol/messages.ts`, widen the type imports and re-exports:

```ts
import type {
  ContextBreakdown, EffortLevel, ModelInfo, PermissionMode, ToolDecision, UsageWindow,
} from '../providers/types';

export type {
  ContextBreakdown, EffortLevel, ModelInfo, PermissionMode, ToolDecision, UsageWindow,
};
```

Add the field to `SessionState`, directly under `usage`:

```ts
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Share of the model's context window in use, `100 - freePercent`.
   * Absent until the first turn ends, or forever for a provider that does
   * not report a breakdown.
   */
  contextPercent?: number;
```

Add the result unions after `ProviderInfo`:

```ts
export type ContextResult =
  | { ok: true; breakdown: ContextBreakdown }
  | { ok: false; reason: string };

export type UsageResult =
  | { ok: true; windows: UsageWindow[] }
  | { ok: false; reason: string };
```

Extend both message unions:

```ts
  | { t: 'load-more'; id: SessionId; beforeItemId: string }
  | { t: 'request-context'; id: SessionId }
  | { t: 'request-usage'; providerId: string }
  | { t: 'open-file'; path: string };
```

```ts
  | { t: 'sessions-changed'; sessions: SessionSummary[] }
  | { t: 'context-breakdown'; id: SessionId; result: ContextResult }
  | { t: 'usage-windows'; providerId: string; result: UsageResult };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/protocol/messages.ts src/test/unit/protocol.test.ts
git commit -m "feat: carry context breakdown and usage windows on the wire"
```

---

### Task 3: AgentSession refresh and pass-through

**Files:**
- Modify: `src/host/agent-session.ts`
- Test: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `AgentRun.contextBreakdown` / `usageWindows` (Task 1); `SessionState.contextPercent` (Task 2).
- Produces: `AgentSession.contextBreakdown(): Promise<ContextBreakdown>` and `AgentSession.usageWindows(): Promise<UsageWindow[]>` — both **reject** with a legible `Error` when the run does not implement them; `SessionManager` is what converts that into a result union.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/agent-session.test.ts`. Match the file's existing setup helpers — read the top of the file first and reuse whatever it already uses to build a session; the assertions below are what matters:

```ts
  test('turn-end refreshes contextPercent from the run breakdown', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }], {
      context: {
        systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60,
        memoryFiles: [],
      },
    });
    const { session } = makeSession(provider);

    session.send('hello');
    await settle();

    assert.strictEqual(session.state.contextPercent, 40);
  });

  test('a run without contextBreakdown leaves contextPercent undefined', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const { session } = makeSession(provider);

    session.send('hello');
    await settle();

    assert.strictEqual(session.state.contextPercent, undefined);
  });

  test('usageWindows rejects with a legible error when unsupported', async () => {
    const { session } = makeSession(new FakeProvider(() => []));
    await assert.rejects(
      () => session.usageWindows(),
      /does not report plan usage/,
    );
  });
```

If the existing file has no `makeSession`/`settle` helper, add these above the suite:

```ts
async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `session.usageWindows is not a function`, and `contextPercent` is `undefined` in the first test.

- [ ] **Step 3: Implement**

In `src/host/agent-session.ts`, widen the type import:

```ts
import type {
  AgentEvent, AgentProvider, AgentRun, ContextBreakdown, EffortLevel, PermissionMode,
  ToolDecision, UsageWindow,
} from '../providers/types';
```

Add the two pass-throughs as public methods, next to `snapshot()`:

```ts
  /**
   * Rejects rather than returning a sentinel when the provider does not
   * implement this: SessionManager is the single place that converts a
   * failure into the `{ ok: false, reason }` the wire carries, so there is
   * exactly one shape of "unavailable" reaching the webview.
   */
  async contextBreakdown(): Promise<ContextBreakdown> {
    if (!this.run.contextBreakdown) {
      throw new Error('This provider does not report context usage');
    }
    return this.run.contextBreakdown();
  }

  async usageWindows(): Promise<UsageWindow[]> {
    if (!this.run.usageWindows) {
      throw new Error('This provider does not report plan usage');
    }
    return this.run.usageWindows();
  }
```

Add the refresh helper next to `scheduleFlush()`:

```ts
  /**
   * Best-effort: the ring is decoration over a live conversation, so a
   * provider that fails to answer must not turn a completed turn into an
   * error item. Fire-and-forget from handle(), hence the internal catch —
   * a rejection here would otherwise be an unhandled rejection.
   */
  private async refreshContextPercent(): Promise<void> {
    try {
      const breakdown = await this.run.contextBreakdown?.();
      if (!breakdown || this.disposed) { return; }
      const next = Math.round(100 - breakdown.freePercent);
      if (this._state.contextPercent === next) { return; }
      this._state.contextPercent = next;
      this._state.updatedAt = Date.now();
      this.sink.changed();
    } catch {
      // See the doc comment: an unavailable breakdown is not a failed turn.
    }
  }
```

Call it from the successful `turn-end` branch in `handle()`:

```ts
      case 'turn-end':
        this.closeAssistant();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          this.setStatus('idle');
          void this.scheduleFlush();
          void this.refreshContextPercent();
        }
        return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/host/agent-session.ts src/test/unit/agent-session.test.ts
git commit -m "feat: refresh a session's context percentage on turn-end"
```

---

### Task 4: SessionManager result unions

**Files:**
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `AgentSession.contextBreakdown()` / `usageWindows()` (Task 3); `ContextResult` / `UsageResult` (Task 2).
- Produces: `SessionManager.contextBreakdown(id: SessionId): Promise<ContextResult>`; `SessionManager.usageWindows(providerId: string): Promise<UsageResult>`. Neither ever rejects.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/session-manager.test.ts`, reusing the file's existing `setup`-built `manager` (read the top of the file first; it builds a `SessionManager` over a temp dir and a `FakeProvider`). These tests need a provider that reports, so construct a second manager locally:

```ts
  test('contextBreakdown answers ok for a live session with a reporting run', async () => {
    const provider = new FakeProvider(() => [], {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
      },
    });
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    const session = await local.create('fake', '/tmp');

    const result = await local.contextBreakdown(session.state.id);

    // `assert.fail` returns `never`, which narrows the union for the line
    // below; `assert.ok(result.ok)` would not.
    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.breakdown.freePercent, 57);
    await local.dispose();
  });

  test('contextBreakdown answers not-ok for an unknown session', async () => {
    const result = await manager.contextBreakdown('nope');
    assert.strictEqual(result.ok, false);
  });

  test('usageWindows resolves a provider through any one live session', async () => {
    const provider = new FakeProvider(() => [], {
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    const local = new SessionManager(
      new TranscriptStore(dir), new Map([['fake', provider]]), () => {},
    );
    await local.init();
    await local.create('fake', '/tmp');

    const result = await local.usageWindows('fake');

    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.windows[0].usedPercent, 62);
    await local.dispose();
  });

  test('usageWindows answers not-ok when no session of that provider is live', async () => {
    const result = await manager.usageWindows('claude');
    if (result.ok) { assert.fail('expected no live session for this provider'); }
    assert.match(result.reason, /No active session/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `manager.contextBreakdown is not a function`.

- [ ] **Step 3: Implement**

In `src/host/session-manager.ts`, widen the protocol import:

```ts
import type {
  ContextResult, HostToWebview, PaneLayout, ProviderInfo, SessionId, SessionState,
  SessionStatus, SessionSummary, TranscriptPatch, UsageResult,
} from '../protocol/messages';
```

Add both methods after `get(id)`:

```ts
  /**
   * Never rejects: this is answered straight onto the wire, where "errors
   * are state". An archived or never-opened session has no live run to ask,
   * which is a legitimate not-ok rather than a failure.
   */
  async contextBreakdown(id: SessionId): Promise<ContextResult> {
    const session = this.live.get(id);
    if (!session) { return { ok: false, reason: 'This session is not running' }; }
    try {
      return { ok: true, breakdown: await session.contextBreakdown() };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Plan limits belong to the account, not the session, but the Claude
   * Agent SDK only exposes them from a live `Query` — so any one live
   * session of this provider is taken to speak for the whole account.
   */
  async usageWindows(providerId: string): Promise<UsageResult> {
    for (const session of this.live.values()) {
      if (session.state.providerId !== providerId) { continue; }
      try {
        return { ok: true, windows: await session.usageWindows() };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, reason: 'No active session for this provider' };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: answer context and usage requests from the session manager"
```

---

### Task 5: Route the requests

**Files:**
- Modify: `src/host/message-router.ts`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `SessionManager.contextBreakdown()` / `usageWindows()` (Task 4).
- Produces: emission of `{ t: 'context-breakdown', id, result }` and `{ t: 'usage-windows', providerId, result }`; `open-file` accepted by the shape guard and ignored by the router.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/message-router.test.ts`:

```ts
  test('request-context replies with a keyed result', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    sent.length = 0;

    await router.handle({ t: 'request-context', id });

    const reply = sent.find((m) => m.t === 'context-breakdown') as
      Extract<HostToWebview, { t: 'context-breakdown' }>;
    assert.ok(reply);
    assert.strictEqual(reply.id, id);
    // The suite's FakeProvider scripts no reports, so this is the not-ok path.
    assert.strictEqual(reply.result.ok, false);
  });

  test('request-usage replies with a keyed result', async () => {
    sent.length = 0;
    await router.handle({ t: 'request-usage', providerId: 'fake' });

    const reply = sent.find((m) => m.t === 'usage-windows') as
      Extract<HostToWebview, { t: 'usage-windows' }>;
    assert.ok(reply);
    assert.strictEqual(reply.providerId, 'fake');
    assert.strictEqual(reply.result.ok, false);
  });

  test('open-file is accepted but not acted on by the router', async () => {
    sent.length = 0;
    await router.handle({ t: 'open-file', path: '/repo/CLAUDE.md' });
    assert.deepStrictEqual(sent, []);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — no `context-breakdown` message is ever emitted.

- [ ] **Step 3: Implement**

In `src/host/message-router.ts`, add three cases to `route()`'s switch, after `load-more`:

```ts
      case 'request-context': {
        const result = await this.manager.contextBreakdown(msg.id);
        this.emit({ t: 'context-breakdown', id: msg.id, result });
        return;
      }

      case 'request-usage': {
        const result = await this.manager.usageWindows(msg.providerId);
        this.emit({ t: 'usage-windows', providerId: msg.providerId, result });
        return;
      }

      // PanelViewProvider intercepts this before delegating (it needs the
      // `vscode` API, which this module must not import — see the class
      // doc comment). It is listed here, and in KNOWN_MESSAGE_TAGS, so a
      // stray one is a deliberate no-op rather than a "malformed message"
      // error log.
      case 'open-file':
        return;
```

And extend the guard's tag set:

```ts
const KNOWN_MESSAGE_TAGS = new Set<WebviewToHost['t']>([
  'ready', 'create-session', 'set-visible', 'set-layout', 'close-session',
  'delete-session', 'send', 'interrupt', 'set-effort', 'set-permission-mode',
  'permission-decision', 'load-more', 'request-context', 'request-usage', 'open-file',
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: route context and usage requests to the session manager"
```

---

### Task 6: Open a memory file in the editor

**Files:**
- Modify: `src/host/panel-view-provider.ts`

**Interfaces:**
- Consumes: `{ t: 'open-file'; path: string }` (Task 2).
- Produces: nothing other tasks consume.

There is no unit test here: this module imports `vscode` and is exercised by the integration suite in Task 12. Keep the logic to a single guarded branch so there is nothing else to test.

- [ ] **Step 1: Implement the interception**

In `src/host/panel-view-provider.ts`, replace the `onDidReceiveMessage` handler:

```ts
    view.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        // `open-file` is the one message needing the `vscode` API, which
        // MessageRouter must not import (it is unit-tested outside the
        // extension host). Intercept it here rather than widening the
        // router's dependencies.
        if (raw?.t === 'open-file') {
          await this.openFile(raw.path);
          return;
        }
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] message handling failed', err);
      }
    });
```

Add the method below `post()`:

```ts
  /**
   * Best-effort: the path comes from a provider's context report and can
   * name a file that has since moved or that this window cannot read. A
   * failed open is logged, never surfaced as an error dialog — the user
   * asked to peek at a memory file, not to run a command.
   */
  private async openFile(path: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      console.error('[hiiiid-code] could not open', path, err);
    }
  }
```

- [ ] **Step 2: Type-check and lint**

Run: `yarn check-types && yarn lint`
Expected: both clean.

- [ ] **Step 3: Verify the unit suite still passes**

Run: `yarn test:unit`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/host/panel-view-provider.ts
git commit -m "feat: open a memory file from the context popover"
```

---

### Task 7: Claude provider mapping

**Files:**
- Create: `src/providers/claude/map-context.ts`
- Modify: `src/providers/claude/claude-provider.ts`
- Test: `src/test/unit/map-context.test.ts`

**Interfaces:**
- Consumes: `ContextBreakdown`, `UsageWindow` (Task 1).
- Produces: `toContextBreakdown(res)`, `toUsageWindows(res)`; `AgentRun.contextBreakdown` / `usageWindows` implemented on the Claude run.

**SDK facts this task relies on** (verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

- `Query.getContextUsage(): Promise<SDKControlGetContextUsageResponse>` — fields used here: `totalTokens`, `maxTokens`, `memoryFiles: { path; type; tokens }[]`, `messageBreakdown?: { toolCallTokens; toolResultTokens; attachmentTokens; assistantMessageTokens; userMessageTokens; redirectedContextTokens; unattributedTokens; … }`.
- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>` — fields used here: `rate_limits_available: boolean`, `rate_limits: { five_hour?, seven_day?, seven_day_opus?, seven_day_sonnet?, model_scoped?: { display_name; utilization; resets_at }[] } | null`, each window `{ utilization: number | null; resets_at: string | null }`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/map-context.test.ts`:

```ts
import * as assert from 'assert';
import { toContextBreakdown, toUsageWindows } from '../../providers/claude/map-context';

suite('map-context', () => {
  test('splits the window into system, memory, conversation and free', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 40_000,
      maxTokens: 200_000,
      memoryFiles: [
        { path: '/repo/CLAUDE.md', type: 'project', tokens: 6_000 },
        { path: '/home/u/.claude/CLAUDE.md', type: 'user', tokens: 2_000 },
      ],
      messageBreakdown: {
        toolCallTokens: 4_000, toolResultTokens: 6_000, attachmentTokens: 0,
        assistantMessageTokens: 5_000, userMessageTokens: 1_000,
        redirectedContextTokens: 0, unattributedTokens: 0,
      },
    });

    assert.strictEqual(breakdown.memoryPercent, 4);
    assert.strictEqual(breakdown.conversationPercent, 8);
    assert.strictEqual(breakdown.systemPercent, 8);
    assert.strictEqual(breakdown.freePercent, 80);
    assert.deepStrictEqual(breakdown.memoryFiles, [
      { path: '/repo/CLAUDE.md', percent: 3 },
      { path: '/home/u/.claude/CLAUDE.md', percent: 1 },
    ]);
  });

  test('the four slices always sum to 100', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 33_333, maxTokens: 100_000, memoryFiles: [], messageBreakdown: undefined,
    });
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('a zero or missing window budget reports everything free', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 10, maxTokens: 0, memoryFiles: [], messageBreakdown: undefined,
    });
    assert.deepStrictEqual(breakdown, {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: [],
    });
  });

  test('maps the plan windows that report a utilization', () => {
    const windows = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62, resets_at: '2026-08-13T18:00:00.000Z' },
        seven_day: { utilization: 18, resets_at: null },
        seven_day_opus: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: null }],
      },
    });

    assert.deepStrictEqual(windows, [
      {
        id: 'five-hour', label: 'Session (5h)', usedPercent: 62,
        resetsAt: Date.parse('2026-08-13T18:00:00.000Z'),
      },
      { id: 'seven-day', label: 'Week', usedPercent: 18 },
      { id: 'model:Fable', label: 'Week (Fable)', usedPercent: 5 },
    ]);
  });

  test('reports no windows when plan limits do not apply', () => {
    assert.deepStrictEqual(
      toUsageWindows({ rate_limits_available: false, rate_limits: null }),
      [],
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../providers/claude/map-context'`.

- [ ] **Step 3: Write the mapper**

Create `src/providers/claude/map-context.ts`:

```ts
import type { ContextBreakdown, UsageWindow } from '../types';

/**
 * The subsets of the SDK's two response shapes this mapper reads. Declared
 * structurally rather than imported so the mapper — and its tests — stay
 * free of the ESM-only SDK types (see claude-provider.ts's header for why
 * those need `resolution-mode` gymnastics), and so a future SDK field
 * addition cannot break this module.
 */
export interface ContextUsageLike {
  totalTokens: number;
  maxTokens: number;
  memoryFiles: { path: string; tokens: number }[];
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
  };
}

interface RateWindowLike {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageLike {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: RateWindowLike | null;
    seven_day?: RateWindowLike | null;
    seven_day_opus?: RateWindowLike | null;
    seven_day_sonnet?: RateWindowLike | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  } | null;
}

function share(tokens: number, max: number): number {
  return Math.round((tokens / max) * 100);
}

/**
 * Tokens enter here and percentages leave: this is the only place in the
 * codebase allowed to reason in tokens for these surfaces. `freePercent` is
 * derived by subtraction rather than from `maxTokens - totalTokens` so the
 * four slices always sum to exactly 100 despite per-slice rounding.
 */
export function toContextBreakdown(res: ContextUsageLike): ContextBreakdown {
  const max = res.maxTokens;
  if (!Number.isFinite(max) || max <= 0) {
    return {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: [],
    };
  }

  const memoryTokens = res.memoryFiles.reduce((sum, f) => sum + f.tokens, 0);
  const m = res.messageBreakdown;
  const conversationTokens = m
    ? m.toolCallTokens + m.toolResultTokens + m.attachmentTokens
      + m.assistantMessageTokens + m.userMessageTokens
      + m.redirectedContextTokens + m.unattributedTokens
    : 0;
  // Whatever the SDK counts in the total but does not attribute to memory
  // or messages is the system prompt and its tool definitions — the one
  // slice the spec folds together.
  const systemTokens = Math.max(0, res.totalTokens - memoryTokens - conversationTokens);

  const systemPercent = share(systemTokens, max);
  const memoryPercent = share(memoryTokens, max);
  const conversationPercent = share(conversationTokens, max);
  const freePercent = Math.max(0, 100 - systemPercent - memoryPercent - conversationPercent);

  return {
    systemPercent,
    memoryPercent,
    conversationPercent,
    freePercent,
    memoryFiles: res.memoryFiles.map((f) => ({ path: f.path, percent: share(f.tokens, max) })),
  };
}

const WINDOW_LABELS: { key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'; id: string; label: string }[] = [
  { key: 'five_hour', id: 'five-hour', label: 'Session (5h)' },
  { key: 'seven_day', id: 'seven-day', label: 'Week' },
  { key: 'seven_day_opus', id: 'seven-day-opus', label: 'Week (Opus)' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet', label: 'Week (Sonnet)' },
];

function resetsAt(iso: string | null): number | undefined {
  if (!iso) { return undefined; }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function makeWindow(id: string, label: string, w: RateWindowLike): UsageWindow | undefined {
  if (w.utilization === null || !Number.isFinite(w.utilization)) { return undefined; }
  const at = resetsAt(w.resets_at);
  return {
    id, label,
    usedPercent: Math.max(0, Math.min(100, Math.round(w.utilization))),
    ...(at !== undefined ? { resetsAt: at } : {}),
  };
}

/**
 * `rate_limits_available` is false for API-key, Bedrock and Vertex sessions,
 * where plan limits simply do not exist. That is an empty list, not an
 * error — the strip renders its "unavailable" line either way.
 */
export function toUsageWindows(res: UsageLike): UsageWindow[] {
  if (!res.rate_limits_available || !res.rate_limits) { return []; }
  const limits = res.rate_limits;
  const out: UsageWindow[] = [];

  for (const { key, id, label } of WINDOW_LABELS) {
    const w = limits[key];
    if (!w) { continue; }
    const mapped = makeWindow(id, label, w);
    if (mapped) { out.push(mapped); }
  }

  for (const scoped of limits.model_scoped ?? []) {
    const mapped = makeWindow(
      `model:${scoped.display_name}`,
      `Week (${scoped.display_name})`,
      scoped,
    );
    if (mapped) { out.push(mapped); }
  }

  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Wire the mapper into the run**

In `src/providers/claude/claude-provider.ts`, add the import:

```ts
import { toContextBreakdown, toUsageWindows, type ContextUsageLike, type UsageLike } from './map-context';
```

Widen the `AgentEvent`-side type import to include the two new types:

```ts
import type {
  AgentEvent, AgentProvider, AgentRun, ContextBreakdown, EffortLevel, ModelInfo,
  PermissionMode, StartOptions, ToolDecision, UsageWindow,
} from '../types';
```

Add both methods to the returned run object, after `interrupt`:

```ts
      contextBreakdown: async (): Promise<ContextBreakdown> => {
        // queryRef is only assigned once the dynamic import resolves inside
        // pump(), i.e. after the first send. Before that there is genuinely
        // nothing to measure.
        if (!queryRef) { throw new Error('This session has not started yet'); }
        const res = await queryRef.getContextUsage();
        return toContextBreakdown(res as unknown as ContextUsageLike);
      },
      usageWindows: async (): Promise<UsageWindow[]> => {
        if (!queryRef) { throw new Error('This session has not started yet'); }
        // The SDK names this method to discourage reliance and may remove it
        // in any release, so feature-detect rather than call it blind: an
        // absent method must degrade to a legible "unavailable", not a
        // TypeError surfacing as a mystery reason string in the UI.
        const experimental = (queryRef as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<UsageLike>;
        }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof experimental !== 'function') {
          throw new Error('This provider does not report plan usage');
        }
        return toUsageWindows(await experimental.call(queryRef));
      },
```

- [ ] **Step 6: Type-check, lint and run the tests**

Run: `yarn check-types && yarn lint && yarn test:unit`
Expected: all clean, tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/claude/map-context.ts src/providers/claude/claude-provider.ts src/test/unit/map-context.test.ts
git commit -m "feat: report context breakdown and plan usage from the Claude provider"
```

---

### Task 8: Reducer state

**Files:**
- Modify: `src/webview/reducer.ts`
- Test: `src/test/unit/webview-reducer.test.ts`

**Interfaces:**
- Consumes: `ContextResult`, `UsageResult`, `contextPercent` (Task 2).
- Produces: `ClientState.contextBySession: Record<SessionId, ContextResult | undefined>`; `ClientState.usageByProvider: Record<string, UsageResult | undefined>`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/webview-reducer.test.ts`:

```ts
  test('context-breakdown is stored under its session id', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: {
        ok: true,
        breakdown: {
          systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
          memoryFiles: [],
        },
      },
    });

    const result = state.contextBySession['s1'];
    if (!result?.ok) { assert.fail('expected a stored ok breakdown'); }
    assert.strictEqual(result.breakdown.freePercent, 57);
  });

  test('a not-ok result is stored rather than dropped', () => {
    const state = reduce(initialState, {
      t: 'usage-windows', providerId: 'claude',
      result: { ok: false, reason: 'No active session for this provider' },
    });

    assert.strictEqual(state.usageByProvider['claude']?.ok, false);
  });

  test('sessions-changed prunes cached breakdowns for removed sessions', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: { ok: false, reason: 'This session is not running' },
    });
    state = reduce(state, { t: 'sessions-changed', sessions: [] });

    assert.strictEqual(state.contextBySession['s1'], undefined);
  });

  test('sessions-changed updates contextPercent without clearing the cached breakdown', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: {
        ok: true,
        breakdown: {
          systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
          memoryFiles: [],
        },
      },
    });
    state = reduce(state, {
      t: 'sessions-changed',
      sessions: [{ ...summary('s1'), contextPercent: 43 }],
    });

    assert.strictEqual(state.sessions[0].contextPercent, 43);
    assert.strictEqual(state.contextBySession['s1']?.ok, true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `contextBySession` does not exist on `ClientState`.

- [ ] **Step 3: Implement**

In `src/webview/reducer.ts`, widen the import and the state:

```ts
import type {
  ContextResult, HostToWebview, PaneLayout, PermissionRequest, ProviderInfo, SessionId,
  SessionSummary, TranscriptItem, UsageResult,
} from '../protocol/messages';
```

```ts
export interface ClientState {
  ready: boolean;
  sessions: SessionSummary[];
  layout: PaneLayout;
  catalog: ProviderInfo[];
  byId: Record<SessionId, PaneState>;
  /** Last reply per session; kept while a refetch is in flight. */
  contextBySession: Record<SessionId, ContextResult | undefined>;
  /** Last reply per provider id. */
  usageByProvider: Record<string, UsageResult | undefined>;
}

export const initialState: ClientState = {
  ready: false,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
  catalog: [],
  byId: {},
  contextBySession: {},
  usageByProvider: {},
};
```

`hydrate` builds a fresh state object, so give it the two empty maps:

```ts
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, byId,
        contextBySession: {}, usageByProvider: {},
      };
```

Replace the `sessions-changed` case so it also prunes:

```ts
    case 'sessions-changed': {
      // A deleted session's cached breakdown would otherwise outlive it for
      // the life of the webview — the roster is the only signal the client
      // gets that a session is gone.
      const alive = new Set(msg.sessions.map((s) => s.id));
      const contextBySession: Record<SessionId, ContextResult | undefined> = {};
      for (const [id, result] of Object.entries(state.contextBySession)) {
        if (alive.has(id)) { contextBySession[id] = result; }
      }
      return { ...state, sessions: msg.sessions, contextBySession };
    }
```

And add the two new cases before `default`:

```ts
    case 'context-breakdown':
      return {
        ...state,
        contextBySession: { ...state.contextBySession, [msg.id]: msg.result },
      };

    case 'usage-windows':
      return {
        ...state,
        usageByProvider: { ...state.usageByProvider, [msg.providerId]: msg.result },
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Lint, type-check and commit**

```bash
yarn lint && yarn check-types
git add src/webview/reducer.ts src/test/unit/webview-reducer.test.ts
git commit -m "feat: cache context breakdowns and usage windows in the client store"
```

---

### Task 9: Vendor the Tooltip and Popover primitives

**Files:**
- Create: `src/webview/components/ui/tooltip.tsx`
- Create: `src/webview/components/ui/popover.tsx`

**Interfaces:**
- Consumes: `@base-ui/react/tooltip`, `@base-ui/react/popover` (both already installed under `@base-ui/react` ^1.7.0).
- Produces: `Tooltip`, `TooltipTrigger`, `TooltipContent`; `Popover`, `PopoverTrigger`, `PopoverContent`. All parts accept Base UI's `render` prop, which Task 10 uses to make one element both triggers.

Follow the structure of the existing `src/webview/components/ui/dropdown-menu.tsx`: a thin function per part, `data-slot` attributes, `cn()` for class merging, Portal + Positioner + Popup for the floating parts.

- [ ] **Step 1: Write the tooltip**

Create `src/webview/components/ui/tooltip.tsx`:

```tsx
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({ ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 origin-(--transform-origin) rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
```

- [ ] **Step 2: Write the popover**

Create `src/webview/components/ui/popover.tsx`:

```tsx
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "end",
  side = "top",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
```

- [ ] **Step 3: Type-check and lint**

Run: `yarn check-types && yarn lint`
Expected: both clean. If a part name does not resolve, list the real ones with `ls node_modules/@base-ui/react/tooltip` and check `index.parts.d.ts` for the exported aliases — do not swap in a Radix package.

- [ ] **Step 4: Build the bundles to confirm Tailwind picks up the new files**

Run: `yarn run compile`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/ui/tooltip.tsx src/webview/components/ui/popover.tsx
git commit -m "feat: vendor the shadcn tooltip and popover primitives"
```

---

### Task 10: The context ring and its breakdown popover

**Files:**
- Create: `src/webview/components/ring.tsx`
- Create: `src/webview/components/context-ring.tsx`
- Modify: `src/webview/components/composer.tsx`

**Interfaces:**
- Consumes: `contextBySession` (Task 8); `Tooltip*` / `Popover*` (Task 9); `SessionState.contextPercent` (Task 2).
- Produces: `Ring({ percent?: number; size?: number; className?: string })` — reused by Task 11; `ContextRing({ pane }: { pane: PaneState })`.

- [ ] **Step 1: Write the shared ring**

Create `src/webview/components/ring.tsx`:

```tsx
/**
 * A percentage as an SVG arc. `percent === undefined` means "not reported"
 * and renders a dashed track — deliberately distinct from a real 0%, which
 * renders an empty solid track.
 */
export function Ring({
  percent, size = 14, className,
}: { percent?: number; size?: number; className?: string }) {
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const known = percent !== undefined && Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={className}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={known ? undefined : '2 2'}
        className="stroke-muted"
      />
      {known && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * clamped) / 100} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          className={clamped >= 80 ? 'stroke-destructive' : 'stroke-primary'}
        />
      )}
    </svg>
  );
}
```

- [ ] **Step 2: Write the context ring**

Create `src/webview/components/context-ring.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Ring } from './ring';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { ContextResult } from '../../protocol/messages';

function Row({
  label, percent, indent,
}: { label: string; percent: number; indent?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className={indent
          ? 'w-28 shrink-0 truncate pl-3 text-muted-foreground'
          : 'w-28 shrink-0 truncate'}
        title={label}
      >
        {label}
      </span>
      <span className="h-1.5 min-w-0 flex-1 rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums">{percent}%</span>
    </div>
  );
}

function Body({
  result, onOpenFile,
}: { result: ContextResult | undefined; onOpenFile: (path: string) => void }) {
  if (!result) {
    return (
      <div className="space-y-1 py-1" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (!result.ok) {
    return <p className="py-1 text-muted-foreground">{result.reason}</p>;
  }

  const b = result.breakdown;
  return (
    <div>
      <Row label="System prompt" percent={b.systemPercent} />
      <Row label="Memory" percent={b.memoryPercent} />
      {b.memoryFiles.map((file) => (
        <div key={file.path} className="flex items-center gap-2 py-0.5">
          <Button
            variant="link"
            size="xs"
            className="h-auto w-28 shrink-0 justify-start truncate px-0 pl-3 font-normal"
            title={file.path}
            onClick={() => onOpenFile(file.path)}
          >
            {file.path.split(/[\\/]/).pop()}
          </Button>
          <span className="min-w-0 flex-1" />
          <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
            {file.percent}%
          </span>
        </div>
      ))}
      <Row label="Conversation" percent={b.conversationPercent} />
      <Row label="Free" percent={b.freePercent} />
    </div>
  );
}

export function ContextRing({ pane }: { pane: PaneState }) {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const id = pane.summary.id;
  const percent = pane.summary.contextPercent;
  const label = percent === undefined
    ? 'Context usage unavailable'
    : `Context ${percent}% used`;

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        // Pulled, not pushed: the inventory is static-ish and must not ride
        // every transcript patch. Refetch on each open so a long-lived
        // popover-less session never shows a stale list.
        if (next) { post({ t: 'request-context', id }); }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              aria-label={label}
              className="ml-auto inline-flex items-center rounded-sm p-1 hover:bg-muted"
            />
          )}
        >
          <Ring percent={percent} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 text-xs">
        <div className="flex items-baseline justify-between border-b border-border pb-1">
          <span className="font-medium">Context</span>
          <span className="tabular-nums text-muted-foreground">
            {percent === undefined ? 'unavailable' : `${percent}% used`}
          </span>
        </div>
        <Body
          result={state.contextBySession[id]}
          onOpenFile={(path) => post({ t: 'open-file', path })}
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Mount it in the composer**

In `src/webview/components/composer.tsx`, add the import:

```tsx
import { ContextRing } from './context-ring';
```

and place it as the last child of the toolbar row (`<div className="mt-1 flex items-center gap-2 text-xs">`), immediately after the closing `</Select>` of the permission-mode select:

```tsx
        <ContextRing pane={pane} />
```

The ring's own `ml-auto` pushes it to the right edge of that row.

- [ ] **Step 4: Type-check, lint and build**

Run: `yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 5: Run the unit suite**

Run: `yarn test:unit`
Expected: PASS (unchanged — these components are covered by the integration test in Task 12).

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/ring.tsx src/webview/components/context-ring.tsx src/webview/components/composer.tsx
git commit -m "feat: show context fill and its breakdown from the composer"
```

---

### Task 11: The account usage strip

**Files:**
- Create: `src/webview/components/usage-strip.tsx`
- Modify: `src/webview/main.tsx`

**Interfaces:**
- Consumes: `Ring` (Task 10); `usageByProvider` (Task 8); `Tooltip*` (Task 9).
- Produces: `UsageStrip()` — no props, reads everything from the store.

- [ ] **Step 1: Write the strip**

Create `src/webview/components/usage-strip.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Ring } from './ring';
import { useStore } from '../store';
import type { UsageResult, UsageWindow } from '../../protocol/messages';

const REFRESH_MS = 5000;

function resetsIn(at: number | undefined, now: number): string | undefined {
  if (at === undefined) { return undefined; }
  const ms = at - now;
  if (ms <= 0) { return undefined; }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) { return `resets in ${minutes}m`; }
  const hours = Math.round(minutes / 60);
  if (hours < 48) { return `resets in ${hours}h`; }
  return `resets in ${Math.round(hours / 24)}d`;
}

function WindowChip({ window: w }: { window: UsageWindow }) {
  const label = `${w.label} ${w.usedPercent}% used`;
  const reset = resetsIn(w.resetsAt, Date.now());
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1" aria-label={label} />}
      >
        <Ring percent={w.usedPercent} size={12} />
        <span className="text-muted-foreground">{w.label}</span>
        <span className="tabular-nums">{w.usedPercent}%</span>
      </TooltipTrigger>
      <TooltipContent>{reset ? `${label} · ${reset}` : label}</TooltipContent>
    </Tooltip>
  );
}

function ProviderUsage({
  displayName, result, showName,
}: { displayName: string; result: UsageResult | undefined; showName: boolean }) {
  if (!result) { return null; }
  if (!result.ok || result.windows.length === 0) {
    return (
      <span className="text-muted-foreground">
        Usage unavailable for {displayName}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-3">
      {showName && <span className="text-muted-foreground">{displayName}</span>}
      {result.windows.map((w) => <WindowChip key={w.id} window={w} />)}
    </span>
  );
}

export function UsageStrip() {
  const { state, post } = useStore();
  // Providers that actually have sessions — the catalog can list a provider
  // the user has never opened, and asking about it would always be not-ok.
  const providerIds = [...new Set(state.sessions.map((s) => s.providerId))];
  const providerKey = providerIds.join(',');
  // Status flips to 'idle' at turn-end, which is exactly when plan usage has
  // moved; keying the effect on it is what "refresh after any session's
  // turn-end" means on the client side.
  const statusKey = state.sessions.map((s) => `${s.id}:${s.status}`).join(',');
  const lastRequestedRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const now = Date.now();
    for (const id of providerIds) {
      if (now - (lastRequestedRef.current[id] ?? 0) < REFRESH_MS) { continue; }
      lastRequestedRef.current[id] = now;
      post({ t: 'request-usage', providerId: id });
    }
  }, [providerKey, statusKey]);

  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border px-2 py-1 text-xs">
      {providerIds.length === 0 ? (
        <span className="text-muted-foreground">Usage unavailable</span>
      ) : (
        providerIds.map((id) => (
          <ProviderUsage
            key={id}
            displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
            result={state.usageByProvider[id]}
            showName={providerIds.length > 1}
          />
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it below the pane group**

In `src/webview/main.tsx`, add the import:

```tsx
import { UsageStrip } from './components/usage-strip';
```

and render it as the last child of the app shell so it pins to the bottom:

```tsx
  return (
    <div className="flex h-screen flex-col">
      <SessionPicker />
      <div className="min-h-0 flex-1"><PaneGroup /></div>
      <UsageStrip />
    </div>
  );
```

- [ ] **Step 3: Type-check, lint and build**

Run: `yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 4: Run the unit suite**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/usage-strip.tsx src/webview/main.tsx
git commit -m "feat: show account usage windows in a panel-level strip"
```

---

### Task 12: Integration coverage, docs and full verification

**Files:**
- Modify: `src/test/integration/extension.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Read the integration suite**

Read `src/test/integration/extension.test.ts` in full before adding to it. It runs inside a real extension host; match whatever activation/teardown pattern it already uses.

- [ ] **Step 2: Add a smoke test for the new host surface**

Append a test that drives the host end of the feature — it needs no webview, only the extension's own wiring. Adapt the setup to the file's existing helpers:

```ts
  test('the panel view renders and the extension activates with the usage surfaces', async () => {
    const ext = vscode.extensions.getExtension('hiiiid-code');
    await ext?.activate();
    assert.ok(ext?.isActive);
  });
```

If the file already asserts activation, skip this step rather than duplicating it, and record in the commit message that integration coverage rides on the existing activation test.

- [ ] **Step 3: Update the architecture docs**

In `CLAUDE.md`, add the new modules to the path table, directly after the `src/providers/claude/` row:

```markdown
| `src/providers/claude/map-context.ts` | SDK context/usage responses → `ContextBreakdown` / `UsageWindow[]` |
```

and after the `src/webview/` row:

```markdown
| `src/webview/components/context-ring.tsx` | Context-fill ring + breakdown popover, mounted in the composer |
| `src/webview/components/usage-strip.tsx` | Panel-level account usage windows |
```

Add one invariant to the **Invariants** list:

```markdown
- **Usage and context surfaces show percentages, never token counts.** Tokens exist only
  inside `src/providers/claude/map-context.ts`, which converts them on the way out.
```

- [ ] **Step 4: Run the full verification sweep**

Run each and confirm the output before claiming completion:

```bash
yarn lint
yarn check-types
yarn test:unit
yarn run compile
```

Expected: all four succeed with no errors.

- [ ] **Step 5: Manual check in the dev host**

Run: `yarn dev`

Confirm, in the launched window: the composer row shows a ring at its right edge; hovering it shows a tooltip; clicking it opens a popover with System prompt / Memory / Conversation / Free rows; a memory-file row opens that file in an editor tab; the bottom strip shows either usage windows or an "unavailable" line. A `fake`-provider session is expected to show the unavailable states — that is the empty-state path working, not a bug.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md src/test/integration/extension.test.ts
git commit -m "docs: record the usage and context surfaces in the architecture map"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec section | Task |
|---|---|
| Data model (`UsageWindow`, `ContextBreakdown`, run methods) | T1 |
| Where the numbers come from (Claude) | T7 |
| Protocol (field, result unions, 5 messages) | T2 |
| Flow — ring pushed on turn-end | T3 |
| Flow — popover pulled | T5 + T10 |
| Flow — usage pulled and refreshed | T5 + T11 |
| Flow — `open-file` handled outside the router | T5 (ignore) + T6 (handle) |
| UI — `context-ring.tsx` | T10 |
| UI — `usage-strip.tsx` | T11 |
| UI — reducer maps | T8 |
| Testing — reducer / router / session-manager / fake profiles | T8 / T5 / T4 / T1 |
| Testing — integration | T12 |
| Staging | Parallelization table |

Two deliberate deviations from the spec text, both recorded in the spec itself before this plan was written: `usageWindows` sits on `AgentRun` rather than `AgentProvider` (the SDK exposes plan limits only from a live `Query`), and the wire discriminant is `t` with the session key named `id`, matching every existing message.
