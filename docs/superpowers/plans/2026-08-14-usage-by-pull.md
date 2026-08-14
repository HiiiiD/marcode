# Plan Usage by Pull — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the usage strip show real plan-usage percentages the moment the panel opens, keep them moving as the plan is consumed, and show one row per provider that can answer.

**Architecture:** Replace `rate_limit_event` as the *source* of usage with the SDK's `get_usage` control request, and demote the event to a *signal* that a pull is due. Three triggers: a session-free `probe()` at activation, the event itself, and turn end. The host's per-provider map, `usage.json` persistence and `hydrate` seeding are already correct and stay.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, mocha (`yarn test:unit`), mocha + jsdom (`yarn test:dom`), React 19, Tailwind v4.

**Spec:** [../specs/2026-08-14-usage-pull-design.md](../specs/2026-08-14-usage-pull-design.md)

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`. Neither does `src/host/message-router.ts`.
- **Errors are state, never exceptions.** No handler may leave an unhandled rejection.
- **Usage and context surfaces show percentages, never token counts.** Tokens exist only inside `src/providers/claude/map-context.ts`.
- Filenames are kebab-case.
- **No raw HTML controls in webview feature code** — shadcn from `@/components/ui/*`, classNames composed with `cn` from `@/lib/utils`.
- DOM tests drive components through the real `StoreProvider` via `sendFromHost`. Never mock `useStore`, never hand-build a `ClientState`.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before every commit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- The experimental identifier `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` must appear **exactly once** in the codebase, inside `ClaudeProvider`.

## Deviation from the spec

The spec's "Correctness fixes" section says to land the `resetsAt` seconds→ms fix and the `utilization` scale fix first, as their own commit. **This plan does not do that**, because both bugs live in `toUsageWindow`, which Task 5 deletes — fixing then deleting is wasted work with a wasted review cycle.

Instead the knowledge those bugs represent is pinned as **explicit assertions in Task 1's tests**: that the structured response's `utilization` is already 0–100 and must not be scaled, and that its `resets_at` is an ISO string yielding epoch **milliseconds**. Nothing regresses; the guard just lives in the code that survives.

No `usage.json` migration is needed either way — every window persisted under the old code carries a 1970 `resetsAt` and is pruned on read by `usageSnapshot()`.

## A note on test helpers

The test code below calls existing helpers by name — `makeSession`, `settle`,
`makeManager`, `makeManagerWithEmits`, `makeRouter`, `mountStrip`, `catalog()`,
`sendFromHost`. Their exact signatures are whatever the file already uses; the
plan assumes a shape (e.g. `makeManagerWithEmits({ providers })`) that may need
adapting when you open the file. **Read the surrounding tests first and match
them** — do not add a second harness alongside an existing one, and do not
change a helper's signature for one new test when an inline override will do.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/providers/claude/map-context.ts` | Modify | Add `toUsageWindows` (structured response → `UsageWindow[]`); later drop `toUsageWindow` + `RateLimitInfoLike` |
| `src/providers/types.ts` | Modify | `AgentProvider.fetchUsage?`, `AgentRun.usageWindows?`, `usage-window` → `usage-stale` |
| `src/providers/claude/claude-provider.ts` | Modify | `fetchUsage` via `probe()`; `usageWindows` via the live query |
| `src/providers/claude/map-events.ts` | Modify | `rate_limit_event` → `{ kind: 'usage-stale' }` |
| `src/providers/fake/fake-provider.ts` | Modify | Scripted `fetchUsage` / `usageWindows` |
| `src/host/agent-session.ts` | Modify | `SessionSink.usageWindows`; pull on `usage-stale` and turn end |
| `src/host/session-manager.ts` | Modify | `refreshUsage(cwd)`; whole-set merge; clear on `undefined` |
| `src/host/message-router.ts` | Modify | Call `refreshUsage` on `ready` |
| `src/webview/components/usage-strip.tsx` | Modify | Rows from `usageByProvider`; unmount when empty |

---

### Task 1: The structured-response mapper

**Files:**
- Modify: `src/providers/claude/map-context.ts`
- Test: `src/test/unit/map-context.test.ts`

**Interfaces:**
- Consumes: `UsageWindow` from `../types`; the existing `WINDOW_LABELS` table.
- Produces: `export interface UsageResponseLike`, `export function toUsageWindows(res: UsageResponseLike | undefined): UsageWindow[] | undefined`.

Additive only. `toUsageWindow` stays untouched and still compiles; Task 5 removes it.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/map-context.test.ts`:

```ts
suite('toUsageWindows', () => {
  test('maps a window, keeping utilization on its own 0-100 scale', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 62, resets_at: '2026-08-14T17:10:00Z' } },
    });
    assert.deepStrictEqual(out, [{
      id: 'five-hour',
      label: 'Session (5h)',
      usedPercent: 62,
      resetsAt: Date.parse('2026-08-14T17:10:00Z'),
    }]);
  });

  test('resets_at parses to epoch milliseconds, not seconds', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 10, resets_at: '2026-08-14T17:10:00Z' } },
    });
    // 1786727400000, not 1786727400 — a seconds value would be filtered as
    // already-reset by both windowsFor() and ProviderUsage.
    assert.strictEqual(out?.[0].resetsAt, 1786727400000);
  });

  test('rate_limits_available false is undefined, not an empty array', () => {
    // Distinct meanings: undefined is "this account has no plan limits at
    // all" (API key, Bedrock, Vertex) and clears persisted windows; [] is
    // "limits exist, nothing known yet" and does not.
    assert.strictEqual(
      toUsageWindows({ rate_limits_available: false, rate_limits: null }),
      undefined,
    );
  });

  test('available but null rate_limits is an empty array', () => {
    assert.deepStrictEqual(
      toUsageWindows({ rate_limits_available: true, rate_limits: null }),
      [],
    );
  });

  test('a null utilization drops that window but keeps its siblings', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null, resets_at: '2026-08-14T17:10:00Z' },
        seven_day: { utilization: 18, resets_at: '2026-08-20T00:00:00Z' },
      },
    });
    assert.deepStrictEqual(out?.map((w) => w.id), ['seven-day']);
  });

  test('a null resets_at yields a window with no reset time', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 5, resets_at: null } },
    });
    assert.strictEqual(out?.[0].resetsAt, undefined);
    assert.strictEqual(out?.[0].usedPercent, 5);
  });

  test('an unparseable resets_at yields a window with no reset time', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 5, resets_at: 'not-a-date' } },
    });
    assert.strictEqual(out?.[0].resetsAt, undefined);
  });

  test('unlabelled keys are ignored rather than guessed at', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 3, resets_at: null },
        seven_day_oauth_apps: { utilization: 99, resets_at: null },
      } as UsageResponseLike['rate_limits'],
    });
    assert.deepStrictEqual(out?.map((w) => w.id), ['five-hour']);
  });

  test('utilization is clamped to 0-100 and rounded once', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62.6, resets_at: null },
        seven_day: { utilization: 140, resets_at: null },
      },
    });
    assert.deepStrictEqual(out?.map((w) => w.usedPercent), [63, 100]);
  });

  test('an absent response is undefined', () => {
    assert.strictEqual(toUsageWindows(undefined), undefined);
  });
});
```

Add `toUsageWindows` and `UsageResponseLike` to the file's existing import from `../../providers/claude/map-context`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `toUsageWindows is not a function` / TS2305 on the import.

- [ ] **Step 3: Write the implementation**

Append to `src/providers/claude/map-context.ts`:

```ts
/**
 * The subset of `SDKControlGetUsageResponse` (sdk.d.ts:3351) this mapper
 * reads, declared structurally for the same reason `ContextUsageLike` is.
 *
 * Two traps, both proven live and both the reason this is a separate mapper
 * from `toUsageWindow`:
 *   - `resets_at` is an ISO 8601 string here. The `rate_limit_event` push
 *     carries epoch SECONDS under the same name. Neither is epoch ms.
 *   - `utilization` is already 0-100 here. The push's is a 0-1 fraction.
 *     Scaling this one would render 6200% for a 62% window.
 */
export interface UsageResponseLike {
  rate_limits_available?: boolean;
  rate_limits?: Partial<Record<
    'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet',
    { utilization?: number | null; resets_at?: string | null } | null
  >> | null;
}

/**
 * The structured usage response as an ordered window list.
 *
 * `undefined` is a positive answer — the account has no plan limits at all
 * (API key, Bedrock, Vertex, or a missing profile scope) — and callers clear
 * persisted state on it. `[]` means limits apply but nothing is known yet,
 * and clears nothing. A window the response cannot quantify is dropped
 * rather than rendered at a guessed percentage.
 */
export function toUsageWindows(res: UsageResponseLike | undefined): UsageWindow[] | undefined {
  if (!res || res.rate_limits_available !== true) { return undefined; }
  const limits = res.rate_limits;
  if (!limits) { return []; }

  const out: UsageWindow[] = [];
  // Driven by WINDOW_LABELS rather than by the response's own keys, so a key
  // this table has never heard of (seven_day_oauth_apps, and whatever a
  // future SDK adds) is ignored instead of rendered with a guessed label.
  for (const row of WINDOW_LABELS) {
    const window = limits[row.key];
    if (!window) { continue; }
    const { utilization } = window;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) { continue; }
    const parsed = window.resets_at ? Date.parse(window.resets_at) : NaN;
    out.push({
      id: row.id,
      label: row.label,
      usedPercent: Math.max(0, Math.min(100, Math.round(utilization))),
      ...(Number.isFinite(parsed) ? { resetsAt: parsed } : {}),
    });
  }
  return out;
}
```

`WINDOW_LABELS`' `key` field already carries exactly the four response keys this reads, so no table change is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, including the pre-existing `toUsageWindow` tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/claude/map-context.ts src/test/unit/map-context.test.ts
git commit -m "feat: map the structured usage response to windows

Separate mapper from toUsageWindow because the two sources disagree on
both fields that matter: resets_at is an ISO string here and epoch seconds
in the push, and utilization is 0-100 here and a 0-1 fraction there."
```

---

### Task 2: The provider seam

**Files:**
- Modify: `src/providers/types.ts`
- Test: `src/test/unit/protocol.test.ts` (type-level only — no runtime test; see Step 1)

**Interfaces:**
- Produces: `AgentProvider.fetchUsage?(cwd: string): Promise<UsageWindow[] | undefined>` and `AgentRun.usageWindows?(): Promise<UsageWindow[] | undefined>`.

Pure interface addition. Both members are optional, so nothing else breaks.

- [ ] **Step 1: Add the interface members**

There is no behavior to test here — these are optional members on an interface with no implementations yet. Tasks 3 and 4 supply the implementations *and* their tests. Adding a test that asserts an optional member is absent would pin the wrong thing.

In `src/providers/types.ts`, after `fetchModels?`:

```ts
  /**
   * Account/plan usage for a working directory, with NO session required.
   *
   * Optional: a provider whose backend has no plan limits (or cannot be
   * asked without a session) omits it entirely, and is then absent from the
   * usage strip rather than showing an empty row.
   *
   * `undefined` is a positive answer — this account has no plan limits at
   * all — and clears any persisted windows for the provider. `[]` means
   * limits apply but nothing is known yet, and clears nothing. Rejections
   * propagate; the caller decides retry policy.
   */
  fetchUsage?(cwd: string): Promise<UsageWindow[] | undefined>;
```

And on `AgentRun`, after `contextBreakdown?`:

```ts
  /**
   * Same contract as `AgentProvider.fetchUsage`, answered on this run's live
   * query — so the two live triggers (a `usage-stale` event, and turn end)
   * cost one control request each and never a new subprocess.
   */
  usageWindows?(): Promise<UsageWindow[] | undefined>;
```

- [ ] **Step 2: Verify the tree still type-checks**

Run: `yarn check-types && yarn lint`
Expected: both clean. Optional members added to an interface break no implementation.

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add the optional usage-pull seam to the provider interface"
```

---

### Task 3: `ClaudeProvider` answers both

**Files:**
- Modify: `src/providers/claude/claude-provider.ts`
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `toUsageWindows`, `UsageResponseLike` (Task 1); the seam from Task 2; the existing private `probe<T>(cwd, ask)`.
- Produces: `ClaudeProvider.fetchUsage(cwd)`, and `usageWindows()` on the object `start()` returns.

- [ ] **Step 1: Write the failing tests**

`src/test/unit/claude-provider.test.ts` already builds a `ClaudeProvider` with an injected fake `query` loader — follow the shape the existing `fetchModels` / `listInvocables` tests use for `closed`/`calls` bookkeeping rather than inventing a second harness.

```ts
test('fetchUsage issues the get_usage control request on a throwaway query', async () => {
  let closed = false;
  const provider = new ClaudeProvider(async () => (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 62, resets_at: '2026-08-14T17:10:00Z' } },
    }),
    close: () => { closed = true; },
  })) as never);

  const windows = await provider.fetchUsage('/repo');

  assert.deepStrictEqual(windows, [{
    id: 'five-hour', label: 'Session (5h)', usedPercent: 62,
    resetsAt: Date.parse('2026-08-14T17:10:00Z'),
  }]);
  assert.strictEqual(closed, true, 'the throwaway query must be closed');
});

test('fetchUsage closes the throwaway query even when the request rejects', async () => {
  let closed = false;
  const provider = new ClaudeProvider(async () => (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      throw new Error('control request failed');
    },
    close: () => { closed = true; },
  })) as never);

  await assert.rejects(() => provider.fetchUsage('/repo'));
  // A rejection that leaked the subprocess would leak one per activation,
  // for the life of the window.
  assert.strictEqual(closed, true);
});

test('fetchUsage reports undefined when the account has no plan limits', async () => {
  const provider = new ClaudeProvider(async () => (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      rate_limits_available: false, rate_limits: null,
    }),
    close: () => {},
  })) as never);

  assert.strictEqual(await provider.fetchUsage('/repo'), undefined);
});

test('usageWindows answers on the live query without constructing a second one', async () => {
  let constructed = 0;
  const provider = new ClaudeProvider(async () => ((() => {
    constructed += 1;
    return {
      [Symbol.asyncIterator]: async function* () { /* never yields */ },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 18, resets_at: null } },
      }),
      close: () => {},
    };
  }) as never));

  const run = provider.start({ cwd: '/repo' } as never);
  run.send('hello');            // lazy start: this is what builds the query
  const windows = await run.usageWindows?.();

  assert.deepStrictEqual(windows?.map((w) => w.id), ['seven-day']);
  assert.strictEqual(constructed, 1, 'must reuse the session query, not probe');
});

test('usageWindows before the first send resolves undefined rather than spawning', async () => {
  let constructed = 0;
  const provider = new ClaudeProvider(async () => ((() => {
    constructed += 1;
    return { close: () => {} };
  }) as never));

  const run = provider.start({ cwd: '/repo' } as never);

  // Lazy start is deliberate — a usage pull must not be the thing that
  // spawns a CLI for a session the user never sent to. The activation probe
  // already covers this case.
  assert.strictEqual(await run.usageWindows?.(), undefined);
  assert.strictEqual(constructed, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `provider.fetchUsage is not a function`, `run.usageWindows` undefined.

- [ ] **Step 3: Write the implementation**

In `src/providers/claude/claude-provider.ts`, extend the type the loader returns so the two new calls exist on `Query`, then add the provider method beside `fetchModels`:

```ts
  /**
   * Account plan usage for a working directory, with NO session required —
   * this is what lets the strip show real numbers at activation, before any
   * session exists and before anything is sent.
   *
   * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` is the
   * `get_usage` control request (sdk.d.ts:2521). The name is what it is;
   * this is the only place in the codebase that spells it, and it is what
   * Anthropic's own VS Code extension calls for the same data. The response
   * is read through `UsageResponseLike`, so a renamed or added field
   * degrades to "no windows" instead of throwing.
   *
   * Rejections propagate: SessionManager decides retry policy, and
   * swallowing here would hide a permanently broken CLI behind an empty
   * strip that looks exactly like "you have no plan limits".
   */
  async fetchUsage(cwd: string): Promise<UsageWindow[] | undefined> {
    return toUsageWindows(await this.probe(
      cwd,
      (q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ) as UsageResponseLike);
  }
```

Inside `start()`, add to the returned object:

```ts
      usageWindows: async (): Promise<UsageWindow[] | undefined> => {
        // Deliberately does NOT call ensureStarted(): a usage pull must never
        // be the thing that spawns a CLI subprocess for a session nobody has
        // sent to. Before the first send there is no query to ask, and the
        // activation probe already covers that case.
        if (!queryRef || disposed) { return undefined; }
        return toUsageWindows(
          await queryRef.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() as UsageResponseLike,
        );
      },
```

Import `toUsageWindows` and `type UsageResponseLike` from `./map-context`, and `UsageWindow` from `../types`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: pull plan usage from the claude provider

fetchUsage answers with no session via the existing throwaway probe, which
is what the strip needs at activation. usageWindows answers on the live
query and never constructs one, so a pull cannot spawn a CLI for a session
that was never sent to."
```

---

### Task 4: `FakeProvider` answers both

**Files:**
- Modify: `src/providers/fake/fake-provider.ts`
- Test: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: the seam from Task 2; the existing `FakeReports.windows`.
- Produces: `FakeProvider.fetchUsage(cwd)`, `run.usageWindows()`, `FakeProvider.fetchUsageCalls: string[]`, and `FakeReports.usageUnavailable?: boolean`.

The scripted `usage-window` push in `start()` stays for now — Task 6 removes it with the event variant.

- [ ] **Step 1: Write the failing tests**

```ts
test('fetchUsage reports the scripted windows and records the cwd', async () => {
  const windows = [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 40 }];
  const provider = new FakeProvider(() => [], { windows });

  assert.deepStrictEqual(await provider.fetchUsage('/repo'), windows);
  assert.deepStrictEqual(provider.fetchUsageCalls, ['/repo']);
});

test('fetchUsage reports undefined when scripted as having no plan limits', async () => {
  const provider = new FakeProvider(() => [], { usageUnavailable: true });
  assert.strictEqual(await provider.fetchUsage('/repo'), undefined);
});

test('fetchUsage reports an empty array when nothing is scripted', async () => {
  // Distinct from usageUnavailable: limits exist, nothing is known yet.
  const provider = new FakeProvider(() => []);
  assert.deepStrictEqual(await provider.fetchUsage('/repo'), []);
});

test('a run answers usageWindows with the same scripted set', async () => {
  const windows = [{ id: 'seven-day', label: 'Week', usedPercent: 12 }];
  const provider = new FakeProvider(() => [], { windows });
  const run = provider.start({ cwd: '/repo' } as never);

  assert.deepStrictEqual(await run.usageWindows?.(), windows);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `provider.fetchUsage is not a function`.

- [ ] **Step 3: Write the implementation**

Extend `FakeReports`:

```ts
export interface FakeReports {
  context?: ContextBreakdown;
  windows?: UsageWindow[];
  /**
   * Scripts the "this account has no plan limits at all" answer — the API
   * key / Bedrock / Vertex case — which is `undefined`, not `[]`. The two
   * are different instructions to the host: `undefined` clears persisted
   * windows, `[]` does not.
   */
  usageUnavailable?: boolean;
}
```

Add to the class:

```ts
  readonly fetchUsageCalls: string[] = [];

  async fetchUsage(cwd: string): Promise<UsageWindow[] | undefined> {
    this.fetchUsageCalls.push(cwd);
    return this.reports.usageUnavailable ? undefined : (this.reports.windows ?? []);
  }
```

And on the run object built in `start()`:

```ts
      usageWindows: async (): Promise<UsageWindow[] | undefined> =>
        (this.reports.usageUnavailable ? undefined : (this.reports.windows ?? [])),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/fake/fake-provider.ts src/test/unit/fake-provider.test.ts
git commit -m "test: script usage pulls on the fake provider"
```

---

### Task 5: Host plumbing — pull on a stale signal and at turn end

**Files:**
- Modify: `src/providers/types.ts` (add the `usage-stale` variant)
- Modify: `src/host/agent-session.ts`
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/agent-session.test.ts`, `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `AgentRun.usageWindows?` (Task 2).
- Produces: `AgentEvent` variant `{ kind: 'usage-stale' }`; `SessionSink.usageWindows(providerId: string, windows: UsageWindow[] | undefined): void`; `SessionManager.usageWindows(...)` implementing it.

Additive and non-breaking: `usage-window` and `SessionSink.usageWindow` both survive this task. Task 6 removes them. Splitting the cutover out is what keeps every commit green.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/agent-session.test.ts`:

```ts
test('a usage-stale event pulls the window set and reports it up', async () => {
  const windows = [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 55 }];
  const provider = new FakeProvider(() => [], { windows });
  const { session, sink } = makeSession(provider);   // existing helper

  provider.runs[0].emit({ kind: 'usage-stale' });
  await settle();                                     // existing helper

  assert.deepStrictEqual(sink.usageWindowSets, [{ providerId: 'fake', windows }]);
});

test('turn end pulls the window set', async () => {
  const windows = [{ id: 'seven-day', label: 'Week', usedPercent: 7 }];
  const provider = new FakeProvider(() => [], { windows });
  const { sink } = makeSession(provider);

  provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
  await settle();

  assert.deepStrictEqual(sink.usageWindowSets, [{ providerId: 'fake', windows }]);
});

test('a failing usage pull does not fail the turn', async () => {
  const provider = new FakeProvider(() => []);
  const { session, sink } = makeSession(provider);
  provider.runs[0].usageWindows = async () => { throw new Error('nope'); };

  provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
  await settle();

  // The strip is decoration over a live conversation. An unavailable pull is
  // a degraded strip, never an error item and never a status change.
  assert.strictEqual(session.state.status, 'idle');
  assert.deepStrictEqual(sink.usageWindowSets, []);
});

test('a provider that cannot report usage is simply never reported for', async () => {
  const provider = new FakeProvider(() => []);
  const { sink } = makeSession(provider);
  provider.runs[0].usageWindows = undefined;

  provider.runs[0].emit({ kind: 'usage-stale' });
  await settle();

  assert.deepStrictEqual(sink.usageWindowSets, []);
});
```

Add `usageWindowSets: { providerId: string; windows: UsageWindow[] | undefined }[]` to the test file's existing sink stub.

In `src/test/unit/session-manager.test.ts`:

```ts
test('a reported set replaces the provider set wholesale', async () => {
  const m = makeManager();                            // existing helper
  m.usageWindows('claude', [
    { id: 'five-hour', label: 'Session (5h)', usedPercent: 10 },
    { id: 'seven-day', label: 'Week', usedPercent: 4 },
  ]);
  m.usageWindows('claude', [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 12 }]);

  // Replacement, not upsert: a window the account stopped reporting must be
  // able to disappear. An upsert would strand 'seven-day' forever.
  assert.deepStrictEqual(m.usageSnapshot().claude.map((w) => w.id), ['five-hour']);
});

test('an identical set emits nothing', async () => {
  const { manager, emitted } = makeManagerWithEmits();
  const windows = [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 10 }];
  manager.usageWindows('claude', windows);
  const after = emitted().length;
  manager.usageWindows('claude', [...windows]);

  // The CLI re-announces on reconnect; re-rendering the strip for an
  // unchanged set is work for nothing.
  assert.strictEqual(emitted().length, after);
});

test('undefined clears the provider entirely and emits the clearance', () => {
  const { manager, emitted } = makeManagerWithEmits();
  manager.usageWindows('claude', [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 10 }]);
  manager.usageWindows('claude', undefined);

  // An account that moved from a subscription to an API key must not keep
  // showing its last subscription numbers forever.
  assert.deepStrictEqual(manager.usageSnapshot(), {});
  assert.deepStrictEqual(
    emitted().at(-1),
    { t: 'usage-windows', providerId: 'claude', windows: [] },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `m.usageWindows is not a function`; `sink.usageWindowSets` undefined.

- [ ] **Step 3: Write the implementation**

In `src/providers/types.ts`, add beside the existing `usage-window` variant:

```ts
  /**
   * The provider believes its plan usage has moved and a pull is due.
   *
   * Carries no data on purpose. `rate_limit_event`, which raises this, does
   * not populate a utilization percentage at steady state — reading values
   * off it is what made the strip permanently blank. The numbers come from
   * `AgentRun.usageWindows()`.
   */
  | { kind: 'usage-stale' }
```

In `src/host/agent-session.ts`, add to `SessionSink`:

```ts
  /**
   * A session pulled a whole window set for its provider. Keyed by provider,
   * not by session: plan limits belong to the account. A whole set, not one
   * window, because a pull is a snapshot — see SessionManager.usageWindows.
   */
  usageWindows(providerId: string, windows: UsageWindow[] | undefined): void;
```

Add the pull, modeled on the existing `refreshContextPercent`:

```ts
  /**
   * Best-effort, exactly like refreshContextPercent: the strip is decoration
   * over a live conversation, so a provider that cannot answer must not turn
   * a completed turn into an error item. Fire-and-forget from handle(),
   * hence the internal catch — a rejection here would otherwise be an
   * unhandled rejection.
   */
  private async refreshUsage(): Promise<void> {
    if (!this.run.usageWindows) { return; }
    try {
      const windows = await this.run.usageWindows();
      if (this.disposed) { return; }
      this.sink.usageWindows(this._state.providerId, windows);
    } catch {
      // See the doc comment: an unavailable pull is not a failed turn.
    }
  }
```

Add the case beside `usage-window`, and the call in the non-error `turn-end` branch beside `refreshContextPercent`:

```ts
      case 'usage-stale':
        void this.refreshUsage();
        return;
```

```ts
          void this.refreshContextPercent();
          void this.refreshUsage();
```

In `src/host/session-manager.ts`, add beside `usageWindow`:

```ts
  usageWindows(providerId: string, windows: UsageWindow[] | undefined): void {
    // A pull is a snapshot, so it REPLACES the provider's map rather than
    // upserting into it — that is what lets a window the account stopped
    // reporting actually disappear. (The old push carried one window at a
    // time and had to upsert; this does not.)
    const next = windows ?? [];
    const prev = this.windowsFor(providerId);
    const same = prev.length === next.length && prev.every((w, i) =>
      w.id === next[i]?.id
      && w.usedPercent === next[i]?.usedPercent
      && w.resetsAt === next[i]?.resetsAt);
    if (same && (windows !== undefined || !this.usage.has(providerId))) { return; }

    if (windows === undefined) {
      // A positive "this account has no plan limits". Drop the provider so a
      // subscription-to-API-key switch cannot keep showing stale numbers.
      this.usage.delete(providerId);
    } else {
      this.usage.set(providerId, new Map(orderWindows(windows).map((w) => [w.id, w])));
    }
    this.emit({ t: 'usage-windows', providerId, windows: this.windowsFor(providerId) });
    this.schedulePersist();
  }
```

`prev` is read through `windowsFor`, so the comparison runs against the same pruned, ordered list the strip receives — an expired window dropping out counts as a change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: all clean, including the untouched `usageWindow` tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/host/agent-session.ts src/host/session-manager.ts src/test/unit/agent-session.test.ts src/test/unit/session-manager.test.ts
git commit -m "feat: pull the window set on a stale signal and at turn end

A pull is a snapshot, so it replaces the provider's set rather than
upserting - which is what lets a window the account stopped reporting
disappear. undefined clears the provider outright."
```

---

### Task 6: Cut over and delete the push

**Files:**
- Modify: `src/providers/claude/map-events.ts`
- Modify: `src/providers/claude/map-context.ts` (delete `toUsageWindow`, `RateLimitInfoLike`)
- Modify: `src/providers/types.ts` (delete the `usage-window` variant)
- Modify: `src/providers/fake/fake-provider.ts` (delete the scripted push)
- Modify: `src/host/agent-session.ts`, `src/host/session-manager.ts` (delete `usageWindow`)
- Test: `src/test/unit/map-events.test.ts`, `src/test/unit/map-context.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: nothing new. This task only removes.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/map-events.test.ts`, replace the existing `rate_limit_event` tests with:

```ts
test('a rate_limit_event is a stale signal, whatever it carries', () => {
  // The real payload from a subscription account on 2026-08-14. It carries
  // no utilization at steady state, which is why nothing reads its values.
  assert.deepStrictEqual(
    mapEvent({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed', resetsAt: 1786727400, rateLimitType: 'five_hour',
        overageStatus: 'rejected', overageDisabledReason: 'out_of_credits',
        isUsingOverage: false,
      },
    }),
    [{ kind: 'usage-stale' }],
  );
});

test('a rate_limit_event with no info is still a stale signal', () => {
  assert.deepStrictEqual(mapEvent({ type: 'rate_limit_event' }), [{ kind: 'usage-stale' }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — mapEvent returns `[]` for the first case (no utilization) and `[]` for the second.

- [ ] **Step 3: Perform the cutover**

In `map-events.ts`, replace the whole `rate_limit_event` branch:

```ts
  if (type === 'rate_limit_event') {
    // A signal, not data. The CLI pushes this whenever rate-limit info
    // changes, which is exactly when a pull is worth making — but the
    // payload carries no utilization at steady state (only `status` is
    // required, sdk.d.ts:4421), and its `resetsAt` is epoch SECONDS while
    // its `utilization`, when present at all, is a 0-1 fraction. Both
    // disagree with the structured response the numbers actually come from.
    // Reading values off it is what left the strip permanently blank.
    return [{ kind: 'usage-stale' }];
  }
```

Then delete, in order:
- `toUsageWindow` and `RateLimitInfoLike` from `map-context.ts`, and their tests from `map-context.test.ts`
- the now-unused `toUsageWindow` / `RateLimitInfoLike` imports from `map-events.ts`
- `| { kind: 'usage-window'; window: UsageWindow }` from `AgentEvent`
- `case 'usage-window':` from `agent-session.ts`
- `usageWindow(providerId, window)` from `SessionSink` and from `SessionManager`, plus its tests
- the `for (const window of windows ?? [])` push loop in `fake-provider.ts`'s `start()`

Update `map-events.ts`'s header comment block, which currently documents `rate_limit_event` as mapping through `toUsageWindow`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: all clean. `check-types` failing here means a `usage-window` consumer was missed — that is the point of doing the deletion as its own task.

- [ ] **Step 5: Commit**

```bash
git add -A src/providers src/host src/test/unit
git commit -m "refactor: demote rate_limit_event from data to a stale signal

It carries no utilization at steady state, so everything built to read
values off it was building windows out of nothing. Deletes toUsageWindow,
RateLimitInfoLike, the usage-window event and the usageWindow sink method."
```

---

### Task 7: Pull at activation

**Files:**
- Modify: `src/host/session-manager.ts`
- Modify: `src/host/message-router.ts:84`
- Test: `src/test/unit/session-manager.test.ts`, `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `AgentProvider.fetchUsage?` (Task 2), `SessionManager.usageWindows` (Task 5).
- Produces: `SessionManager.refreshUsage(cwd: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/session-manager.test.ts`:

```ts
test('refreshUsage probes every provider that can answer and emits per provider', async () => {
  const { manager, emitted } = makeManagerWithEmits();   // existing helper
  await manager.refreshUsage('/repo');

  assert.deepStrictEqual(
    emitted().filter((m) => m.t === 'usage-windows').map((m) => m.providerId),
    ['fake'],
  );
});

test('refreshUsage does not reject when a provider probe fails', async () => {
  const provider = new FakeProvider(() => []);
  provider.fetchUsage = async () => { throw new Error('CLI is broken'); };
  const manager = makeManager({ providers: new Map([['fake', provider]]) });

  // Errors are state, never exceptions: a broken CLI leaves the strip as it
  // was, and must never surface as a rejection at activation.
  await assert.doesNotReject(() => manager.refreshUsage('/repo'));
});

test('refreshUsage emits nothing when no provider can answer', async () => {
  const provider = new FakeProvider(() => []);
  delete (provider as { fetchUsage?: unknown }).fetchUsage;
  const { manager, emitted } = makeManagerWithEmits({
    providers: new Map([['fake', provider]]),
  });

  await manager.refreshUsage('/repo');
  assert.deepStrictEqual(emitted().filter((m) => m.t === 'usage-windows'), []);
});
```

In `src/test/unit/message-router.test.ts`, extend the existing `ready` test:

```ts
test('ready kicks off a usage refresh alongside the model refresh', async () => {
  const { router, manager } = makeRouter();            // existing helper
  router.handle({ t: 'ready' });
  await settle();

  assert.deepStrictEqual(manager.refreshUsageCalls, ['/default/cwd']);
});
```

Add `refreshUsageCalls: string[]` to that file's existing manager stub.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `manager.refreshUsage is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/host/session-manager.ts`, directly after `refreshModels`:

```ts
  /**
   * Asks every provider that can answer for its account's plan usage, with
   * no session required. Fire-and-forget by design, exactly like
   * refreshModels: this is what puts real percentages in the strip at
   * activation, and nothing — least of all panel startup — may wait on a CLI
   * handshake for decoration.
   *
   * One emit per provider rather than one at the end, unlike refreshModels:
   * the wire message is per-provider, so there is no whole-set message to
   * batch into, and a fast provider should not wait behind a slow one.
   */
  async refreshUsage(cwd: string): Promise<void> {
    await Promise.all([...this.providers.values()]
      .filter((p) => p.fetchUsage)
      .map((p) => p.fetchUsage!(cwd).then(
        (windows) => { if (!this.disposed) { this.usageWindows(p.id, windows); } },
        (err: unknown) => {
          // Errors are state, never exceptions — and the state here is
          // "whatever the last pull or the persisted file said still
          // stands". Worth a developer-facing trace: a permanently broken
          // CLI would otherwise be indistinguishable from an account that
          // genuinely has no plan limits.
          console.warn('[hiiiid-code] session-manager: usage probe failed for', p.id, err);
        },
      )));
  }
```

In `src/host/message-router.ts`, beside the existing call at line 84:

```ts
        void this.manager.refreshModels(this.defaultCwd);
        void this.manager.refreshUsage(this.defaultCwd);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/host/session-manager.ts src/host/message-router.ts src/test/unit/session-manager.test.ts src/test/unit/message-router.test.ts
git commit -m "feat: pull plan usage at activation

A session-free probe per provider on ready, so the strip carries real
percentages before any session exists and before anything is sent."
```

---

### Task 8: The strip follows usage, not sessions

**Files:**
- Modify: `src/webview/components/usage-strip.tsx`
- Test: `src/test/dom/usage-strip.test.tsx`

**Interfaces:**
- Consumes: `ClientState.usageByProvider` (unchanged), `state.catalog` for display names.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Replace the three `Plan usage not reported` assertions in `src/test/dom/usage-strip.test.tsx` — they now assert absence — and add the new cases:

```ts
test('a provider with usage but no session is shown', () => {
  const { container } = mountStrip();
  sendFromHost({
    t: 'usage-windows', providerId: 'other',
    windows: [{ id: 'seven-day', label: 'Week', usedPercent: 18, resetsAt: Date.now() + 60_000 }],
  });

  // Usage belongs to the account, not to an open conversation. A second
  // subscription is real whether or not a session for it is open right now.
  assert.ok(screen.getByLabelText('Week 18% used'));
  assert.ok(container.querySelector('div'));
});

test('a provider with a session but no usage is absent', () => {
  const { container } = mountStrip();   // seeds a 'fake' session, no windows

  assert.strictEqual(screen.queryByText(/Plan usage not reported/), null);
  // An API-key provider can never report. A permanent row it can never fill
  // is noise no action clears, so the strip does not render one.
  assert.strictEqual(container.textContent, '');
});

test('the strip unmounts entirely when nothing reports', () => {
  const { container } = mountStrip();
  assert.strictEqual(container.querySelector('div'), null);
});

test('an expired-only provider drops out of the strip', () => {
  const { container } = mountStrip();
  sendFromHost({
    t: 'usage-windows', providerId: 'fake',
    windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1 }],
  });

  assert.strictEqual(container.querySelector('div'), null);
});

test('two reporting providers are each labelled', () => {
  mountStrip();
  sendFromHost({
    t: 'usage-windows', providerId: 'fake',
    windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 10, resetsAt: Date.now() + 60_000 }],
  });
  sendFromHost({
    t: 'usage-windows', providerId: 'other',
    windows: [{ id: 'seven-day', label: 'Week', usedPercent: 20, resetsAt: Date.now() + 60_000 }],
  });

  assert.ok(screen.getByText('Fake'));
  assert.ok(screen.getByText('Other'));
});
```

The two-provider test needs `other` in the hydrated catalog; the file's existing `catalog()` helper already models that in its last test — reuse it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:dom`
Expected: FAIL — the strip still renders its bordered bar and the "not reported" rows.

- [ ] **Step 3: Write the implementation**

Replace `UsageStrip` in `src/webview/components/usage-strip.tsx`:

```tsx
export function UsageStrip() {
  const { state } = useStore();
  // Providers that have actually reported, NOT providers that have sessions.
  // Usage belongs to the account: a second subscription is worth showing
  // with no session open, and an API-key provider can never report at all,
  // so a row for it would be permanent noise no action can clear.
  const now = Date.now();
  const reporting = Object.entries(state.usageByProvider)
    .filter(([, windows]) =>
      windows?.some((w) => w.resetsAt === undefined || w.resetsAt > now))
    .map(([id]) => id);

  // Unmounted, not empty: an empty bordered bar is permanent chrome for a
  // state that never has content. The panel's bottom edge shifts when the
  // first pull lands, which is the correct trade in a 300-500px sidebar.
  if (reporting.length === 0) { return null; }

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-x-auto overflow-y-hidden border-t border-border px-2 text-xs">
      {reporting.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          windows={state.usageByProvider[id]}
          showName={reporting.length > 1}
        />
      ))}
    </div>
  );
}
```

`ProviderUsage` and its empty branch are **kept unchanged**. The `resetsAt > now` filter runs per render, so a provider can empty out between the parent's filter and the child's — the branch must not crash even though a rendered strip no longer reaches it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:dom && yarn test:unit && yarn check-types && yarn lint`
Expected: all clean.

- [ ] **Step 5: Run the mechanical UI detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/usage-strip.tsx`
Expected: exit 0. Exit 2 is a failing check, not a suggestion — fix the findings before committing.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/usage-strip.tsx src/test/dom/usage-strip.test.tsx
git commit -m "feat: show usage per reporting provider and hide the empty strip

Rows follow usage rather than sessions, so a subscription is visible with
no session open and an API-key provider is absent rather than showing a
row no action can ever fill."
```

---

### Task 9: Update the project docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-08-14-push-fed-usage.md` (status note only)

- [ ] **Step 1: Update the architecture table**

`CLAUDE.md`'s table currently says of `src/providers/claude/map-context.ts`: *"SDK context response → `ContextBreakdown`; one `rate_limit_event` → one `UsageWindow`"*. That second clause is now false. Replace with:

```
| `src/providers/claude/map-context.ts` | SDK context response → `ContextBreakdown`; structured usage response → `UsageWindow[]` |
```

Add to the Invariants list:

```
- **Plan usage is pulled, never read off `rate_limit_event`.** That event does
  not carry a utilization percentage at steady state; it is a signal that a
  pull is due. Numbers come from `AgentProvider.fetchUsage` (no session) or
  `AgentRun.usageWindows` (live query).
```

- [ ] **Step 2: Mark the superseded plan**

Add under the title of `docs/superpowers/plans/2026-08-14-push-fed-usage.md`:

```markdown
> **Superseded 2026-08-14** by
> [../specs/2026-08-14-usage-pull-design.md](../specs/2026-08-14-usage-pull-design.md).
> This plan's push-fed architecture was built on `rate_limit_event`, which does
> not carry a utilization percentage at steady state — so the strip it produced
> was permanently blank on a real subscription account.
```

- [ ] **Step 3: Verify the whole suite**

Run: `yarn test:unit && yarn test:dom && yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-08-14-push-fed-usage.md
git commit -m "docs: record that plan usage is pulled, not pushed"
```

---

## Manual verification

Automated tests cannot prove the SDK actually answers, since every test injects a fake query. After Task 9, confirm against the real CLI:

1. `F5` → Extension Development Host, on a Claude subscription account.
2. **Before opening any session**, the strip shows real percentages within a second or two of the panel loading. This is the activation probe, and it is the requirement none of the previous architecture could meet.
3. Send a message. The percentage moves (or stays put, if the turn was small) without a reload.
4. Reload the window. Numbers reappear immediately from `usage.json`, before any pull lands.
5. Check the Extension Host output channel for `usage probe failed` — there should be none.
