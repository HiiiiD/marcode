# Invocable Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `/` autocomplete menu in the composer listing every skill and slash command available in the session's working directory, working from the moment the session exists — before its first message.

**Architecture:** The catalog belongs to a working directory, not a session. A host-side `CatalogService` probes each `providerId + cwd` at most once through a new optional `AgentProvider.listInvocables(cwd)`, caches the answer in memory, and fans it out to every session on that key. A live `invocables` event from any running session refreshes the same entry. The webview stores it per pane and renders one menu over one pure logic module.

**Tech Stack:** TypeScript, esbuild (CJS host + IIFE webview), React 19, Tailwind v4, vendored shadcn/ui primitives on Base UI, lucide-react, Mocha `--ui tdd` run from source through `tsx/cjs` (`yarn test:unit`), Mocha + jsdom + Testing Library (`yarn test:dom`), `@anthropic-ai/claude-agent-sdk` 0.3.228.

**Spec:** [docs/superpowers/specs/2026-08-13-invocable-catalog-design.md](../specs/2026-08-13-invocable-catalog-design.md)

## Global Constraints

- **No new dependencies.** Not for fuzzy matching, not for virtualization, not for positioning. The 50-row cap exists so no windowing library is needed; `InputGroupAddon align="block-start"` exists so no popover positioning is needed.
- **No persistence.** The catalog never reaches `TranscriptStore`, `StoredIndex`, or `SessionState`. A window reload re-probes.
- **Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts` imports `vscode`.** `CatalogService` is host code but must stay `vscode`-free so it unit-tests.
- **Every protocol message addressed to a session carries an explicit `SessionId`**, even though the catalog is keyed by cwd. The wire has no implicit current session.
- **Errors are state, never exceptions.** A failed probe caches nothing, surfaces nothing, and is retried by the next session on that cwd.
- **shadcn only.** No raw `<button>`/`<input>`/`<textarea>` in feature code; compose classNames with `cn` from `@/lib/utils`, never template literals.
- **Filenames kebab-case**, component identifiers PascalCase.
- **DOM tests drive components through the real `StoreProvider`**, with state delivered as genuine `HostToWebview` messages via `sendFromHost` and assertions reading `posted()`. Never mock `useStore`, never hand-build a `ClientState`.
- **`INVOCABLE_MENU_WINDOW = 50`** is the single named constant governing rendered rows.
- **Verify before claiming done:** `yarn check-types`, `yarn lint`, `yarn test:unit`, `yarn test:dom` all pass before each commit.
- **After any change under `src/webview/components/`, run the impeccable detector** over the changed files: `node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json <files>`. Exit 0 is required.

## What changed since the first draft of this plan

Read this before starting: the codebase moved under the earlier version.

1. **The Claude query is constructed lazily, on first `send()`** ([claude-provider.ts](../../../src/providers/claude/claude-provider.ts)), because only construction can set `bypass`. `Query.supportedCommands()` therefore cannot answer for a session that has not sent anything — hence the probe in Task 2.
2. **A DOM test harness exists** (`src/test/dom/`). UI work is tested, not hand-verified.
3. **Tests run from source** through `tsx/cjs`. There is no `out/` build step for tests.
4. **The composer was rebuilt** on `InputGroup` / `InputGroupTextarea` / `InputGroupAddon` with lucide icons, and its addon row already `flex-wrap`s at 300px.
5. **The header count pill is cut.** The menu is the only surface.

---

### Task 1: Seam types and provider capability

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/fake/fake-provider.ts`
- Modify: `src/protocol/messages.ts`
- Test: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Invocable` — `{ name: string; description?: string; origin?: string; argHint?: string }` in `src/providers/types.ts`, re-exported from `src/protocol/messages.ts`.
  - `AgentEvent` variant `{ kind: 'invocables'; entries: Invocable[] }`.
  - `AgentProvider.listInvocables?(cwd: string): Promise<Invocable[]>`.
  - `SessionSnapshot.invocables?: Invocable[]`.
  - `HostToWebview` variant `{ t: 'session-invocables'; id: SessionId; entries: Invocable[] }`.
  - `FakeProvider.runs: FakeRun[]` where `FakeRun = AgentRun & { emit(event: AgentEvent): void }`.
  - `FakeProvider.invocables: Invocable[] | Error | undefined` and `FakeProvider.listInvocablesCalls: string[]` — the scripted probe answer and its call log.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/fake-provider.test.ts`:

```ts
test('a run can emit events outside of send()', async () => {
  const provider = new FakeProvider(() => []);
  provider.start({ cwd: '/tmp', permissionMode: 'default' });
  const run = provider.runs[0];

  run.emit({ kind: 'invocables', entries: [{ name: 'init' }] });
  const first = await run.events[Symbol.asyncIterator]().next();

  assert.deepStrictEqual(first.value, { kind: 'invocables', entries: [{ name: 'init' }] });
});

test('listInvocables answers with the scripted catalog and logs its cwd', async () => {
  const provider = new FakeProvider(() => []);
  provider.invocables = [{ name: 'brainstorming', description: 'Design first' }];

  const out = await provider.listInvocables('/repo');

  assert.deepStrictEqual(out, [{ name: 'brainstorming', description: 'Design first' }]);
  assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
});

test('listInvocables rejects when scripted with an error', async () => {
  const provider = new FakeProvider(() => []);
  provider.invocables = new Error('no catalog');

  await assert.rejects(() => provider.listInvocables('/repo'), /no catalog/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "invocables"`
Expected: FAIL — `run.emit is not a function`, `provider.listInvocables is not a function`.

- [ ] **Step 3: Add the type and the two seam members**

In `src/providers/types.ts`, after `ModelInfo`:

```ts
/**
 * One thing the user can invoke by typing `/name`: a skill or a slash
 * command. Providers report these as one undifferentiated list — the SDK has
 * no discriminator — so there is deliberately no `kind` field.
 */
export interface Invocable {
  /** Verbatim from the provider. This is what gets inserted into the composer. */
  name: string;
  /** One line, rendered as the row's second line. */
  description?: string;
  /** Plugin/namespace prefix derived from a `prefix:leaf` name. Display only. */
  origin?: string;
  /** e.g. '[interval] [prompt]'. Rendered as ghost text after insertion. */
  argHint?: string;
}
```

Extend `AgentEvent`:

```ts
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  /** Full replacement list, not a delta. Emitted whenever the provider notices a change. */
  | { kind: 'invocables'; entries: Invocable[] };
```

Extend `AgentProvider`:

```ts
export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): ModelInfo[];
  start(opts: StartOptions): AgentRun;
  /**
   * The catalog for a working directory, with NO session required.
   *
   * Optional because a provider may not be able to answer without one. It
   * exists because the Claude provider constructs its query lazily on the
   * first send() (only construction can set `bypass`), so the session's own
   * query cannot answer for a composer that has not been used yet — which is
   * exactly when the menu is wanted.
   */
  listInvocables?(cwd: string): Promise<Invocable[]>;
}
```

- [ ] **Step 4: Widen the protocol**

In `src/protocol/messages.ts`: add `Invocable` to the type import from `../providers/types` and to the re-export; add the snapshot field and the host message.

```ts
export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
  /**
   * The cwd's catalog, when the host has one. In-memory host state: absent
   * before the probe resolves, and absent forever if it failed.
   */
  invocables?: Invocable[];
}
```

```ts
  | { t: 'session-invocables'; id: SessionId; entries: Invocable[] }
```

- [ ] **Step 5: Script the fake provider**

In `src/providers/fake/fake-provider.ts`:

```ts
/** An `AgentRun` a test can push arbitrary events into. */
export type FakeRun = AgentRun & { emit(event: AgentEvent): void };

export class FakeProvider implements AgentProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  /** Records every decision passed to respondToTool, for assertions. */
  readonly decisions = new Map<string, ToolDecision>();
  /**
   * Every run started by this provider, newest last. A real provider emits
   * events without the user having sent anything; tests need a handle to
   * do the same.
   */
  readonly runs: FakeRun[] = [];
  /** Every cwd listInvocables() was called with, in order. */
  readonly listInvocablesCalls: string[] = [];
  /** Scripted probe answer: a catalog to resolve with, or an Error to reject with. */
  invocables: Invocable[] | Error | undefined;
  private sessionCounter = 0;
```

Add the method:

```ts
  async listInvocables(cwd: string): Promise<Invocable[]> {
    this.listInvocablesCalls.push(cwd);
    if (this.invocables instanceof Error) { throw this.invocables; }
    return this.invocables ?? [];
  }
```

In `start()`, build the run as a `FakeRun` with `emit: (event) => { channel.push(event); }`, push it onto `this.runs`, and return it. Keep every existing behaviour — the `turn-end` pushed from `respondToTool` and its comment stay exactly as they are.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add src/providers src/protocol/messages.ts src/test/unit/fake-provider.test.ts
git commit -m "feat: add the invocable seam type and provider catalog capability"
```

---

### Task 2: CatalogService — probe once per cwd, cache, fan out

**Files:**
- Create: `src/host/catalog-service.ts`
- Create: `src/test/unit/catalog-service.test.ts`

**Interfaces:**
- Consumes: `AgentProvider.listInvocables`, `Invocable` (Task 1).
- Produces:
  - `catalogKey(providerId: string, cwd: string): string`
  - `class CatalogService`
    - `constructor(onEntries: (key: string, entries: Invocable[]) => void)`
    - `get(key: string): Invocable[] | undefined`
    - `set(key: string, entries: Invocable[]): void` — records a live event and notifies
    - `ensure(key: string, provider: AgentProvider, cwd: string): void` — fire-and-forget probe, at most once per key

This is the task the whole feature turns on: it is what makes a menu exist before a first message, and it holds every caching rule in one `vscode`-free, fully testable place.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/catalog-service.test.ts`:

```ts
import * as assert from 'assert';
import { CatalogService, catalogKey } from '../../host/catalog-service';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { Invocable } from '../../providers/types';

/** The probe is fire-and-forget; let its promise chain drain before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function recorder() {
  const seen: { key: string; entries: Invocable[] }[] = [];
  return { seen, onEntries: (key: string, entries: Invocable[]) => { seen.push({ key, entries }); } };
}

suite('CatalogService', () => {
  test('probes once per key and caches the answer', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [{ name: 'init' }];
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    service.ensure(key, provider, '/repo');
    await settle();
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
    assert.deepStrictEqual(service.get(key), [{ name: 'init' }]);
    assert.strictEqual(seen.length, 1);
  });

  test('a different cwd is a different key and probes again', async () => {
    const { onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [{ name: 'init' }];

    service.ensure(catalogKey('fake', '/a'), provider, '/a');
    service.ensure(catalogKey('fake', '/b'), provider, '/b');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/a', '/b']);
  });

  test('an empty catalog is a real answer and is cached', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [];
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    await settle();
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(service.get(key), []);
    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
    assert.strictEqual(seen.length, 1);
  });

  test('a failed probe caches nothing, notifies nothing, and is retried', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = new Error('nope');
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    await settle();

    assert.strictEqual(service.get(key), undefined);
    assert.strictEqual(seen.length, 0);

    provider.invocables = [{ name: 'init' }];
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo', '/repo']);
    assert.deepStrictEqual(service.get(key), [{ name: 'init' }]);
  });

  test('a provider without listInvocables is not an error', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    delete (provider as { listInvocables?: unknown }).listInvocables;
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    await settle();

    assert.strictEqual(service.get(key), undefined);
    assert.strictEqual(seen.length, 0);
  });

  test('set() records a live event and notifies', () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const key = catalogKey('fake', '/repo');

    service.set(key, [{ name: 'fresh' }]);

    assert.deepStrictEqual(service.get(key), [{ name: 'fresh' }]);
    assert.deepStrictEqual(seen, [{ key, entries: [{ name: 'fresh' }] }]);
  });

  test('a key survives a cwd containing the separator', () => {
    assert.notStrictEqual(catalogKey('fake', 'a'), catalogKey('fak', 'ea'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "CatalogService"`
Expected: FAIL — `Cannot find module '../../host/catalog-service'`.

- [ ] **Step 3: Write the service**

Create `src/host/catalog-service.ts`:

```ts
import type { AgentProvider, Invocable } from '../providers/types';

/**
 * A catalog belongs to a working directory, not a session: skills resolve
 * from the filesystem and the user's config, so two sessions on the same repo
 * see the same list. The provider id is part of the key because two providers
 * in the same directory are two different catalogs.
 *
 * '\u0000' as the separator: it cannot appear in a path or a provider id, so
 * no pair of inputs can collide by concatenation.
 */
export function catalogKey(providerId: string, cwd: string): string {
  return `${providerId}\u0000${cwd}`;
}

export class CatalogService {
  private readonly cache = new Map<string, Invocable[]>();
  private readonly inflight = new Set<string>();

  /**
   * @param onEntries Called whenever a key acquires or replaces its catalog.
   *   The manager fans this out to every session sharing the key.
   */
  constructor(private readonly onEntries: (key: string, entries: Invocable[]) => void) {}

  get(key: string): Invocable[] | undefined {
    return this.cache.get(key);
  }

  /** Records a catalog learned from a live session's `invocables` event. */
  set(key: string, entries: Invocable[]): void {
    this.cache.set(key, entries);
    this.onEntries(key, entries);
  }

  /**
   * Probes this key's catalog unless it is already known or in flight.
   * Fire-and-forget by design: no caller waits on a catalog, and a session
   * must never be delayed by one.
   */
  ensure(key: string, provider: AgentProvider, cwd: string): void {
    if (this.cache.has(key) || this.inflight.has(key)) { return; }
    if (!provider.listInvocables) { return; }

    this.inflight.add(key);
    void provider.listInvocables(cwd)
      .then((entries) => { this.set(key, entries); })
      .catch(() => {
        // Errors are state, never exceptions — and here the state is simply
        // "no catalog". Nothing is cached, so the next session created on
        // this cwd retries. A catalog that will not load leaves the composer
        // as plain text; there is nothing the user could act on.
      })
      .finally(() => { this.inflight.delete(key); });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS, all 7 new tests included.

- [ ] **Step 5: Commit**

```bash
git add src/host/catalog-service.ts src/test/unit/catalog-service.test.ts
git commit -m "feat: cache each working directory's invocable catalog"
```

---

### Task 3: Wire the catalog through session and manager

**Files:**
- Modify: `src/host/agent-session.ts`
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/agent-session.test.ts`, `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `CatalogService`, `catalogKey` (Task 2); the `invocables` event and `session-invocables` message (Task 1).
- Produces:
  - `SessionSink.invocables(id: SessionId, entries: Invocable[]): void` — a session reporting a catalog **upward**, so the manager can cache and fan out.
  - `AgentSession.setInvocables(entries: Invocable[]): void` — the manager pushing a catalog **down** into a session, for its snapshot.
  - `AgentSession.snapshot()` includes `invocables`.

The two directions are deliberately different methods. A single one would recurse: a session reporting an event would be told the same entries back by the fan-out it triggered.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/agent-session.test.ts` (extend the file's existing recording sink with an `invocables` array):

```ts
test('an invocables event is reported to the sink', async () => {
  const { provider, sink } = makeSession();

  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'init' }] });
  await settle();

  assert.deepStrictEqual(sink.invocables, [[{ name: 'init' }]]);
});

test('setInvocables lands in the snapshot and replaces wholesale', async () => {
  const { session } = makeSession();

  session.setInvocables([{ name: 'a' }, { name: 'b' }]);
  session.setInvocables([{ name: 'c' }]);

  assert.deepStrictEqual((await session.snapshot()).invocables, [{ name: 'c' }]);
});

test('a session told nothing has no invocables in its snapshot', async () => {
  const { session } = makeSession();

  assert.strictEqual((await session.snapshot()).invocables, undefined);
});
```

In `src/test/unit/session-manager.test.ts`:

```ts
test('creating a session probes its cwd and emits the catalog to a visible pane', async () => {
  const { manager, provider, emitted } = await makeManager();
  provider.invocables = [{ name: 'init' }];

  const session = await manager.create('fake', '/repo');
  await manager.setVisible([session.state.id]);
  await settle();

  assert.deepStrictEqual(
    emitted.filter((m) => m.t === 'session-invocables'),
    [{ t: 'session-invocables', id: session.state.id, entries: [{ name: 'init' }] }],
  );
});

test('a second session on the same cwd reuses the cached catalog', async () => {
  const { manager, provider } = await makeManager();
  provider.invocables = [{ name: 'init' }];

  const first = await manager.create('fake', '/repo');
  await settle();
  const second = await manager.create('fake', '/repo');
  await settle();

  assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
  assert.deepStrictEqual((await first.snapshot()).invocables, [{ name: 'init' }]);
  assert.deepStrictEqual((await second.snapshot()).invocables, [{ name: 'init' }]);
});

test('a live invocables event refreshes every session on that cwd', async () => {
  const { manager, provider } = await makeManager();
  provider.invocables = [{ name: 'stale' }];
  const first = await manager.create('fake', '/repo');
  const second = await manager.create('fake', '/repo');
  await settle();

  // The event arrives on the FIRST session's run; the second must learn it too.
  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'fresh' }] });
  await settle();

  assert.deepStrictEqual((await first.snapshot()).invocables, [{ name: 'fresh' }]);
  assert.deepStrictEqual((await second.snapshot()).invocables, [{ name: 'fresh' }]);
});

test('a hidden session gets no session-invocables message', async () => {
  const { manager, provider, emitted } = await makeManager();
  provider.invocables = [{ name: 'init' }];

  await manager.create('fake', '/repo');
  await settle();

  assert.deepStrictEqual(emitted.filter((m) => m.t === 'session-invocables'), []);
});

test('an archived pane is served the cwd catalog from cache', async () => {
  const { manager, provider, emitted } = await makeManager();
  provider.invocables = [{ name: 'init' }];
  const session = await manager.create('fake', '/repo');
  const id = session.state.id;
  await settle();
  await manager.close(id);
  emitted.length = 0;

  await manager.setVisible([id]);
  await settle();

  const snap = emitted.find((m) => m.t === 'session-snapshot');
  assert.deepStrictEqual(snap?.session.invocables, [{ name: 'init' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "invocables|catalog"`
Expected: FAIL — `session.setInvocables is not a function`, no `session-invocables` emitted.

- [ ] **Step 3: Extend AgentSession**

In `src/host/agent-session.ts`, add to `SessionSink`:

```ts
  /**
   * A running session reported its catalog. Goes UP to the manager, which
   * owns the per-cwd cache and the fan-out; it is not this session's answer
   * alone.
   */
  invocables(id: SessionId, entries: Invocable[]): void;
```

Add the field, the setter, and the event case:

```ts
  /**
   * The cwd catalog as last told to us by the manager. Held only so
   * snapshot() can carry it; this session is not its owner.
   */
  private invocableEntries: Invocable[] | undefined;
```

```ts
  setInvocables(entries: Invocable[]): void {
    // Replace wholesale: the catalog is always a full list.
    this.invocableEntries = entries;
  }
```

```ts
      case 'invocables':
        this.sink.invocables(this._state.id, event.entries);
        return;
```

and include it in `snapshot()`'s returned object as `invocables: this.invocableEntries`.

Note `setInvocables` does not emit. The manager emits, because it is the only one that knows which sessions share the key and which of them are visible.

- [ ] **Step 4: Extend SessionManager**

In `src/host/session-manager.ts`:

```ts
  private readonly catalog = new CatalogService(
    (key, entries) => { this.fanOutCatalog(key, entries); },
  );
```

Add a key helper and the fan-out:

```ts
  private keyOf(state: SessionState): string {
    return catalogKey(state.providerId, state.cwd);
  }

  /**
   * Pushes a catalog to every session on this key — live or not — and emits
   * it to the visible ones. Meta, not `live`, is the roster: a session that
   * is not materialized still needs its snapshot to carry the catalog when
   * it is next revealed.
   */
  private fanOutCatalog(key: string, entries: Invocable[]): void {
    for (const state of this.meta.values()) {
      if (this.keyOf(state) !== key) { continue; }
      this.live.get(state.id)?.setInvocables(entries);
      if (this.visible.has(state.id)) {
        this.emit({ t: 'session-invocables', id: state.id, entries });
      }
    }
  }
```

Call `ensure` wherever a session becomes live, in `create()` and `open()`, after the session is registered in `this.meta`/`this.live` — order matters, because `ensure` can resolve synchronously-enough that the fan-out must already find the session:

```ts
    this.catalog.ensure(this.keyOf(state), provider, state.cwd);
```

Seed a newly created or opened session from the cache, so a second session on a known cwd needs no round trip:

```ts
    const cached = this.catalog.get(this.keyOf(state));
    if (cached) { session.setInvocables(cached); }
```

Implement the sink method — a session reporting upward:

```ts
  invocables(id: SessionId, entries: Invocable[]): void {
    const state = this.meta.get(id);
    if (!state) { return; }
    // Cache under the cwd key and fan out. The reporting session gets the
    // entries back through the same fan-out as its siblings, so there is one
    // path, not two.
    this.catalog.set(this.keyOf(state), entries);
  }
```

In `setVisible()`, carry the catalog on the disk-served snapshot for a non-live session:

```ts
      const { items, hasMore } = await this.store.tail(id);
      this.emit({
        t: 'session-snapshot',
        session: {
          ...state, items, hasMore, pending: [],
          invocables: this.catalog.get(this.keyOf(state)),
        },
      });
```

Import `CatalogService` and `catalogKey` from `./catalog-service`, and `Invocable` from `../providers/types`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host src/test/unit/agent-session.test.ts src/test/unit/session-manager.test.ts
git commit -m "feat: fan a working directory's catalog out to its sessions"
```

---

### Task 4: Claude provider — probe and live refresh

**Files:**
- Create: `src/providers/claude/map-commands.ts`
- Create: `src/test/unit/map-commands.test.ts`
- Modify: `src/providers/claude/map-events.ts`
- Modify: `src/providers/claude/claude-provider.ts`
- Test: `src/test/unit/map-events.test.ts`, `src/test/unit/claude-provider.test.ts` (create if the repo has no provider test yet)

**Interfaces:**
- Consumes: `Invocable` (Task 1).
- Produces: `toInvocables(commands: unknown): Invocable[]` from `src/providers/claude/map-commands.ts`; `ClaudeProvider.listInvocables(cwd)`.

**SDK facts** (verified 2026-08-13 against `@anthropic-ai/claude-agent-sdk@0.3.228` by reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

```ts
type SlashCommand = {
  name: string;          // no leading slash
  description: string;
  argumentHint: string;  // may be ''
  aliases?: string[];    // ignored — see the spec
};
Query.supportedCommands(): Promise<SlashCommand[]>;
Query.close(): void;
type SDKCommandsChangedMessage = {
  type: 'system'; subtype: 'commands_changed'; commands: SlashCommand[];
  uuid: UUID; session_id: string;
};
```

- [ ] **Step 1: Write the failing mapper tests**

Create `src/test/unit/map-commands.test.ts`:

```ts
import * as assert from 'assert';
import { toInvocables } from '../../providers/claude/map-commands';

suite('map-commands', () => {
  test('maps name, description and argument hint', () => {
    const out = toInvocables([
      { name: 'loop', description: 'Run a prompt on an interval', argumentHint: '[interval]' },
    ]);

    assert.deepStrictEqual(out, [
      { name: 'loop', description: 'Run a prompt on an interval', argHint: '[interval]' },
    ]);
  });

  test('an empty argument hint becomes absent, not blank', () => {
    const out = toInvocables([{ name: 'init', description: 'Init', argumentHint: '' }]);

    assert.strictEqual('argHint' in out[0], false);
  });

  test('a plugin-qualified name yields an origin and keeps its full name', () => {
    const out = toInvocables([
      { name: 'superpowers:brainstorming', description: 'Design first', argumentHint: '' },
    ]);

    assert.strictEqual(out[0].name, 'superpowers:brainstorming');
    assert.strictEqual(out[0].origin, 'superpowers');
  });

  test('only the first colon splits the origin', () => {
    const out = toInvocables([{ name: 'a:b:c', description: '', argumentHint: '' }]);

    assert.strictEqual(out[0].origin, 'a');
    assert.strictEqual(out[0].name, 'a:b:c');
  });

  test('an unqualified name has no origin, and a leading colon is not an origin', () => {
    const out = toInvocables([
      { name: 'init', description: '', argumentHint: '' },
      { name: ':weird', description: '', argumentHint: '' },
    ]);

    assert.strictEqual(out[0].origin, undefined);
    assert.strictEqual(out[1].origin, undefined);
  });

  test('an empty description becomes absent', () => {
    const out = toInvocables([{ name: 'init', description: '', argumentHint: '' }]);

    assert.strictEqual('description' in out[0], false);
  });

  test('non-array input and unusable entries are dropped, not thrown on', () => {
    assert.deepStrictEqual(toInvocables(undefined), []);
    assert.deepStrictEqual(toInvocables('nope'), []);
    assert.deepStrictEqual(toInvocables([null, 7, { description: 'no name' }, { name: '' }]), []);
  });
});
```

Add to `src/test/unit/map-events.test.ts`:

```ts
test('a commands_changed message becomes an invocables event', () => {
  const out = mapEvent({
    type: 'system', subtype: 'commands_changed',
    commands: [{ name: 'init', description: 'Init', argumentHint: '' }],
    uuid: 'u', session_id: 's',
  });

  assert.deepStrictEqual(out, [
    { kind: 'invocables', entries: [{ name: 'init', description: 'Init' }] },
  ]);
});

test('a commands_changed message with an empty list emits an empty snapshot', () => {
  const out = mapEvent({
    type: 'system', subtype: 'commands_changed', commands: [], uuid: 'u', session_id: 's',
  });

  assert.deepStrictEqual(out, [{ kind: 'invocables', entries: [] }]);
});

test('other system subtypes still map to nothing', () => {
  assert.deepStrictEqual(mapEvent({ type: 'system', subtype: 'status', session_id: 's' }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "map-commands|commands_changed"`
Expected: FAIL — `Cannot find module '../../providers/claude/map-commands'`.

- [ ] **Step 3: Write the mapper**

Create `src/providers/claude/map-commands.ts`:

```ts
// SDK surface verified against @anthropic-ai/claude-agent-sdk@0.3.228 on
// 2026-08-13 by reading node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
//
//   type SlashCommand = {
//     name: string;          // no leading slash
//     description: string;
//     argumentHint: string;  // may be ''
//     aliases?: string[];
//   };
//
// Skills and slash commands arrive in ONE list with no discriminator, which
// is why `Invocable` has no `kind`. `aliases` is deliberately ignored: the
// spec defers it rather than doubling the menu with entries that do the same
// thing.
//
// Input is typed `unknown` on purpose. It arrives either from a control
// response or from a `system` message off the wire; nothing here should throw
// on a shape the installed SDK version does not actually produce.
import type { Invocable } from '../types';

export function toInvocables(commands: unknown): Invocable[] {
  if (!Array.isArray(commands)) { return []; }

  const out: Invocable[] = [];
  for (const raw of commands) {
    if (typeof raw !== 'object' || raw === null) { continue; }
    const { name, description, argumentHint } = raw as {
      name?: unknown; description?: unknown; argumentHint?: unknown;
    };
    if (typeof name !== 'string' || name.length === 0) { continue; }

    const entry: Invocable = { name };
    if (typeof description === 'string' && description.length > 0) {
      entry.description = description;
    }
    // '' is the SDK's "no hint", and ghost text must be absent rather than
    // an empty span the composer still has to clear.
    if (typeof argumentHint === 'string' && argumentHint.length > 0) {
      entry.argHint = argumentHint;
    }
    const origin = originOf(name);
    if (origin) { entry.origin = origin; }
    out.push(entry);
  }
  return out;
}

/**
 * `superpowers:brainstorming` -> `superpowers`. Only the first colon splits,
 * and a leading colon is not an origin (there is no prefix before it). The
 * name itself is never rewritten — it is what gets inserted into the composer.
 */
function originOf(name: string): string | undefined {
  const at = name.indexOf(':');
  return at > 0 ? name.slice(0, at) : undefined;
}
```

- [ ] **Step 4: Map the push message**

In `src/providers/claude/map-events.ts`, replace the `system` branch:

```ts
  if (type === 'system') {
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype === 'commands_changed') {
      // A full replacement list, which is exactly our snapshot contract —
      // no diffing, and an empty array is a legitimate "none available".
      return [{
        kind: 'invocables',
        entries: toInvocables((msg as { commands?: unknown }).commands),
      }];
    }
    if (subtype !== 'init') { return []; }
    const sessionId = (msg as { session_id?: string }).session_id;
    return sessionId ? [{ kind: 'session', resumeToken: sessionId }] : [];
  }
```

Add `import { toInvocables } from './map-commands';`.

- [ ] **Step 5: Write the probe test**

The provider already isolates query construction behind an injectable `QueryFn` (`new ClaudeProvider(fakeLoadQuery)`), which is what makes this testable without a subprocess. Add to `src/test/unit/claude-provider.test.ts`, following the file's existing fake-query harness if one is present:

```ts
test('listInvocables constructs a query, reads the catalog and closes it', async () => {
  let closed = false;
  let constructedCwd: string | undefined;
  const provider = new ClaudeProvider(async () => (params) => {
    constructedCwd = params.options.cwd;
    return {
      supportedCommands: async () => [
        { name: 'init', description: 'Init', argumentHint: '' },
      ],
      close: () => { closed = true; },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    } as unknown as Query;
  });

  const out = await provider.listInvocables('/repo');

  assert.deepStrictEqual(out, [{ name: 'init', description: 'Init' }]);
  assert.strictEqual(constructedCwd, '/repo');
  assert.strictEqual(closed, true, 'the probe query must not outlive the answer');
});

test('listInvocables closes the query even when the catalog read fails', async () => {
  let closed = false;
  const provider = new ClaudeProvider(async () => () => ({
    supportedCommands: async () => { throw new Error('control request failed'); },
    close: () => { closed = true; },
    [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
  } as unknown as Query));

  await assert.rejects(() => provider.listInvocables('/repo'), /control request failed/);
  assert.strictEqual(closed, true);
});
```

- [ ] **Step 6: Implement the probe**

In `src/providers/claude/claude-provider.ts`, add the method to `ClaudeProvider`:

```ts
  /**
   * The cwd's catalog, with no session. Constructs a throwaway query over a
   * prompt stream that never yields, asks it for the command list, and closes
   * it. Nothing is ever sent, so there is no turn, no tokens and no agent
   * work — only the CLI's init handshake.
   *
   * This exists because the session's own query is constructed lazily on the
   * first send() (only construction can set `bypass`), and the menu has to
   * work before that first message — creating a session in order to run a
   * slash command is the primary case, not an edge one.
   *
   * Rejections propagate: CatalogService decides the retry policy, and
   * swallowing here would hide a permanently broken CLI behind an empty menu.
   */
  async listInvocables(cwd: string): Promise<Invocable[]> {
    const query = await this.loadQueryFn();
    // A channel that is closed immediately: the query needs an async iterable
    // for `prompt`, and this one ends without ever yielding a message.
    const prompts = new Channel<SDKUserMessage>();
    prompts.close();
    const probe = query({ prompt: prompts, options: { cwd } });
    try {
      return toInvocables(await probe.supportedCommands());
    } finally {
      // finally, not a success-path close: a failed control request must not
      // leak a CLI subprocess for the life of the window.
      try {
        probe.close();
      } catch {
        // Best-effort: the probe is being discarded regardless.
      }
    }
  }
```

Add `toInvocables` to the imports and `Invocable` to the type imports from `../types`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/providers/claude src/test/unit
git commit -m "feat: probe a working directory's skills and slash commands"
```

---

### Task 5: Webview reducer stores the catalog per pane

**Files:**
- Modify: `src/webview/reducer.ts`
- Test: `src/test/unit/webview-reducer.test.ts`

**Interfaces:**
- Consumes: `SessionSnapshot.invocables`, the `session-invocables` message (Task 1).
- Produces: `PaneState.invocables?: Invocable[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/webview-reducer.test.ts`:

```ts
test('a snapshot carries invocables onto the pane', () => {
  const state = reduce(initialState, {
    t: 'session-snapshot',
    session: { ...snapshot('s1'), invocables: [{ name: 'init' }] },
  });

  assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'init' }]);
});

test('session-invocables replaces the pane list wholesale', () => {
  let state = reduce(initialState, {
    t: 'session-snapshot',
    session: { ...snapshot('s1'), invocables: [{ name: 'a' }, { name: 'b' }] },
  });
  state = reduce(state, { t: 'session-invocables', id: 's1', entries: [{ name: 'c' }] });

  assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'c' }]);
});

test('session-invocables for an unknown pane is a no-op', () => {
  const state = reduce(initialState, {
    t: 'session-invocables', id: 'nope', entries: [{ name: 'a' }],
  });

  assert.deepStrictEqual(state.byId, {});
});

test('hydrate carries invocables onto each pane', () => {
  const state = reduce(initialState, {
    t: 'hydrate',
    sessions: [summary('s1')],
    layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
    snapshots: [{ ...snapshot('s1'), invocables: [{ name: 'init' }] }],
    catalog: [],
  });

  assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'init' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "invocables"`
Expected: FAIL — the pane has no `invocables`.

- [ ] **Step 3: Extend the reducer**

Add `Invocable` to the type import and to `PaneState`:

```ts
export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  /** The cwd's catalog. Absent until the host has one; see the spec's States. */
  invocables?: Invocable[];
}
```

Carry `invocables: s.invocables` through both the `hydrate` and `session-snapshot` pane constructions, and add the case before `default`:

```ts
    case 'session-invocables': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      // Full replacement, matching the seam: no merge, no ordering to keep.
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, invocables: msg.entries } },
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/reducer.ts src/test/unit/webview-reducer.test.ts
git commit -m "feat: store the invocable catalog per pane"
```

---

### Task 6: Menu logic as pure functions

**Files:**
- Create: `src/webview/lib/invocable-menu.ts`
- Create: `src/test/unit/invocable-menu.test.ts`

**Interfaces:**
- Consumes: `Invocable` (Task 1).
- Produces, all from `src/webview/lib/invocable-menu.ts`:
  - `INVOCABLE_MENU_WINDOW: 50`
  - `menuQuery(text: string): string | undefined`
  - `filterInvocables(entries: Invocable[], query: string): Invocable[]`
  - `menuView(entries: Invocable[], query: string): { rows: Invocable[]; overflow: number }`
  - `insertionFor(entry: Invocable): { text: string; ghost: string }`
  - `truncateName(name: string, max?: number): string`
  - `menuKeyAction(key: string): MenuKeyAction`
  - `nextIndex(current: number, delta: number, length: number): number`

Every behavioural rule lives here so the component in Task 7 stays a renderer. There is deliberately **no grouping function**: rows are flat in provider order (see the spec's UI section), and the origin badge carries what a group heading would have said.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/invocable-menu.test.ts`:

```ts
import * as assert from 'assert';
import {
  INVOCABLE_MENU_WINDOW, filterInvocables, insertionFor, menuKeyAction,
  menuQuery, menuView, nextIndex, truncateName,
} from '../../webview/lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

const ENTRIES: Invocable[] = [
  { name: 'brainstorming', description: 'Turn ideas into designs' },
  { name: 'superpowers:writing-plans', description: 'Plan before code', origin: 'superpowers' },
  { name: 'init', description: 'Brainstorming-adjacent bootstrap' },
  { name: 'loop', description: 'Run on an interval', argHint: '[interval] [prompt]' },
];

suite('invocable menu', () => {
  test('the menu opens only on a leading slash', () => {
    assert.strictEqual(menuQuery('/'), '');
    assert.strictEqual(menuQuery('/bra'), 'bra');
    assert.strictEqual(menuQuery(''), undefined);
    assert.strictEqual(menuQuery('hello'), undefined);
    assert.strictEqual(menuQuery('see src/foo'), undefined);
  });

  test('the menu closes once arguments begin', () => {
    // A space means the user is typing arguments, not choosing an entry —
    // and the composer needs Enter back at that point.
    assert.strictEqual(menuQuery('/loop '), undefined);
    assert.strictEqual(menuQuery('/loop 5m'), undefined);
    assert.strictEqual(menuQuery('/loop\n'), undefined);
  });

  test('name matches rank above description matches', () => {
    const out = filterInvocables(ENTRIES, 'brain');

    assert.deepStrictEqual(out.map((e) => e.name), ['brainstorming', 'init']);
  });

  test('an earlier match position ranks first, then alphabetical', () => {
    const entries: Invocable[] = [{ name: 'xxplan' }, { name: 'planner' }, { name: 'plan-b' }];
    const out = filterInvocables(entries, 'plan');

    assert.deepStrictEqual(out.map((e) => e.name), ['plan-b', 'planner', 'xxplan']);
  });

  test('matching is case-insensitive and searches the whole prefixed name', () => {
    const out = filterInvocables(ENTRIES, 'SUPERPOWERS:writing');

    assert.deepStrictEqual(out.map((e) => e.name), ['superpowers:writing-plans']);
  });

  test('an empty query returns everything in provider order', () => {
    const out = filterInvocables(ENTRIES, '');

    assert.deepStrictEqual(out.map((e) => e.name), ENTRIES.map((e) => e.name));
  });

  test('a query matching nothing returns an empty list', () => {
    assert.deepStrictEqual(filterInvocables(ENTRIES, 'zzz'), []);
  });

  test('the view caps rows and reports the overflow', () => {
    const many: Invocable[] = Array.from({ length: 200 }, (_, i) => ({ name: `cmd-${i}` }));
    const view = menuView(many, '');

    assert.strictEqual(view.rows.length, INVOCABLE_MENU_WINDOW);
    assert.strictEqual(view.overflow, 200 - INVOCABLE_MENU_WINDOW);
  });

  test('a filtered view under the cap reports no overflow', () => {
    const view = menuView(ENTRIES, 'loop');

    assert.strictEqual(view.rows.length, 1);
    assert.strictEqual(view.overflow, 0);
  });

  test('insertion is the verbatim name with a trailing space', () => {
    assert.deepStrictEqual(insertionFor({ name: 'superpowers:writing-plans' }), {
      text: '/superpowers:writing-plans ', ghost: '',
    });
  });

  test('an arg hint becomes ghost text, never part of the inserted text', () => {
    const out = insertionFor({ name: 'loop', argHint: '[interval] [prompt]' });

    assert.strictEqual(out.text, '/loop ');
    assert.strictEqual(out.ghost, '[interval] [prompt]');
  });

  test('long names truncate in the middle, keeping prefix and leaf', () => {
    const out = truncateName('document-skills:some-very-long-skill-name-here', 24);

    // 24 = 12 head chars + the ellipsis + 11 tail chars.
    assert.strictEqual(out.length, 24);
    assert.ok(out.startsWith('document-'));
    assert.ok(out.endsWith('name-here'));
    assert.ok(out.includes('…'));
  });

  test('a short name is returned unchanged', () => {
    assert.strictEqual(truncateName('init', 24), 'init');
  });

  test('the menu claims only its own keys', () => {
    assert.strictEqual(menuKeyAction('ArrowDown'), 'move-down');
    assert.strictEqual(menuKeyAction('ArrowUp'), 'move-up');
    assert.strictEqual(menuKeyAction('Enter'), 'select');
    assert.strictEqual(menuKeyAction('Tab'), 'select');
    assert.strictEqual(menuKeyAction('Escape'), 'close');
    assert.strictEqual(menuKeyAction('a'), 'pass');
    assert.strictEqual(menuKeyAction('Backspace'), 'pass');
  });

  test('the highlight wraps at both ends', () => {
    assert.strictEqual(nextIndex(0, 1, 3), 1);
    assert.strictEqual(nextIndex(2, 1, 3), 0);
    assert.strictEqual(nextIndex(0, -1, 3), 2);
    assert.strictEqual(nextIndex(0, 1, 0), 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "invocable menu"`
Expected: FAIL — `Cannot find module '../../webview/lib/invocable-menu'`.

- [ ] **Step 3: Write the module**

Create `src/webview/lib/invocable-menu.ts`:

```ts
import type { Invocable } from '../../protocol/messages';

/**
 * Rows rendered at most. Bounded DOM instead of a windowing library — this
 * project vendors its UI primitives and takes no new dependencies. Typing
 * narrows below this immediately, so it only ever governs the first view.
 */
export const INVOCABLE_MENU_WINDOW = 50;

/**
 * The composer text -> the active menu query, or `undefined` for "no menu".
 *
 * Trigger discipline: only a leading `/`, and only while no whitespace has
 * been typed. Requiring position 0 keeps `src/foo` and pasted URLs from
 * opening it; closing at the first space means the menu releases Enter as
 * soon as the user starts typing arguments, which is what keeps it from
 * fighting the composer's own send binding.
 */
export function menuQuery(text: string): string | undefined {
  if (!text.startsWith('/')) { return undefined; }
  const rest = text.slice(1);
  if (/\s/.test(rest)) { return undefined; }
  return rest;
}

export function filterInvocables(entries: Invocable[], query: string): Invocable[] {
  if (query.length === 0) { return entries; }
  const needle = query.toLowerCase();

  const scored: { entry: Invocable; rank: number; at: number }[] = [];
  for (const entry of entries) {
    const at = entry.name.toLowerCase().indexOf(needle);
    if (at >= 0) {
      scored.push({ entry, rank: 0, at });
      continue;
    }
    // A description match still surfaces the entry, but never above a name
    // match: the user is typing a name.
    if ((entry.description ?? '').toLowerCase().includes(needle)) {
      scored.push({ entry, rank: 1, at: 0 });
    }
  }

  scored.sort((a, b) =>
    a.rank - b.rank
    || a.at - b.at
    || a.entry.name.localeCompare(b.entry.name));
  return scored.map((s) => s.entry);
}

export function menuView(
  entries: Invocable[], query: string,
): { rows: Invocable[]; overflow: number } {
  const matched = filterInvocables(entries, query);
  return {
    rows: matched.slice(0, INVOCABLE_MENU_WINDOW),
    overflow: Math.max(0, matched.length - INVOCABLE_MENU_WINDOW),
  };
}

/**
 * What selecting an entry does. `text` replaces the composer contents;
 * `ghost` is presentation-only and must never be appended to the message —
 * see the composer's submit path and its DOM test.
 */
export function insertionFor(entry: Invocable): { text: string; ghost: string } {
  return { text: `/${entry.name} `, ghost: entry.argHint ?? '' };
}

/**
 * Middle-truncate, keeping the plugin prefix and the leaf — the two halves
 * that identify an entry. Callers put the full name in a title attribute.
 */
export function truncateName(name: string, max = 34): string {
  if (name.length <= max) { return name; }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export type MenuKeyAction = 'move-up' | 'move-down' | 'select' | 'close' | 'pass';

/**
 * Which keys the menu claims WHILE OPEN. Everything else passes through to
 * the composer; a handler that claimed keys after close would stop Enter
 * from sending, which is worse than having no menu at all.
 */
export function menuKeyAction(key: string): MenuKeyAction {
  switch (key) {
    case 'ArrowDown': return 'move-down';
    case 'ArrowUp': return 'move-up';
    case 'Enter': case 'Tab': return 'select';
    case 'Escape': return 'close';
    default: return 'pass';
  }
}

/** Wrapping highlight movement. Returns 0 for an empty list rather than -1. */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) { return 0; }
  return (current + delta + length) % length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS, all 15 new tests included.

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/invocable-menu.ts src/test/unit/invocable-menu.test.ts
git commit -m "feat: add invocable menu filtering, insertion and key logic"
```

---

### Task 7: The menu in the composer

**Files:**
- Create: `src/webview/components/invocable-menu.tsx`
- Create: `src/test/dom/invocable-menu.test.tsx`
- Modify: `src/webview/components/composer.tsx`

**Interfaces:**
- Consumes: everything from Task 6; `PaneState.invocables` (Task 5).
- Produces: `<InvocableMenu rows overflow activeIndex listId onPick>`; `Composer` gains no new props.

**Design contract** (from the spec's UI section — do not improvise around it):

- Two entry points, one menu: typing `/` at position 0, or a `/ commands` control on the composer's addon row.
- Rows are two lines: name (with right-aligned origin badge) over a one-line clamped description.
- Flat, provider order. No grouping.
- Menu renders **above** the textarea, inside `<InputGroupAddon align="block-start">` — no popover, no portal, no positioning maths.
- No catalog → no control, and `/` does nothing.
- No match → exactly one muted `No match` row.
- `role="listbox"` with `aria-activedescendant`; the highlight is a fill *plus* the standard focus treatment, never colour alone.
- The control must be icon-scale: the addon row already `flex-wrap`s at 300px, and a labelled button would force a third line.

- [ ] **Step 1: Write the failing DOM tests**

Create `src/test/dom/invocable-menu.test.tsx`, following the conventions in `src/test/dom/composer.test.tsx` (real `StoreProvider`, state via `sendFromHost`, assertions over `posted()`):

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import type { Invocable } from '../../protocol/messages';
import { catalog, summary } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost } from './harness';

const ENTRIES: Invocable[] = [
  { name: 'brainstorming', description: 'Turn ideas into designs' },
  { name: 'superpowers:writing-plans', description: 'Plan before code', origin: 'superpowers' },
  { name: 'loop', description: 'Run on an interval', argHint: '[interval] [prompt]' },
];

const NO_EFFORT = catalog()[0].models[1];

function pane(invocables?: Invocable[]): PaneState {
  return { summary: summary('a'), items: [], hasMore: false, pending: [], invocables };
}

suite('invocable menu', () => {
  test('typing / opens the menu and a name filters it', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '/bra');

    const options = screen.getAllByRole('option');
    assert.strictEqual(options.length, 1);
    assert.ok(options[0].textContent?.includes('brainstorming'));
  });

  test('a slash that is not at position 0 opens nothing', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), 'see src/foo');

    assert.strictEqual(screen.queryByRole('listbox'), null);
  });

  test('a space closes the menu and Enter sends again', async () => {
    resetHost();
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '/loop 5m');
    assert.strictEqual(screen.queryByRole('listbox'), null);

    await userEvent.type(box, '{Enter}');
    const sends = posted().filter((m) => m.t === 'send');
    assert.deepStrictEqual(sends.map((m) => (m as { text: string }).text), ['/loop 5m']);
  });

  test('arrows move the active option and Enter inserts it', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/');
    await userEvent.keyboard('{ArrowDown}');

    const list = screen.getByRole('listbox');
    const activeId = list.getAttribute('aria-activedescendant');
    assert.strictEqual(document.getElementById(activeId ?? '')?.textContent?.includes(
      'superpowers:writing-plans',
    ), true);

    await userEvent.keyboard('{Enter}');
    assert.strictEqual(box.value, '/superpowers:writing-plans ');
  });

  test('Escape closes the menu and leaves the typed text alone', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/bra');
    await userEvent.keyboard('{Escape}');

    assert.strictEqual(screen.queryByRole('listbox'), null);
    assert.strictEqual(box.value, '/bra');
  });

  test('the arg hint is shown but never sent', async () => {
    resetHost();
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/loop');
    await userEvent.keyboard('{Enter}');
    assert.ok(screen.getByText('[interval] [prompt]'));

    await userEvent.type(box, '5m{Enter}');
    const sends = posted().filter((m) => m.t === 'send');
    assert.deepStrictEqual(sends.map((m) => (m as { text: string }).text), ['/loop 5m']);
  });

  test('a query matching nothing renders one No match row', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), '/zzzz');

    assert.strictEqual(screen.getAllByRole('option').length, 1);
    assert.ok(screen.getByText('No match'));
  });

  test('a pane with no catalog has no control and an inert slash', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);

    assert.strictEqual(screen.queryByLabelText('Skills and commands'), null);
    await userEvent.type(screen.getByLabelText('Message'), '/');
    assert.strictEqual(screen.queryByRole('listbox'), null);
  });

  test('the control opens the full list unfiltered', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.click(screen.getByLabelText('Skills and commands'));

    assert.strictEqual(screen.getAllByRole('option').length, ENTRIES.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:dom --grep "invocable menu"`
Expected: FAIL — no listbox is ever rendered.

- [ ] **Step 3: Write the menu component**

Create `src/webview/components/invocable-menu.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { truncateName } from '../lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

export function InvocableMenu({ rows, overflow, activeIndex, listId, onPick }: {
  rows: Invocable[];
  overflow: number;
  activeIndex: number;
  /** Prefix for row ids, so `aria-activedescendant` resolves per pane. */
  listId: string;
  onPick: (entry: Invocable) => void;
}) {
  const empty = rows.length === 0;

  return (
    <div
      role="listbox"
      aria-label="Skills and commands"
      id={listId}
      aria-activedescendant={empty ? undefined : `${listId}-${activeIndex}`}
      className="max-h-64 w-full overflow-y-auto"
    >
      {empty && (
        // A row, not an empty box: a menu that vanishes mid-keystroke hands
        // Enter back to the composer without the user seeing why.
        <div role="option" aria-selected={false} className="px-2 py-1 text-muted-foreground">
          No match
        </div>
      )}
      {rows.map((entry, i) => (
        <div
          key={entry.name}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          title={entry.name}
          // onMouseDown, not onClick: the textarea must not lose focus before
          // the pick lands, or the menu closes on blur and the click is lost.
          onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
          className={cn(
            'cursor-pointer px-2 py-1',
            i === activeIndex && 'bg-accent text-accent-foreground',
          )}
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium">{truncateName(entry.name)}</span>
            {entry.origin && (
              <span className="ml-auto shrink-0 text-muted-foreground">{entry.origin}</span>
            )}
          </div>
          {entry.description && (
            <div className="truncate text-muted-foreground">{entry.description}</div>
          )}
        </div>
      ))}
      {overflow > 0 && (
        <div className="px-2 py-1 text-muted-foreground">+{overflow} more</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the composer**

In `src/webview/components/composer.tsx`, add state:

```tsx
  const [ghost, setGhost] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  const entries = pane.invocables ?? [];
  const typedQuery = menuQuery(text);
  // Two entry points, one menu: the typed `/` query, or the control opening
  // it unfiltered on an empty box.
  const query = typedQuery ?? (forceOpen ? '' : undefined);
  const menuOpen = entries.length > 0 && query !== undefined && !dismissed;
  const view = menuOpen ? menuView(entries, query) : { rows: [], overflow: 0 };
  const index = Math.min(activeIndex, Math.max(0, view.rows.length - 1));
  // Session-scoped for the same reason as bypassReasonId above: one Composer
  // renders per pane, and `aria-activedescendant` resolves ids document-wide.
  const menuListId = `invocables-${pane.summary.id}`;
```

Selection and submit:

```tsx
  const pick = (entry: Invocable) => {
    const { text: next, ghost: hint } = insertionFor(entry);
    setText(next);
    setGhost(hint);
    setActiveIndex(0);
    setForceOpen(false);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) { return; }
    // `ghost` is presentation only — the arg hint is never part of the message.
    post({ t: 'send', id: pane.summary.id, text: trimmed });
    setText('');
    setGhost('');
    setDismissed(false);
    setForceOpen(false);
  };
```

Render the menu as a block-start addon, so it sits above the textarea with no positioning code:

```tsx
      <InputGroup>
        {menuOpen && (
          <InputGroupAddon align="block-start" className="p-0">
            <InvocableMenu
              rows={view.rows}
              overflow={view.overflow}
              activeIndex={index}
              listId={menuListId}
              onPick={pick}
            />
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setGhost('');
            setActiveIndex(0);
            setDismissed(false);
            setForceOpen(false);
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              const action = menuKeyAction(e.key);
              if (action !== 'pass') {
                e.preventDefault();
                if (action === 'move-down') { setActiveIndex(nextIndex(index, 1, view.rows.length)); }
                if (action === 'move-up') { setActiveIndex(nextIndex(index, -1, view.rows.length)); }
                if (action === 'select' && view.rows[index]) { pick(view.rows[index]); }
                if (action === 'close') { setDismissed(true); setForceOpen(false); }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) { submit(); }
            }
          }}
          placeholder="Message the agent…"
          aria-label="Message"
          aria-controls={menuOpen ? menuListId : undefined}
          aria-expanded={menuOpen}
        />
```

Render the ghost hint and the control in the existing `block-end` addon, before the effort select:

```tsx
          {ghost && (
            <span className="text-muted-foreground" aria-hidden>{ghost}</span>
          )}
          {entries.length > 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Skills and commands"
              title="Skills and commands"
              onClick={() => {
                setText('');
                setGhost('');
                setDismissed(false);
                setActiveIndex(0);
                setForceOpen(true);
              }}
            >
              <Slash />
            </Button>
          )}
```

Imports to add:

```tsx
import { SendHorizontal, Slash, Square } from 'lucide-react';
import { InvocableMenu } from './invocable-menu';
import {
  insertionFor, menuKeyAction, menuQuery, menuView, nextIndex,
} from '../lib/invocable-menu';
import type { EffortLevel, Invocable, ModelInfo, PermissionMode } from '../../protocol/messages';
```

- [ ] **Step 5: Run every check**

Run: `yarn test:dom && yarn test:unit && yarn check-types && yarn lint`
Expected: PASS, including the pre-existing composer DOM suite — the Enter-sends and disabled-Send behaviours must be untouched.

- [ ] **Step 6: Run the impeccable detector**

Run: `node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json src/webview/components/invocable-menu.tsx src/webview/components/composer.tsx`
Expected: exit 0. A non-zero exit is a failing check, not a suggestion — fix what it reports and rerun.

- [ ] **Step 7: Verify by hand in the Extension Development Host**

Run: `yarn dev`

With a session on a repo that has skills:
1. The `/` control is present in the composer's addon row on a **brand-new session, before any message** — this is the whole point of the probe.
2. Typing `/` opens the menu above the box; typing narrows it; two-line rows are legible at a 300px pane width.
3. Arrows move, Enter inserts `/name `, the arg hint appears beside the controls and is gone from the sent message.
4. Escape closes and leaves the text; Enter then sends.
5. Narrow the pane to ~300px: the addon row must not gain a third wrapped line.

- [ ] **Step 8: Commit**

```bash
git add src/webview src/test/dom/invocable-menu.test.tsx
git commit -m "feat: invoke skills and slash commands from the composer"
```

---

## Verification

```bash
yarn check-types && yarn lint && yarn test:unit && yarn test:dom
node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json src/webview/components/invocable-menu.tsx src/webview/components/composer.tsx
```

Spec requirements and where each is verified:

| Spec section | Verified by |
|---|---|
| Snapshot event, replace-whole | Task 3 (`setInvocables … replaces wholesale`), Task 5 |
| Probe, one per cwd, cached | Task 2 (`probes once per key`, `different cwd`) |
| Probe failure caches nothing, retries | Task 2 (`a failed probe …`) |
| Works before the first message | Task 3 (`creating a session probes its cwd …`), Task 7 Step 7.1 |
| Fan-out to siblings on a cwd | Task 3 (`a live invocables event refreshes every session`) |
| Archived pane served from cache | Task 3 (`an archived pane is served the cwd catalog`) |
| Empty vs unknown | Task 2 (`an empty catalog is a real answer`) |
| No persistence | No `TranscriptStore` change in any task |
| Origin derivation | Task 4 (`map-commands` origin tests) |
| Claude mapping, `argumentHint: ''` | Task 4 |
| `commands_changed` | Task 4 (`map-events` tests) |
| Probe closes its query, even on failure | Task 4 (`listInvocables … closes it`, `… even when the catalog read fails`) |
| Filtering and ranking | Task 6 |
| Trigger discipline, key claiming | Task 6 (`menuQuery`, `menuKeyAction`), Task 7 (`a space closes the menu and Enter sends again`) |
| Insertion and ghost text | Task 6 (`insertionFor`), Task 7 (`the arg hint is shown but never sent`) |
| 50-row cap | Task 6 (`the view caps rows…`) |
| `No match` row | Task 7 (`a query matching nothing renders one No match row`) |
| Two entry points | Task 7 (`the control opens the full list unfiltered`) |
| No catalog → no control, inert `/` | Task 7 (`a pane with no catalog …`) |
| listbox semantics, `aria-activedescendant` | Task 7 (`arrows move the active option`) |
| No chrome strip | No task creates one |
