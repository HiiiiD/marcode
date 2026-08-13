# Invocable Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a live session's skills and slash commands as a `/` autocomplete menu in the composer and a chrome strip listing what is available.

**Architecture:** The provider pushes a full-replacement `invocables` snapshot event across the existing `AgentEvent` seam. `AgentSession` holds the latest snapshot in memory (never persisted) and forwards it through `SessionSink`; `SessionManager` gates it on pane visibility exactly as it gates transcript patches. The webview stores it per pane and renders it through two thin components over one pure logic module.

**Tech Stack:** TypeScript, esbuild (CJS extension host + IIFE webview bundle), React 19, Tailwind v4, vendored shadcn/ui primitives, Mocha (`--ui tdd`) for unit tests, `@anthropic-ai/claude-agent-sdk` 0.3.228.

**Spec:** [docs/superpowers/specs/2026-08-13-invocable-catalog-design.md](../specs/2026-08-13-invocable-catalog-design.md)

## Global Constraints

- **No new dependencies.** Not for fuzzy matching, not for virtualization, not for testing. The 50-row cap exists so no windowing library is needed.
- **No persistence.** The catalog never reaches `TranscriptStore`, `StoredIndex`, or `SessionState`. No migration, no version field.
- **`@anthropic-ai/claude-agent-sdk` is ESM-only** and this bundle is CJS: reach runtime values through `await import(...)` and types through `import type ... with { 'resolution-mode': 'import' }`. See the header of `src/providers/claude/claude-provider.ts`.
- **Provider names cross the seam verbatim.** The host never validates a name, never rewrites it, never resolves collisions. `origin` is derived for display only; `name` is what gets inserted.
- **Unit tests must not need VS Code, the network, or the SDK.** Everything runs against `FakeProvider` or plain functions under `yarn test:unit`.
- **Code style:** two-space indent, single quotes, semicolons, `curly` and `eqeqeq` enforced (`eslint.config.mjs`). Lines wrap near 100 columns. Non-obvious decisions get a comment explaining *why*, matching the density of the surrounding files.
- **Verify before claiming done:** `yarn test:unit` and `yarn check-types` must both pass before each commit.
- **`INVOCABLE_MENU_WINDOW = 50`** is the single named constant governing rendered menu rows.

---

### Task 1: Seam types and a FakeProvider that can emit

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/fake/fake-provider.ts:42-90`
- Modify: `src/protocol/messages.ts:1-5`, `:54-60`, `:87-94`
- Test: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Invocable` — `{ name: string; description?: string; origin?: string; argHint?: string }`, exported from `src/providers/types.ts` and re-exported from `src/protocol/messages.ts`.
  - `AgentEvent` variant `{ kind: 'invocables'; entries: Invocable[] }`.
  - `SessionSnapshot.invocables?: Invocable[]`.
  - `HostToWebview` variant `{ t: 'session-invocables'; id: SessionId; entries: Invocable[] }`.
  - `FakeProvider.runs: FakeRun[]`, where `FakeRun = AgentRun & { emit(event: AgentEvent): void }` — lets a test push any event without going through `send()`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/fake-provider.test.ts`:

```ts
test('a run can emit events outside of send()', async () => {
  const provider = new FakeProvider(() => []);
  const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

  run.emit({
    kind: 'invocables',
    entries: [{ name: 'brainstorming', description: 'Turn ideas into designs' }],
  });

  const iterator = run.events[Symbol.asyncIterator]();
  const first = await iterator.next();

  assert.deepStrictEqual(first.value, {
    kind: 'invocables',
    entries: [{ name: 'brainstorming', description: 'Turn ideas into designs' }],
  });
  assert.strictEqual(provider.runs.length, 1);
  assert.strictEqual(provider.runs[0], run);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/fake-provider.test.js -g "emit events outside"`
Expected: FAIL — `run.emit is not a function` (and a type error from `yarn check-types` on the same call).

- [ ] **Step 3: Add the `Invocable` type and the event variant**

In `src/providers/types.ts`, after `ModelInfo`:

```ts
/**
 * One thing the user can invoke by typing `/name`: a skill or a slash
 * command. Providers report these as one undifferentiated list — see the
 * spec's SDK spike — so there is deliberately no `kind` field.
 */
export interface Invocable {
  /** Verbatim from the provider. This is what gets inserted into the composer. */
  name: string;
  /** One line, rendered as the menu subtitle. */
  description?: string;
  /** Plugin/namespace prefix derived from a `prefix:leaf` name. Display only. */
  origin?: string;
  /** e.g. '[interval] [prompt]'. Rendered as ghost text after insertion. */
  argHint?: string;
}
```

Extend `AgentEvent` with a final variant:

```ts
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  /** Full replacement list, not a delta. Emitted at init and on any change. */
  | { kind: 'invocables'; entries: Invocable[] };
```

- [ ] **Step 4: Widen the protocol**

In `src/protocol/messages.ts`, add `Invocable` to the type import from `../providers/types` and to the `export type { ... }` re-export on line 5.

Add the snapshot field to `SessionSnapshot`:

```ts
export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
  /**
   * Live-run state only: absent for an archived session, and absent for a
   * live one whose provider has not reported yet. Never persisted.
   */
  invocables?: Invocable[];
}
```

Add the host message variant to `HostToWebview`:

```ts
  | { t: 'session-invocables'; id: SessionId; entries: Invocable[] }
```

- [ ] **Step 5: Give FakeProvider an emit hook**

In `src/providers/fake/fake-provider.ts`, replace the class body's `start` and add the run type:

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
   * events (an `invocables` snapshot, an MCP status) without the user having
   * sent anything; tests need a handle to do the same.
   */
  readonly runs: FakeRun[] = [];
  private sessionCounter = 0;
```

and in `start`, build the object, register it, and return it:

```ts
  start(_opts: StartOptions): AgentRun {
    const channel = new EventChannel();
    const resumeToken = `fake-session-${++this.sessionCounter}`;
    let started = false;

    const run: FakeRun = {
      events: channel,
      emit: (event: AgentEvent) => { channel.push(event); },
      send: (text: string) => {
        if (!started) {
          started = true;
          channel.push({ kind: 'session', resumeToken });
        }
        for (const ev of this.script(text)) { channel.push(ev); }
      },
      respondToTool: (id, decision) => {
        this.decisions.set(id, decision);
        // A real provider resolves the tool and completes the turn once the
        // decision lands. Without a follow-up event here, AgentSession sets
        // status to 'running' when pending.size reaches 0 (see
        // respondToPermission) and nothing ever arrives after that for the
        // fake provider — the status dot is stuck at 'running' forever.
        channel.push({ kind: 'turn-end', reason: 'done' });
      },
      setEffort: (_effort: EffortLevel) => { /* recorded by tests via lastEffort if needed */ },
      interrupt: async () => { channel.push({ kind: 'turn-end', reason: 'interrupted' }); },
      dispose: async () => { channel.close(); },
    };

    this.runs.push(run);
    return run;
  }
```

The declared return type stays `AgentRun` so the class still satisfies `AgentProvider`; tests reach `emit` through `provider.runs`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add src/providers/types.ts src/providers/fake/fake-provider.ts src/protocol/messages.ts src/test/unit/fake-provider.test.ts
git commit -m "feat: add the invocable seam type and a FakeProvider emit hook"
```

---

### Task 2: AgentSession holds and forwards the snapshot

**Files:**
- Modify: `src/host/agent-session.ts:1-56`, `:134-138`, `:172-247`
- Test: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `Invocable`, the `invocables` `AgentEvent` variant, `FakeProvider.runs` (Task 1).
- Produces:
  - `SessionSink.invocables(id: SessionId, entries: Invocable[]): void` — a new required method on the sink interface.
  - `AgentSession.snapshot()` returns `invocables` when the provider has reported.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/agent-session.test.ts` (follow the file's existing harness for building a session and its recording sink — extend that sink with an `invocables` recorder rather than inventing a second one):

```ts
test('an invocables event reaches the sink and the snapshot', async () => {
  const { session, provider, sink } = makeSession();
  const entries = [
    { name: 'brainstorming', description: 'Turn ideas into designs' },
    { name: 'init', argHint: '[path]' },
  ];

  provider.runs[0].emit({ kind: 'invocables', entries });
  await settle();

  assert.deepStrictEqual(sink.invocables, [entries]);
  const snap = await session.snapshot();
  assert.deepStrictEqual(snap.invocables, entries);
});

test('a later snapshot replaces the earlier one wholesale', async () => {
  const { session, provider } = makeSession();

  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'a' }, { name: 'b' }] });
  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'c' }] });
  await settle();

  const snap = await session.snapshot();
  assert.deepStrictEqual(snap.invocables, [{ name: 'c' }]);
});

test('a session with no invocables event has no invocables in its snapshot', async () => {
  const { session } = makeSession();

  const snap = await session.snapshot();
  assert.strictEqual(snap.invocables, undefined);
});

test('an empty array is reported, and is distinct from never reporting', async () => {
  const { session, provider } = makeSession();

  provider.runs[0].emit({ kind: 'invocables', entries: [] });
  await settle();

  const snap = await session.snapshot();
  assert.deepStrictEqual(snap.invocables, []);
});
```

If the existing file has no `settle()` helper, add one — the event pump is async, so assertions need a turn of the microtask queue:

```ts
/** The event pump is async; let it drain before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/agent-session.test.js -g "invocables"`
Expected: FAIL — `sink.invocables` is undefined and `snap.invocables` is undefined.

- [ ] **Step 3: Extend the sink and hold the snapshot**

In `src/host/agent-session.ts`, add to the `SessionSink` interface:

```ts
  /**
   * The session's latest full invocable list. Live-run state: it is never
   * persisted, so this is the only way it reaches the webview mid-run.
   */
  invocables(id: SessionId, entries: Invocable[]): void;
```

Add the field beside the other in-memory run state:

```ts
  /**
   * Last `invocables` snapshot from the provider. `undefined` means "not
   * reported", which is deliberately distinct from `[]` ("none available") —
   * see the spec. Never written to the transcript.
   */
  private invocableEntries: Invocable[] | undefined;
```

Handle the event in `handle()`, before the `turn-end` case:

```ts
      case 'invocables':
        // Replace wholesale: the provider sends the full list every time,
        // so there is nothing to merge and no ordering to preserve.
        this.invocableEntries = event.entries;
        this.sink.invocables(this._state.id, event.entries);
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
      invocables: this.invocableEntries,
    };
  }
```

Import `Invocable` from `../providers/types` alongside the existing type imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types`
Expected: PASS. `SessionManager` will fail type-checking until Task 3 — if `check-types` reports `Property 'invocables' is missing` on `SessionManager`, do Task 3's Step 3 now and commit both together rather than leaving a broken build.

- [ ] **Step 5: Commit**

```bash
git add src/host/agent-session.ts src/test/unit/agent-session.test.ts
git commit -m "feat: hold and forward the provider's invocable snapshot"
```

---

### Task 3: SessionManager routes it to visible panes

**Files:**
- Modify: `src/host/session-manager.ts:14-38`, `:111-149`, `:195-211`
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionSink.invocables` (Task 2), `HostToWebview` variant `session-invocables` (Task 1).
- Produces: `SessionManager.invocables(id, entries)` emitting `{ t: 'session-invocables', id, entries }` for visible sessions only, buffered across an in-flight snapshot.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/session-manager.test.ts`, following the file's existing harness (a manager over a temp-dir `TranscriptStore`, a `FakeProvider`, and an array collecting emitted `HostToWebview` messages):

```ts
test('invocables reach a visible session', async () => {
  const { manager, provider, emitted } = await makeManager();
  const session = await manager.create('fake', '/tmp');
  await manager.setVisible([session.state.id]);
  emitted.length = 0;

  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'init' }] });
  await settle();

  assert.deepStrictEqual(emitted, [{
    t: 'session-invocables', id: session.state.id, entries: [{ name: 'init' }],
  }]);
});

test('invocables for a hidden session are dropped', async () => {
  const { manager, provider, emitted } = await makeManager();
  await manager.create('fake', '/tmp');
  emitted.length = 0;

  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'init' }] });
  await settle();

  assert.deepStrictEqual(emitted.filter((m) => m.t === 'session-invocables'), []);
});

test('invocables arriving during a snapshot fetch are emitted after it', async () => {
  const { manager, provider, emitted } = await makeManager();
  const session = await manager.create('fake', '/tmp');
  emitted.length = 0;

  // Do not await: emit while the snapshot fetch is in flight.
  const visible = manager.setVisible([session.state.id]);
  provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'late' }] });
  await visible;
  await settle();

  const tags = emitted.map((m) => m.t);
  assert.ok(tags.indexOf('session-snapshot') < tags.indexOf('session-invocables'),
    'the snapshot must precede the invocables message');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/session-manager.test.js -g "invocables"`
Expected: FAIL — `manager.invocables is not a function`.

- [ ] **Step 3: Implement the sink method**

Add the buffer field beside `snapshotting` in `src/host/session-manager.ts`:

```ts
  /**
   * Latest invocables that arrived for an id while its snapshot fetch was in
   * flight. The in-flight snapshot samples `AgentSession`'s field at an
   * unpredictable point relative to this event, so emitting immediately could
   * land before the snapshot (and be clobbered by it), while dropping could
   * lose a change the snapshot was built too early to include. Keep only the
   * latest — the event is a full replacement, so an older one is worthless.
   */
  private pendingInvocables = new Map<SessionId, Invocable[]>();
```

Add the method beside `patch()` in the `SessionSink` section:

```ts
  invocables(id: SessionId, entries: Invocable[]): void {
    if (!this.visible.has(id)) { return; }
    if (this.snapshotting.has(id)) {
      this.pendingInvocables.set(id, entries);
      return;
    }
    this.emit({ t: 'session-invocables', id, entries });
  }
```

Drain it in `drainSnapshotBuffer`, after the patches so the ordering matches how the events arrived:

```ts
  /** Emits any patches that arrived for `id` while its snapshot was in flight. */
  private drainSnapshotBuffer(id: SessionId): void {
    const buffered = this.snapshotting.get(id);
    this.snapshotting.delete(id);
    if (buffered) {
      for (const patch of buffered) {
        this.emit({ t: 'session-patch', id, patch });
      }
    }
    const entries = this.pendingInvocables.get(id);
    this.pendingInvocables.delete(id);
    if (entries) {
      this.emit({ t: 'session-invocables', id, entries });
    }
  }
```

Note the restructure: the early `return` on `!buffered` in the current code would skip the invocables drain, so it becomes an `if` block.

Import `Invocable` from `../providers/types`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: route invocable snapshots to visible panes"
```

---

### Task 4: Claude provider reports the catalog

**Files:**
- Create: `src/providers/claude/map-commands.ts`
- Create: `src/test/unit/map-commands.test.ts`
- Modify: `src/providers/claude/map-events.ts:106-114`
- Modify: `src/providers/claude/claude-provider.ts:146-159`
- Test: `src/test/unit/map-events.test.ts`

**Interfaces:**
- Consumes: `Invocable` (Task 1).
- Produces: `toInvocables(commands: unknown): Invocable[]` from `src/providers/claude/map-commands.ts`.

**SDK facts** (verified 2026-08-13 against `@anthropic-ai/claude-agent-sdk@0.3.228` by reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

```ts
type SlashCommand = {
  name: string;          // no leading slash
  description: string;
  argumentHint: string;  // may be ''
  aliases?: string[];    // ignored — see the spec
};
Query.supportedCommands(): Promise<SlashCommand[]>;
type SDKCommandsChangedMessage = {
  type: 'system'; subtype: 'commands_changed'; commands: SlashCommand[];
  uuid: UUID; session_id: string;
};
```

- [ ] **Step 1: Write the failing tests**

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

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/map-commands.test.js out/test/unit/map-events.test.js`
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
      return [{ kind: 'invocables', entries: toInvocables((msg as { commands?: unknown }).commands) }];
    }
    if (subtype !== 'init') { return []; }
    const sessionId = (msg as { session_id?: string }).session_id;
    return sessionId ? [{ kind: 'session', resumeToken: sessionId }] : [];
  }
```

Add `import { toInvocables } from './map-commands';` beside the existing imports.

- [ ] **Step 5: Fetch the initial list**

In `src/providers/claude/claude-provider.ts`, inside the `pump` IIFE, right after `queryRef = session;`:

```ts
        queryRef = session;
        // The initial catalog is a pull, not a push. Fire it without
        // awaiting so a slow control response cannot delay the message loop,
        // and swallow a rejection: a catalog that fails to load leaves the
        // snapshot unreported (strip hidden, composer still plain text) and
        // must never take the session down with it. Later changes arrive on
        // their own as `commands_changed` system messages.
        void session.supportedCommands()
          .then((commands) => { events.push({ kind: 'invocables', entries: toInvocables(commands) }); })
          .catch(() => { /* see above */ });
```

Add `import { toInvocables } from './map-commands';` beside the `mapEvent` import.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/claude src/test/unit/map-commands.test.ts src/test/unit/map-events.test.ts
git commit -m "feat: report the Claude session's skills and slash commands"
```

---

### Task 5: Webview reducer stores the catalog per pane

**Files:**
- Modify: `src/webview/reducer.ts:1-27`, `:41-71`
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

test('a pane with no invocables reported has none', () => {
  const state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });

  assert.strictEqual(state.byId['s1'].invocables, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/webview-reducer.test.js -g "invocable"`
Expected: FAIL — `state.byId['s1'].invocables` is undefined where a list is expected.

- [ ] **Step 3: Extend the reducer**

In `src/webview/reducer.ts`, add `Invocable` to the type import and to `PaneState`:

```ts
export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  /** Live-run only: absent for an archived pane or before the provider reports. */
  invocables?: Invocable[];
}
```

Carry it through both snapshot paths — in `hydrate`:

```ts
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
          invocables: s.invocables,
        };
```

and in `session-snapshot`:

```ts
          [s.id]: {
            summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
            invocables: s.invocables,
          },
```

Add the new case before `default`:

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
  - `groupByOrigin(entries: Invocable[]): { origin: string; entries: Invocable[] }[]`
  - `menuKeyAction(key: string): 'move-up' | 'move-down' | 'select' | 'close' | 'pass'`

This task is where every behavioural rule lives. Task 7's components stay thin enough that nothing untested hides in them — the unit suite has no DOM, so logic that leaks into JSX cannot be covered.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/invocable-menu.test.ts`:

```ts
import * as assert from 'assert';
import {
  INVOCABLE_MENU_WINDOW, filterInvocables, groupByOrigin, insertionFor,
  menuKeyAction, menuQuery, menuView, truncateName,
} from '../../webview/lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

const ENTRIES: Invocable[] = [
  { name: 'brainstorming', description: 'Turn ideas into designs', origin: undefined },
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
    // A space means the user is typing arguments, not choosing an entry.
    assert.strictEqual(menuQuery('/loop '), undefined);
    assert.strictEqual(menuQuery('/loop 5m'), undefined);
    assert.strictEqual(menuQuery('/loop\n'), undefined);
  });

  test('name matches rank above description matches', () => {
    const out = filterInvocables(ENTRIES, 'brain');

    assert.deepStrictEqual(out.map((e) => e.name), ['brainstorming', 'init']);
  });

  test('an earlier match position ranks first, then alphabetical', () => {
    const entries: Invocable[] = [
      { name: 'xxplan' }, { name: 'planner' }, { name: 'plan-b' },
    ];
    const out = filterInvocables(entries, 'plan');

    assert.deepStrictEqual(out.map((e) => e.name), ['plan-b', 'planner', 'xxplan']);
  });

  test('matching is case-insensitive and searches the whole prefixed name', () => {
    const out = filterInvocables(ENTRIES, 'SUPERPOWERS:writing');

    assert.deepStrictEqual(out.map((e) => e.name), ['superpowers:writing-plans']);
  });

  test('an empty query returns everything, order preserved', () => {
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

  test('grouping is by origin, alphabetical, with Other last', () => {
    const groups = groupByOrigin([
      { name: 'zed:a', origin: 'zed' },
      { name: 'init' },
      { name: 'alpha:b', origin: 'alpha' },
      { name: 'zed:c', origin: 'zed' },
    ]);

    assert.deepStrictEqual(groups.map((g) => g.origin), ['alpha', 'zed', 'Other']);
    assert.deepStrictEqual(groups[1].entries.map((e) => e.name), ['zed:a', 'zed:c']);
  });

  test('grouping omits Other when every entry has an origin', () => {
    const groups = groupByOrigin([{ name: 'a:b', origin: 'a' }]);

    assert.deepStrictEqual(groups.map((g) => g.origin), ['a']);
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn compile-tests && npx mocha --ui tdd out/test/unit/invocable-menu.test.js`
Expected: FAIL — `Cannot find module '../../webview/lib/invocable-menu'`.

- [ ] **Step 3: Write the module**

Create `src/webview/lib/invocable-menu.ts`:

```ts
import type { Invocable } from '../../protocol/messages';

/**
 * Rows rendered at most. Bounded DOM instead of a windowing library — the
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
 * see the composer's submit path.
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

const OTHER = 'Other';

/**
 * Groups for the strip: one per origin, alphabetically, with unqualified
 * entries last under `Other`. Origin is the only grouping the provider can
 * support (there is no skill/command discriminator — see the spec).
 */
export function groupByOrigin(
  entries: Invocable[],
): { origin: string; entries: Invocable[] }[] {
  const groups = new Map<string, Invocable[]>();
  for (const entry of entries) {
    const key = entry.origin ?? OTHER;
    const bucket = groups.get(key);
    if (bucket) { bucket.push(entry); } else { groups.set(key, [entry]); }
  }

  const named = [...groups.entries()]
    .filter(([origin]) => origin !== OTHER)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([origin, list]) => ({ origin, entries: list }));

  const other = groups.get(OTHER);
  return other ? [...named, { origin: OTHER, entries: other }] : named;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS, all 15 new tests included.

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/invocable-menu.ts src/test/unit/invocable-menu.test.ts
git commit -m "feat: add invocable menu filtering, grouping and key logic"
```

---

### Task 7: Menu and strip in the UI

**Files:**
- Create: `src/webview/components/invocable-menu.tsx`
- Create: `src/webview/components/invocable-strip.tsx`
- Modify: `src/webview/components/composer.tsx:27-107`
- Modify: `src/webview/components/session-header.tsx:13-25`
- Modify: `src/webview/components/pane-group.tsx:95-108`

**Interfaces:**
- Consumes: everything from Task 6, `PaneState.invocables` (Task 5).
- Produces: `<InvocableMenu>` and `<InvocableStrip>`; `Composer` gains no new props (it already receives `pane`).

There is no DOM test harness in this project, so this task adds **no new logic** — every rule it applies already has a test in Task 6. Verification is manual, in the Extension Development Host.

- [ ] **Step 1: Write the menu component**

Create `src/webview/components/invocable-menu.tsx`:

```tsx
import { truncateName } from '../lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

export function InvocableMenu({ rows, overflow, active, onPick }: {
  rows: Invocable[];
  overflow: number;
  active: number;
  onPick: (entry: Invocable) => void;
}) {
  if (rows.length === 0) { return null; }

  return (
    <div
      role="listbox"
      aria-label="Skills and commands"
      className="mb-1 max-h-64 overflow-y-auto rounded border border-border bg-popover text-xs"
    >
      {rows.map((entry, i) => (
        <button
          key={entry.name}
          type="button"
          role="option"
          aria-selected={i === active}
          title={entry.name}
          // onMouseDown, not onClick: the composer textarea must not lose
          // focus before the pick is applied, or the menu closes on blur
          // and the click never lands.
          onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
          className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${
            i === active ? 'bg-accent' : ''
          }`}
        >
          <span className="font-medium">{truncateName(entry.name)}</span>
          {entry.description && (
            <span className="truncate text-muted-foreground">{entry.description}</span>
          )}
          {entry.origin && (
            <span className="ml-auto shrink-0 text-muted-foreground">{entry.origin}</span>
          )}
        </button>
      ))}
      {overflow > 0 && (
        <div className="px-2 py-1 text-muted-foreground">+{overflow} more</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the menu into the composer**

In `src/webview/components/composer.tsx`, add state and handlers. The full changed region:

```tsx
export function Composer({ pane, model }: { pane: PaneState; model: ModelInfo | undefined }) {
  const { post } = useStore();
  const [text, setText] = useState('');
  const [ghost, setGhost] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const running = pane.summary.status === 'running'
    || pane.summary.status === 'awaiting-approval';

  const entries = pane.invocables ?? [];
  const query = menuQuery(text);
  const open = query !== undefined && !dismissed && entries.length > 0;
  const view = open ? menuView(entries, query) : { rows: [], overflow: 0 };
  const index = Math.min(active, Math.max(0, view.rows.length - 1));

  const pick = (entry: Invocable) => {
    const { text: next, ghost: hint } = insertionFor(entry);
    setText(next);
    setGhost(hint);
    setActive(0);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) { return; }
    // `ghost` is presentation only — the arg hint must never be sent.
    post({ t: 'send', id: pane.summary.id, text: trimmed });
    setText('');
    setGhost('');
    setDismissed(false);
  };

  return (
    <div className="border-t border-border p-2">
      {open && (
        <InvocableMenu
          rows={view.rows}
          overflow={view.overflow}
          active={index}
          onPick={pick}
        />
      )}
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setGhost('');
            setActive(0);
            // Re-opening is by retyping `/` from empty, so a dismissal only
            // lasts as long as the current query.
            setDismissed(false);
          }}
          onKeyDown={(e) => {
            if (open) {
              const action = menuKeyAction(e.key);
              if (action !== 'pass') {
                e.preventDefault();
                if (action === 'move-down') { setActive(index + 1 >= view.rows.length ? 0 : index + 1); }
                if (action === 'move-up') { setActive(index - 1 < 0 ? view.rows.length - 1 : index - 1); }
                if (action === 'select') { pick(view.rows[index]); }
                if (action === 'close') { setDismissed(true); }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Message the agent…"
          aria-label="Message"
          className="resize-none text-sm"
        />
        {ghost && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-2 top-2 text-sm text-muted-foreground"
          >
            <span className="invisible">{text}</span>{ghost}
          </span>
        )}
      </div>
```

The rest of the component (the button row, effort select, permission-mode select) is unchanged, plus the extra closing `</div>` for the new `relative` wrapper.

Add the imports:

```tsx
import { InvocableMenu } from './invocable-menu';
import { insertionFor, menuKeyAction, menuQuery, menuView } from '../lib/invocable-menu';
import type { EffortLevel, Invocable, ModelInfo, PermissionMode } from '../../protocol/messages';
```

Three rules this encodes, each already covered by Task 6's tests: the menu never opens without entries; `menuKeyAction` returning `pass` releases every other key back to the composer, so Enter still sends; and `submit` sends `text` only.

- [ ] **Step 3: Write the strip component**

Create `src/webview/components/invocable-strip.tsx`:

```tsx
import { useState } from 'react';
import { groupByOrigin, truncateName } from '../lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

export function InvocableStrip({ entries }: { entries: Invocable[] }) {
  const [open, setOpen] = useState(false);
  // Absent, not empty: an archived session and a live one with nothing
  // available both render no strip at all.
  if (entries.length === 0) { return null; }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground"
      >
        {entries.length} commands
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 max-h-80 w-72 overflow-y-auto rounded border border-border bg-popover p-1">
          {groupByOrigin(entries).map((group) => (
            <div key={group.origin}>
              <div className="px-1 py-0.5 font-medium text-muted-foreground">{group.origin}</div>
              {group.entries.map((entry) => (
                <div key={entry.name} className="flex items-baseline gap-2 px-1 py-0.5" title={entry.name}>
                  <span>{truncateName(entry.name, 28)}</span>
                  {entry.description && (
                    <span className="truncate text-muted-foreground">{entry.description}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Mount the strip in the session header**

In `src/webview/components/session-header.tsx`, take the pane's catalog and render the strip before the model label:

```tsx
      <span className="ml-auto shrink-0 text-muted-foreground">
        {modelLabel}{s.effort ? ` · ${s.effort}` : ''}
      </span>
      <InvocableStrip entries={pane.invocables ?? []} />
```

Add `import { InvocableStrip } from './invocable-strip';`. `pane` is already a prop; nothing in `pane-group.tsx` changes unless the header's prop list does — verify it compiles and leave it untouched if so.

- [ ] **Step 5: Verify the build and the lint**

Run: `yarn check-types && yarn lint && yarn test:unit`
Expected: PASS.

- [ ] **Step 6: Verify by hand in the Extension Development Host**

Run: `yarn dev`

Check, with a Claude session open:
1. The header shows an `N commands` pill; clicking it lists groups with plugin names and `Other`.
2. Typing `/` opens the menu; typing `bra` narrows it; Escape closes it and leaves `/bra` in the box.
3. Arrow keys move the highlight; Enter inserts `/name ` and shows the arg hint as dim ghost text.
4. Typing after selection clears the ghost; sending delivers the message without the hint text.
5. With the menu closed, Enter still sends.
6. An archived session (closed, then re-shown from the roster) shows no pill and `/` opens nothing.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components src/webview/lib
git commit -m "feat: show skills and commands in the composer menu and header strip"
```

---

## Verification

After Task 7, the whole feature is exercised by:

```bash
yarn check-types && yarn lint && yarn test:unit
```

Spec requirements and where they are verified:

| Spec section | Verified by |
|---|---|
| Snapshot event, replace-whole | Task 2 (`a later snapshot replaces the earlier one wholesale`), Task 5 |
| Empty vs unknown | Task 2 (`an empty array is reported…`), Task 5 |
| Live-only lifecycle, hydrate replay | Task 2 (snapshot carries it), Task 3 (visibility gating, snapshot ordering) |
| No persistence | No `TranscriptStore` change in any task |
| Origin derivation | Task 4 (`map-commands` origin tests) |
| Claude mapping, `argumentHint: ''` | Task 4 |
| `commands_changed` | Task 4 (`map-events` tests) |
| Filtering and ranking | Task 6 |
| Trigger discipline, key claiming | Task 6 (`menuQuery`, `menuKeyAction`) |
| Insertion and ghost text | Task 6 (`insertionFor`), Task 7 Step 6 manual check |
| 50-row cap | Task 6 (`the view caps rows…`) |
| Middle truncation | Task 6 |
| Strip grouping, pill count, absent when empty | Task 6 (`groupByOrigin`), Task 7 Step 6 manual check |
