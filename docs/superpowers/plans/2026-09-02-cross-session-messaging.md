# Cross-session, cross-provider messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Marcode session send a message to another named session — across providers — via the existing loopback self-control MCP server, with the target renamable, discoverable, and both sides of the exchange readable in their own transcripts.

**Architecture:** Two new tools on `SelfControlMcpServer` (`marcode__list_sessions`, `marcode__send_message`) identify the calling session from a `sid` query param appended to every provider's existing per-run self-control URL (not a new per-session token). `AgentSession.send()` gains an optional `from` sender, threaded onto a normal `role: 'user'` transcript item on the recipient; the sender's own `send_message` tool call renders specially in `tool-render.ts`. Sessions gain a user-set, unique `name` alongside the existing auto `title`, editable from a new roster dialog, and preferred by the `@` mention menu.

**Tech Stack:** TypeScript, VS Code extension host (Node/CJS), React 19 + Tailwind v4 webview, `@modelcontextprotocol/sdk`, mocha (`suite`/`test`) for unit and DOM tests.

**Spec:** [docs/superpowers/specs/2026-09-02-cross-session-messaging-design.md](../specs/2026-09-02-cross-session-messaging-design.md)

## Global Constraints

- `src/protocol/messages.ts` stays types-only — no runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/`, and not `src/host/message-router.ts`, imports `vscode`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions — a failing provider/tool call reports through the existing transcript/tool-error paths, nothing rejects across `postMessage`.
- Filenames are kebab-case; component identifiers stay PascalCase.
- Raw HTML controls are forbidden in webview feature code — use `@/components/ui/*` (shadcn/Base UI) throughout; compose classNames with `cn`.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before a commit. Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`); commit after every task.
- DOM tests drive components through the real `StoreProvider` via `sendFromHost` — never mock `useStore` or hand-build `ClientState`.
- Never hand a DOM node/list to `assert.strictEqual(..., null)` — compare booleans/strings/counts instead (see `scripts/check-dom-null-asserts.mjs`).
- Any change under `src/webview/components/` gets run through the `impeccable` skill's detector (`node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>`) before being called done.

---

### Task 1: Protocol — session naming, `from`, `rename-session`, `StartOptions.sessionId`

**Files:**
- Modify: `src/protocol/messages.ts:157-223` (`SessionState`), `:43-67` (`TranscriptItem` user variant), `:445-447` (`WebviewToHost` setter cluster)
- Modify: `src/providers/types.ts:126-133` (`StartOptions`)
- Test: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Produces: `SessionState.name?: string`; `TranscriptItem` user variant's `from?: { sessionId: SessionId; name: string }`; `WebviewToHost` member `{ t: 'rename-session'; id: SessionId; name: string }`; `StartOptions.sessionId: SessionId`.

This task is pure type additions — no behavior yet — verified by a compile-level test that exercises each new field so a later task's real usage type-checks against something already proven to exist.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/protocol.test.ts` (create the file if it doesn't exist yet — check first; if it does, add this as a new `test` inside its existing `suite`):

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import type { SessionState, TranscriptItem, WebviewToHost } from '../../protocol/messages';
import type { StartOptions } from '../../providers/types';

suite('cross-session messaging protocol shapes', () => {
  test('SessionState carries an optional name', () => {
    const state: SessionState = {
      id: 's1', providerId: 'claude', model: 'sonnet', title: 'Untitled', name: 'a',
      cwd: '/tmp', status: 'idle', permissionMode: 'default', includeEditorContext: true,
      resumeTokens: {}, usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: 0, updatedAt: 0,
    };
    assert.strictEqual(state.name, 'a');
  });

  test('a user transcript item can carry a from sender', () => {
    const item: TranscriptItem = {
      id: 'u1', ts: 0, role: 'user', text: 'hi', from: { sessionId: 's2', name: 'b' },
    };
    assert.strictEqual(item.role === 'user' && item.from?.name, 'b');
  });

  test('rename-session is a WebviewToHost message', () => {
    const msg: WebviewToHost = { t: 'rename-session', id: 's1', name: 'a' };
    assert.strictEqual(msg.t, 'rename-session');
  });

  test('StartOptions carries a sessionId', () => {
    const opts: StartOptions = { cwd: '/tmp', permissionMode: 'default', sessionId: 's1' };
    assert.strictEqual(opts.sessionId, 's1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "cross-session messaging protocol shapes"`
Expected: FAIL — TypeScript errors, `name`/`from`/`rename-session`/`sessionId` do not exist on their respective types.

- [ ] **Step 3: Add the fields**

In `src/protocol/messages.ts`, inside `SessionState` (around line 162, right after `title: string;`):

```ts
  title: string;
  /**
   * User-set label, distinct from `title` (still auto-derived from the
   * first message). Defaults at creation so every session is addressable by
   * name before anyone renames it — see `SessionManager.create()`. Unique
   * per window, case-insensitive; enforced in `SessionManager.rename()`.
   */
  name: string;
```

In the `role: 'user'` member of `TranscriptItem` (around line 44-67), add after `attachments?: Attachment[];`:

```ts
      /**
       * Present when this turn was delivered by another session's
       * `marcode__send_message` call rather than typed by the human.
       * Captured at delivery time and never re-looked-up — same rule as
       * `SessionRef.title`: a transcript item describes what was true when
       * it was written.
       */
      from?: { sessionId: SessionId; name: string };
```

In the `WebviewToHost` union, right after the `set-include-context` member (around line 447):

```ts
  | { t: 'set-include-context'; id: SessionId; on: boolean }
  | { t: 'rename-session'; id: SessionId; name: string }
```

In `src/providers/types.ts`, inside `StartOptions` (around line 126-133), add:

```ts
export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** Provider-opaque. Never parsed by callers. */
  resumeToken?: string;
  /**
   * This run's owning session. Not provider-opaque like `resumeToken` — used
   * to identify the caller on the self-control MCP server, appended as a
   * `?sid=` query param onto that server's URL by each provider's own
   * self-control wiring. See `self-control-mcp-server.ts`.
   */
  sessionId: SessionId;
}
```

`StartOptions` doesn't currently import `SessionId` — add it to the existing type-only import at the top of `src/providers/types.ts` if not already present (check first).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "cross-session messaging protocol shapes"`
Expected: PASS

- [ ] **Step 5: Run the full type/lint gate**

Run: `yarn check-types`
Expected: FAILS at this point — `SessionState.name` is now required but `SessionManager.create()` (Task 2) doesn't set it yet, and every `provider.start()` call site is missing `sessionId`. This is expected; Task 2 and Task 6 fix the remaining call sites. Confirm the failures are exactly "missing property 'name'" in `session-manager.ts` and "missing property 'sessionId'" wherever `provider.start(...)`/`StartOptions` literals are built (note them, don't fix here).

- [ ] **Step 6: Commit**

```bash
git add src/protocol/messages.ts src/providers/types.ts src/test/unit/protocol.test.ts
git commit -m "feat: add SessionState.name, TranscriptItem.from, rename-session, StartOptions.sessionId"
```

---

### Task 2: `SessionManager` — default name, `rename()`, uniqueness

**Files:**
- Modify: `src/host/session-manager.ts:455-509` (`create()`)
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionState.name` (Task 1).
- Produces: `SessionManager.rename(id: SessionId, name: string): { ok: true } | { ok: false; reason: string }`. `create()` now also sets `state.name` to a default.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/session-manager.test.ts` (inside the existing suite, following its established fixture pattern — a temp-dir `TranscriptStore` and a `FakeProvider`, matching what's already at the top of that file):

```ts
test('create() gives every session a default, unique name', async () => {
  const s1 = await manager.create('fake', process.cwd());
  const s2 = await manager.create('fake', process.cwd());
  assert.strictEqual(s1.state.name.length > 0, true);
  assert.notStrictEqual(s1.state.name, s2.state.name);
});

test('rename() sets the name and reports it via summaries()', async () => {
  const s = await manager.create('fake', process.cwd());
  const result = manager.rename(s.state.id, 'my-session');
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(manager.summaries().find((x) => x.id === s.state.id)?.name, 'my-session');
});

test('rename() rejects a name already in use, case-insensitively', async () => {
  const s1 = await manager.create('fake', process.cwd());
  const s2 = await manager.create('fake', process.cwd());
  manager.rename(s1.state.id, 'taken');
  const result = manager.rename(s2.state.id, 'TAKEN');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(manager.summaries().find((x) => x.id === s2.state.id)?.name === 'TAKEN', false);
});

test('rename() allows a session to keep its own current name unchanged', async () => {
  const s = await manager.create('fake', process.cwd());
  manager.rename(s.state.id, 'mine');
  const result = manager.rename(s.state.id, 'mine');
  assert.deepStrictEqual(result, { ok: true });
});

test('rename() errors for an unknown session id', () => {
  const result = manager.rename('s-does-not-exist', 'x');
  assert.strictEqual(result.ok, false);
});
```

(Adjust `manager`/fixture variable names to match whatever this suite's existing `setup()`/`beforeEach` already exposes — read the file's current top-of-suite fixture before pasting, since the exact variable name isn't guessed here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "SessionManager"`
Expected: FAIL — `create()`'s returned state has no `.name` (or `undefined`), `manager.rename` is not a function.

- [ ] **Step 3: Implement**

In `src/host/session-manager.ts`, add near the top (after `newSessionId`, around line 29):

```ts
let nameCounter = 0;
/** `${providerId}-<short>` — every session is addressable by name from creation, before anyone renames it. */
function defaultName(providerId: string): string {
  return `${providerId}-${(nameCounter++).toString(36)}`;
}
```

In `create()` (around line 490-497), add `name: defaultName(providerId),` to the `state` literal, right after `title: 'Untitled',`:

```ts
    const state: SessionState = {
      id: newSessionId(), providerId, model: chosen.id, effort: resolvedEffort,
      title: 'Untitled', name: defaultName(providerId), cwd, status: 'idle', permissionMode: resolvedMode,
      includeEditorContext: true, resumeTokens: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
    };
```

Add a `rename()` method near `summaries()` (around line 403-405):

```ts
  /**
   * Renames a session. Unique per window, case-insensitive — the `@` mention
   * menu and `marcode__send_message` both address a session by this name, and
   * a collision would make one of two same-named rows silently unreachable.
   * A session keeping its own current name (any case) is not a collision.
   */
  rename(id: SessionId, name: string): { ok: true } | { ok: false; reason: string } {
    const state = this.meta.get(id);
    if (!state) { return { ok: false, reason: 'Unknown session.' }; }
    const trimmed = name.trim();
    if (trimmed.length === 0) { return { ok: false, reason: 'Name cannot be empty.' }; }
    const taken = [...this.meta.values()].some(
      (s) => s.id !== id && s.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken) { return { ok: false, reason: `"${trimmed}" is already in use.` }; }
    state.name = trimmed;
    state.updatedAt = Date.now();
    this.changed();
    return { ok: true };
  }
```

(`this.changed()` is the existing broadcast helper `create()` already calls at its own end — confirm its exact name at `session-manager.ts` before pasting; it's referenced as `this.changed();` in the `create()` excerpt already read.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "SessionManager"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: default session name at creation, SessionManager.rename()"
```

---

### Task 3: `message-router` — `rename-session` case

**Files:**
- Modify: `src/host/message-router.ts:309-313` (near `set-effort`), `:626-639` (`KNOWN_MESSAGE_TAGS`)
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `SessionManager.rename()` (Task 2), `WebviewToHost` `rename-session` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/message-router.test.ts`, following the file's existing pattern for a mutating case (look at its `set-effort` test for the exact fake-manager shape used there and mirror it):

```ts
test('rename-session calls manager.rename with the id and name', async () => {
  let seen: [string, string] | undefined;
  const manager = fakeManager({
    rename: (id: string, name: string) => { seen = [id, name]; return { ok: true }; },
  });
  const router = new MessageRouter(manager, /* ...whatever other ctor args the existing tests pass... */);
  await router.handle({ t: 'rename-session', id: 's1', name: 'new-name' });
  assert.deepStrictEqual(seen, ['s1', 'new-name']);
});
```

(Match this to whatever `fakeManager`/`MessageRouter` construction helper this test file already has — copy the exact pattern from the neighboring `set-effort` test rather than inventing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "rename-session"`
Expected: FAIL — `'rename-session'` is not a known case / `manager.rename` is not called.

- [ ] **Step 3: Implement**

In `src/host/message-router.ts`, add a case near `set-include-context` (after the block ending around line 330):

```ts
      case 'rename-session': {
        this.manager.rename(msg.id, msg.name);
        return;
      }
```

Add `'rename-session'` to `KNOWN_MESSAGE_TAGS` (around line 628, in the `'set-effort', 'set-permission-mode',` cluster):

```ts
  'set-effort', 'set-permission-mode', 'rename-session',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "rename-session"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: route rename-session to SessionManager.rename()"
```

---

### Task 4: `agent-session.ts` — thread `from` through `send()`/`deliver()`

**Files:**
- Modify: `src/host/agent-session.ts:320-342` (`send()`), `:399-429` (`deliver()`), and `QueuedMessage`'s definition site (`src/protocol/messages.ts:149-155`)
- Test: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Produces: `AgentSession.send(text, context?, refs?, fileRefs?, from?: { sessionId: SessionId; name: string }): void` — a delivered message's transcript item carries `from` when given.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/agent-session.test.ts` (mirror its existing `send()` test fixture — a `FakeProvider`, a temp `TranscriptStore`):

```ts
test('send() with a from sender appends a user item carrying it', async () => {
  const session = /* ...construct via this file's existing helper, matching other send() tests... */;
  session.send('hi from A', undefined, undefined, undefined, { sessionId: 's-a', name: 'a' });
  const snapshot = await session.snapshot();
  const item = snapshot.items.find((i) => i.role === 'user' && i.text === 'hi from A');
  assert.strictEqual(item?.role === 'user' && item.from?.name, 'a');
});

test('send() with no from sender omits the field entirely', async () => {
  const session = /* ...same helper... */;
  session.send('typed by human');
  const snapshot = await session.snapshot();
  const item = snapshot.items.find((i) => i.role === 'user' && i.text === 'typed by human');
  assert.strictEqual(item?.role === 'user' && 'from' in item, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "from sender"`
Expected: FAIL — TypeScript error, `send()` doesn't accept a 5th argument.

- [ ] **Step 3: Implement**

In `src/protocol/messages.ts`, add `from` to `QueuedMessage` (around line 149-155) so a message parked mid-turn doesn't lose its sender on delivery:

```ts
export interface QueuedMessage {
  id: string;
  text: string;
  refs?: SessionRef[];
  fileRefs?: FileRef[];
  attachments?: Attachment[];
  from?: { sessionId: SessionId; name: string };
}
```

In `src/host/agent-session.ts`, update `send()` (line 320):

```ts
  send(
    text: string, context?: EditorContext, refs?: SessionRef[], fileRefs?: FileRef[],
    from?: { sessionId: SessionId; name: string },
  ): void {
    if (!this.busy) { this.drainQueued(); }
    if (this.busy) {
      const attachments = this.drainLiveAttachments();
      const entry: QueuedMessage = {
        id: nextId('qm'),
        text,
        ...(refs && refs.length > 0 ? { refs } : {}),
        ...(fileRefs && fileRefs.length > 0 ? { fileRefs } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(from ? { from } : {}),
      };
      this._state.queued = [...(this._state.queued ?? []), entry];
      this.queuedContext.set(entry.id, context);
      this._state.updatedAt = Date.now();
      this.sink.changed();
      return;
    }
    this.deliver(text, context, refs, fileRefs, this.drainLiveAttachments(), from);
  }
```

Update `drainQueued()` (line 375) to pass the parked `from` through:

```ts
    this.deliver(head.text, context, head.refs, head.fileRefs, head.attachments ?? [], head.from);
```

Update `deliver()` (line 399):

```ts
  private deliver(
    text: string, context?: EditorContext, refs?: SessionRef[], fileRefs?: FileRef[],
    attachments: Attachment[] = [], from?: { sessionId: SessionId; name: string },
  ): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    const item: TranscriptItem = {
      id: nextId('u'), ts: Date.now(), role: 'user', text,
      ...(context ? { context } : {}),
      ...(refs && refs.length > 0 ? { refs } : {}),
      ...(fileRefs && fileRefs.length > 0 ? { fileRefs } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(from ? { from } : {}),
    };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    this.refreshActivityLabel();
    this.turnActive = true;
    const outgoing = this.seed ? `${this.seed}\n\n---\n\n${text}` : text;
    this.seed = undefined;
    try {
      this.run.send(outgoing, context, attachments.length > 0 ? attachments : undefined);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }
```

`SessionId` is already imported in `agent-session.ts` (used elsewhere in the file) — confirm, don't add a duplicate import.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "from sender"`
Expected: PASS

- [ ] **Step 5: Run the full unit suite for this file**

Run: `yarn test:unit --grep "AgentSession"`
Expected: PASS (no regression in the existing `send()`/queueing tests)

- [ ] **Step 6: Commit**

```bash
git add src/host/agent-session.ts src/protocol/messages.ts src/test/unit/agent-session.test.ts
git commit -m "feat: thread an optional sender through AgentSession.send()"
```

---

### Task 5: `AgentSession` passes `sessionId` to `provider.start()`

**Files:**
- Modify: `src/host/agent-session.ts:209-232` (constructor)
- Test: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `StartOptions.sessionId` (Task 1).
- Produces: every `provider.start()` call now receives `sessionId: _state.id`, satisfying the `check-types` failure noted in Task 1 Step 5 for this call site.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/agent-session.test.ts`:

```ts
test('constructor starts the provider with this session\'s own id', () => {
  let seenOpts: StartOptions | undefined;
  const provider = fakeProviderCapturingStart((opts) => { seenOpts = opts; });
  const state = /* ...this file's existing minimal SessionState fixture, with id 's-under-test'... */;
  new AgentSession(state, provider, store, sink);
  assert.strictEqual(seenOpts?.sessionId, 's-under-test');
});
```

(Use whatever fake-provider helper this test file already has for capturing `start()`'s argument — if none exists, add a minimal one following `FakeProvider`'s existing shape in `src/providers/fake/fake-provider.ts`, capturing the `StartOptions` it's called with.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "starts the provider with this session"`
Expected: FAIL — `seenOpts?.sessionId` is `undefined`.

- [ ] **Step 3: Implement**

In `src/host/agent-session.ts`, in the constructor (around line 215-218):

```ts
    this.run = provider.start({
      cwd: _state.cwd, model: _state.model, effort: _state.effort,
      permissionMode: _state.permissionMode, sessionId: _state.id,
      resumeToken: _state.resumeTokens[threadKey(provider.id, provider.threadScope, _state.cwd)],
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "starts the provider with this session"`
Expected: PASS

- [ ] **Step 5: Confirm the Task 1 compile gap is closed for this call site**

Run: `yarn check-types`
Expected: The `agent-session.ts` "missing sessionId" error from Task 1 Step 5 is gone. Remaining `StartOptions` literals without `sessionId` (in each provider's own tests, and any other direct `provider.start(...)` caller) are addressed in Task 6 — note but don't fix here.

- [ ] **Step 6: Commit**

```bash
git add src/host/agent-session.ts src/test/unit/agent-session.test.ts
git commit -m "feat: pass this session's id to provider.start()"
```

---

### Task 6: Providers — append `?sid=` to the self-control URL

**Files:**
- Modify: `src/providers/claude/claude-provider.ts:561-569`
- Modify: `src/providers/codex/codex-run.ts:445-454`
- Modify: `src/providers/acp/acp-run.ts:62-68` (`mcpServersFor`), and its two call sites at `:282`, `:340`
- Modify: `src/providers/opencode/opencode-provider.ts:184-195` (`start()`)
- Modify tests: `src/test/unit/claude-provider.test.ts:524-555`, `src/test/unit/codex-run.test.ts` (wherever the `mcp_servers` config override is asserted — the equivalent of `codex-provider.test.ts:523-536` but for `CodexRun` directly, since the URL construction lives in `codex-run.ts`), `src/test/unit/acp-run.test.ts:105-125`, `src/test/unit/opencode-provider.test.ts:165-180`

**Interfaces:**
- Consumes: `StartOptions.sessionId` (Task 1). `SelfControlMcpConfig` (`{ url, token }`, unchanged shape).

This task does **not** touch any provider constructor, `SelfControlMcpConfig`'s shape, or `extension.ts` — only the per-run URL-building sites, all of which already close over a per-run options object.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/claude-provider.test.ts`, extend the existing `'start() adds the self-control MCP server to mcpServers when configured'` test (around line 524-536) — after its existing assertions, add:

```ts
    assert.strictEqual(
      built.mcpServers?.marcode_self_control?.url,
      'http://127.0.0.1:1234/mcp?sid=s-under-test',
    );
```

(Ensure the `provider.start({...})` call in that test passes `sessionId: 's-under-test'` — add it to the existing call's argument object if not already required by Task 1's `StartOptions`.)

In `src/test/unit/acp-run.test.ts`, extend `'newSession includes the self-control MCP server when configured'` (around line 105-117): add `sessionId: 's-under-test'` to the `AcpRunOptions` literal passed to `new AcpRun(...)`, and assert the built `mcpServers[0].url` ends with `?sid=s-under-test`.

In `src/test/unit/opencode-provider.test.ts`, extend `'start() passes the self-control MCP config through to the AcpRun it builds'` (around line 165-178): pass `sessionId: 's-under-test'` in the `provider.start({...})` call, assert the `AcpRunOptions` the recorded `AcpRun` constructor received has `sessionId: 's-under-test'` (so `AcpRun` itself, not `OpenCodeProvider`, does the URL-building — see Step 3).

For Codex: find the existing test asserting the `mcp_servers` config override in `src/test/unit/codex-run.test.ts` (search for `bearer_token_env_var` or `marcode_self_control` in that file — if the assertion currently lives only in `codex-provider.test.ts:523-536` against the provider's `start()`, extend that one instead, adding `sessionId` and asserting the resulting `url` carries `?sid=`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "self-control"`
Expected: FAIL — none of the built URLs carry `?sid=` yet.

- [ ] **Step 3: Implement — Claude**

In `src/providers/claude/claude-provider.ts`, inside `buildOptions()` (around line 561-569), change:

```ts
        ...(this.selfControlMcp ? {
          mcpServers: {
            marcode_self_control: {
              type: 'http' as const,
              url: `${this.selfControlMcp.url}?sid=${encodeURIComponent(opts.sessionId)}`,
              headers: { authorization: `Bearer ${this.selfControlMcp.token}` },
            },
          },
        } : {}),
```

(`opts` is `buildOptions`'s enclosing `start(opts: StartOptions)` parameter, already in scope — no signature change.)

- [ ] **Step 4: Implement — Codex**

In `src/providers/codex/codex-run.ts`, inside `startThread()` (around line 445-454), change:

```ts
      ...(this.opts.selfControlMcp ? {
        config: {
          mcp_servers: {
            marcode_self_control: {
              url: `${this.opts.selfControlMcp.url}?sid=${encodeURIComponent(this.opts.sessionId)}`,
              bearer_token_env_var: 'MARCODE_SELF_CONTROL_TOKEN',
            },
          },
        },
      } : {}),
```

`CodexRunOptions extends StartOptions` (confirmed at `codex-run.ts:50-53`), so `this.opts.sessionId` is already typed and populated once `CodexProvider.start()` spreads its `StartOptions` argument through (it already does — no change needed there).

- [ ] **Step 5: Implement — ACP (Claude-ACP-shaped agents and OpenCode)**

In `src/providers/acp/acp-run.ts`, `AcpRunOptions` (around line 34-54) is **not** `StartOptions`-derived — add `sessionId: SessionId` directly to it:

```ts
export interface AcpRunOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resumeToken?: string;
  tools: ToolMapper;
  modeId(mode: PermissionMode): string | undefined;
  clientName: string;
  /** This run's owning session — appended to the self-control URL below. */
  sessionId: SessionId;
  /** The loopback MCP server this run's agent should connect to, if any. */
  selfControlMcp?: SelfControlMcpConfig;
}
```

Update `mcpServersFor` (around line 62-68) to take the session id and append it:

```ts
function mcpServersFor(config: SelfControlMcpConfig | undefined, sessionId: SessionId): unknown[] {
  if (!config) { return []; }
  return [{
    type: 'http', name: 'marcode-self-control',
    url: `${config.url}?sid=${encodeURIComponent(sessionId)}`,
    headers: [{ name: 'Authorization', value: `Bearer ${config.token}` }],
  }];
}
```

Update both call sites (around line 282 and 340) to pass `this.opts.sessionId`:

```ts
        const created = await conn.newSession({
          cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp, this.opts.sessionId),
        });
```

```ts
      const rpc = conn.loadSession({
        sessionId, cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp, this.opts.sessionId),
      })
```

(The local variable named `sessionId` at the second call site is the ACP protocol's own session id, unrelated to `this.opts.sessionId` — do not conflate them; `this.opts.sessionId` is Marcode's `SessionId`.)

Add `SessionId` to `acp-run.ts`'s existing type-only import from `../../protocol/messages` (or wherever it currently sources its shared types — check the file's import block first).

- [ ] **Step 6: Implement — OpenCode's translation from `StartOptions` to `AcpRunOptions`**

In `src/providers/opencode/opencode-provider.ts`, inside `start(opts: StartOptions)` (around line 184-195), add `sessionId: opts.sessionId,` to the `AcpRunOptions` literal:

```ts
  start(opts: StartOptions): AgentRun {
    const child = this.spawn(this.binPath ?? 'opencode', this.mergedEnv());
    return new AcpRun(child, {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      resumeToken: opts.resumeToken,
      sessionId: opts.sessionId,
      tools: openCodeTools,
      modeId: openCodeModeId,
      clientName: 'mar-code',
      selfControlMcp: this.selfControlMcp,
    });
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn test:unit --grep "self-control"`
Expected: PASS

- [ ] **Step 8: Close the remaining Task 1 compile gap**

Run: `yarn check-types`
Expected: PASS with zero errors — every `StartOptions`/`AcpRunOptions` construction site across providers and their tests now supplies `sessionId`. Fix any remaining test call site that still omits it (add `sessionId: 'test-session'` or similar) before moving on.

- [ ] **Step 9: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/providers/codex/codex-run.ts \
  src/providers/acp/acp-run.ts src/providers/opencode/opencode-provider.ts \
  src/test/unit/claude-provider.test.ts src/test/unit/codex-run.test.ts \
  src/test/unit/acp-run.test.ts src/test/unit/opencode-provider.test.ts src/test/unit/codex-provider.test.ts
git commit -m "feat: identify the calling session to self-control MCP via a sid query param"
```

---

### Task 7: `self-control-mcp-server.ts` — resolve caller, `marcode__list_sessions`, `marcode__send_message`

**Files:**
- Modify: `src/host/self-control-mcp-server.ts`
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: `SessionManager.summaries()` (existing, now includes `name`), `SessionManager.get(id)` returning an `AgentSession`-shaped object with `interrupt(): Promise<void>` and `send(text, ..., from?)` (existing methods, Task 4 added the last parameter).
- Produces: `SessionManagerLike` gains `summaries()` and `get(id)`; two new tools on the server.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/self-control-mcp-server.test.ts`. First, extend `fakeManager()` (around line 13-21) to satisfy the widened `SessionManagerLike`:

```ts
function fakeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    catalog: () => [
      { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }] },
    ],
    create: async () => ({ state: { id: 's-fake-1' } }),
    summaries: () => [],
    get: () => undefined,
    ...overrides,
  };
}
```

Add a `sid`-aware call helper next to the existing `callTool()` (around line 23-39):

```ts
async function callToolAs(
  config: SelfControlMcpConfig, sid: string, name: string, args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await fetch(`${config.url}?sid=${sid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  return body.result;
}
```

New suite:

```ts
suite('SelfControlMcpServer cross-session messaging', () => {
  test('marcode__list_sessions returns name/providerId/status/cwd for non-archived sessions', async () => {
    const manager = fakeManager({
      summaries: () => [
        { id: 's1', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w1', archived: false } as never,
        { id: 's2', name: 'b', providerId: 'codex', status: 'running', cwd: '/w2', archived: true } as never,
      ],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callTool(config, 'marcode__list_sessions', {});
    const list = JSON.parse(result.content[0].text) as { name: string }[];
    assert.deepStrictEqual(list.map((s) => s.name), ['a']);
    await server.dispose();
  });

  test('send_message resolves the caller from sid, delivers to the named target', async () => {
    let interrupted = false;
    let sent: unknown[] = [];
    const target = { interrupt: async () => { interrupted = true; }, send: (...args: unknown[]) => { sent = args; } };
    const manager = fakeManager({
      summaries: () => [
        { id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never,
        { id: 's-target', name: 'b', providerId: 'codex', status: 'idle', cwd: '/w', archived: false } as never,
      ],
      get: (id: string) => (id === 's-target' ? target as never : undefined),
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'b', text: 'do the thing' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(interrupted, true);
    assert.strictEqual(sent[0], 'do the thing');
    assert.deepStrictEqual(sent[4], { sessionId: 's-caller', name: 'a' });
    await server.dispose();
  });

  test('send_message errors on an unknown target name', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'nobody', text: 'hi' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('send_message errors when to equals the caller\'s own name', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'a', text: 'hi' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('send_message errors when sid is missing or unrecognized', async () => {
    const manager = fakeManager();
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const missing = await callTool(config, 'marcode__send_message', { to: 'b', text: 'hi' });
    assert.strictEqual(missing.isError, true);
    const unknown = await callToolAs(config, 's-ghost', 'marcode__send_message', { to: 'b', text: 'hi' });
    assert.strictEqual(unknown.isError, true);
    await server.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "cross-session messaging"`
Expected: FAIL — `marcode__list_sessions`/`marcode__send_message` are unregistered tools.

- [ ] **Step 3: Implement**

In `src/host/self-control-mcp-server.ts`, widen `SessionManagerLike` (around line 17-22):

```ts
export interface SessionManagerLike {
  catalog(): { id: string; models: { id: string }[]; permissionModes: { id: string }[] }[];
  create(
    providerId: string, cwd: string, model?: string, effort?: undefined, mode?: PermissionMode,
  ): Promise<{ state: { id: string } }>;
  /** Every non-archived session's addressable identity — see `marcode__list_sessions`. */
  summaries(): { id: string; name: string; providerId: string; status: string; cwd: string; archived: boolean }[];
  /** A live session, if any — used to resolve the caller's own identity and to deliver to a target. */
  get(id: string): {
    interrupt(): Promise<void>;
    send(text: string, context?: unknown, refs?: unknown, fileRefs?: unknown,
      from?: { sessionId: string; name: string }): void;
  } | undefined;
}
```

Change `start()`'s request handler (around line 168-193) to read `sid` off the request URL and pass it into `buildMcpServer`:

```ts
  async start(): Promise<SelfControlMcpConfig> {
    const http = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      const sid = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('sid') ?? undefined;
      const mcp = this.buildMcpServer(sid);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => { void transport.close(); });
      void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch((err: unknown) => {
        console.error('[mar-code] self-control MCP request failed', err);
        if (!res.headersSent) { res.writeHead(500).end(); }
      });
    });

    const port = await this.listen(http);
    this.http = http;
    return { url: `http://127.0.0.1:${port}/mcp`, token: this.token };
  }
```

Change `buildMcpServer` to take `sid` and register the two new tools (around line 58 onward):

```ts
  private buildMcpServer(sid: string | undefined): McpServer {
    const mcp = new McpServer({ name: 'marcode-self-control', version: '1.0.0' });

    /** The calling session's own name, resolved from `sid` — undefined if `sid` is missing or stale. */
    const caller = () => {
      if (!sid) { return undefined; }
      return this.sessionManager.summaries().find((s) => s.id === sid && !s.archived);
    };

    // ...existing marcode__spawn_session registration unchanged...

    mcp.registerTool(
      'marcode__list_sessions',
      {
        title: 'List Marcode sessions',
        description: 'Lists this window\'s live sessions by name, so marcode__send_message can address one.',
        inputSchema: {},
      },
      async () => {
        const sessions = this.sessionManager.summaries()
          .filter((s) => !s.archived)
          .map((s) => ({ name: s.name, providerId: s.providerId, status: s.status, cwd: s.cwd }));
        return { content: [{ type: 'text', text: JSON.stringify(sessions) }] };
      },
    );

    mcp.registerTool(
      'marcode__send_message',
      {
        title: 'Send a message to another Marcode session',
        description: 'Delivers text to a named session, interrupting it if it is mid-turn. Delivery is '
          + 'immediate and does not wait for a reply — a reply, if any, is that session calling '
          + 'marcode__send_message back.',
        inputSchema: {
          to: z.string().describe('The target session\'s name, from marcode__list_sessions.'),
          text: z.string().describe('The message to deliver.'),
        },
      },
      async ({ to, text }) => {
        const from = caller();
        if (!from) {
          return { isError: true, content: [{ type: 'text', text: 'Could not identify the calling session.' }] };
        }
        if (to === from.name) {
          return { isError: true, content: [{ type: 'text', text: 'Cannot send a message to yourself.' }] };
        }
        const target = this.sessionManager.summaries().find((s) => s.name === to && !s.archived);
        if (!target) {
          return { isError: true, content: [{ type: 'text', text: `Unknown session: ${to}` }] };
        }
        const session = this.sessionManager.get(target.id);
        if (!session) {
          return { isError: true, content: [{ type: 'text', text: `Session ${to} is not available.` }] };
        }
        await session.interrupt();
        session.send(text, undefined, undefined, undefined, { sessionId: from.id, name: from.name });
        return { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
      },
    );

    // ...existing marcode__recall / marcode__recall_fetch registration unchanged...
    return mcp;
  }
```

(Splice the new registrations in alongside the existing `spawn_session`/`recall`/`recall_fetch` ones already in this method — don't remove or reorder those; add `caller`'s `sid`-resolution helper once, near the top of the method, and update `buildMcpServer`'s one call site in `start()` per the snippet above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "SelfControlMcpServer"`
Expected: PASS (both the new suite and every existing one — `spawn_session`/`recall` tests call the server with no `sid`, which must keep working unaffected since those tools never call `caller()`)

- [ ] **Step 5: Commit**

```bash
git add src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts
git commit -m "feat: marcode__list_sessions and marcode__send_message self-control tools"
```

---

### Task 8: `SessionManager` real-integration test for `send_message`

**Files:**
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5, 7 — this task adds no production code, only the end-to-end regression test the spec's "Testing" section calls for (mirroring the existing `'a real tool call against a real SessionManager...'` test at line 125-176).

- [ ] **Step 1: Write the test**

Add to `src/test/unit/self-control-mcp-server.test.ts`, in the cross-session-messaging suite, following the exact fixture pattern of the existing real-`SessionManager` test (temp dir, real `TranscriptStore`, `FakeProvider`, real `SessionManager`):

```ts
test('a real send_message call delivers into the target session\'s real transcript, tagged with from', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-self-control-msg-'));
  const store = new TranscriptStore(dir);
  const provider = new FakeProvider(() => [
    { kind: 'text', delta: 'ok' },
    { kind: 'turn-end', reason: 'done' },
  ]);
  const providers = new Map<string, AgentProvider>([['fake', provider]]);
  const manager = new SessionManager(store, providers, () => { });
  await manager.init();

  try {
    const a = await manager.create('fake', process.cwd());
    const b = await manager.create('fake', process.cwd());
    manager.rename(a.state.id, 'sender');
    manager.rename(b.state.id, 'receiver');

    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const res = await fetch(`${config.url}?sid=${a.state.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'marcode__send_message', arguments: { to: 'receiver', text: 'please do X' } },
      }),
    });
    const body = await res.json() as { result: { isError?: boolean } };
    assert.strictEqual(body.result.isError, undefined);

    const snapshot = await manager.get(b.state.id)!.snapshot();
    const item = snapshot.items.find((i) => i.role === 'user' && i.text === 'please do X');
    assert.strictEqual(item?.role === 'user' && item.from?.name, 'sender');
    await server.dispose();
  } finally {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `yarn test:unit --grep "real send_message call"`
Expected: PASS — if it fails, the break is in the wiring between Tasks 2/4/5/7, not in this test; re-check each task's implementation before altering assertions.

- [ ] **Step 3: Commit**

```bash
git add src/test/unit/self-control-mcp-server.test.ts
git commit -m "test: end-to-end send_message delivery through a real SessionManager"
```

---

### Task 9: `tool-render.ts` — `marcode__send_message` rendering

**Files:**
- Modify: `src/webview/components/tool-render.ts:139-143` (`describeTool`'s `'mcp'` case), `:245-248`-ish (`describeInput`'s `'mcp'` case — confirm exact line before editing)
- Test: `src/test/unit/tool-render.test.ts` (create if it doesn't exist — check first; if a `tool-render.test.ts` already exists, add to its suite)

**Interfaces:**
- Consumes: `ToolCall` kind `'mcp'` (`{ kind: 'mcp'; label: string; server: string; tool: string }`, unchanged).
- Produces: no new exported symbols — `describeTool`/`describeInput` behavior changes only for `tool.tool === 'marcode__send_message'`.

This is the one deliberate, documented exception to "nothing here branches on a tool's name" — see the spec's section D. Do not generalize this into a lookup table for other tool names; a second exception should become a `ToolCall` kind instead.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { describeInput, describeTool } from '../../webview/components/tool-render';
import type { ToolCall } from '../../protocol/messages';

suite('tool-render marcode__send_message', () => {
  const tool: ToolCall = {
    kind: 'mcp', label: 'MCP', server: 'marcode-self-control', tool: 'marcode__send_message',
  };

  test('describeTool shows "Sent to <name>"', () => {
    const header = describeTool(tool);
    assert.strictEqual(header.primary.startsWith('Sent to'), true);
  });

  test('describeInput surfaces the target and the message text', () => {
    // The MCP tool's raw JSON-RPC arguments aren't on ToolCall itself in this
    // canonical shape — confirm with the real provider adapter (map-tools.ts)
    // how an MCP call's arguments actually reach describeInput before writing
    // this assertion; if they don't reach it at all today, that's a
    // discovery this step should surface, not paper over — flag it and widen
    // ToolCall's 'mcp' arm with an `input?: Record<string, unknown>` field
    // (mirroring how `'other'` already carries `fields`) rather than
    // rendering from nothing.
    const blocks = describeInput(tool);
    assert.strictEqual(Array.isArray(blocks), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "marcode__send_message"`
Expected: FAIL on the `describeTool` assertion — `header.primary` is currently `tool.tool` verbatim (`'marcode__send_message'`), not `'Sent to...'`.

- [ ] **Step 3: Investigate before implementing**

Read `src/providers/canonical/tool-call.ts`'s `'mcp'` arm (`{ kind: 'mcp'; label: string; server: string; tool: string }`, confirmed at line 57) against whichever provider adapter builds it (search `kind: 'mcp'` in `src/providers/*/map-tools.ts` and `src/providers/claude/map-events.ts`) to see whether the MCP call's raw arguments (`to`, `text`) are captured anywhere on the canonical `ToolCall`, or dropped at classification. They are very likely **not** currently captured — the `'mcp'` arm's own doc comment (tool-render.ts:140-142) treats the tool name as the only interesting field.

If they are dropped: widen the `'mcp'` arm in `src/providers/canonical/tool-call.ts` to `{ kind: 'mcp'; label: string; server: string; tool: string; input?: Record<string, unknown> }`, and update whichever adapter builds it to pass the call's raw arguments through unconditionally (harmless for every other MCP tool — `describeInput`'s generic `'mcp'` case can keep ignoring `input` for tools other than `marcode__send_message`). This is a small, justified widening of an existing type, not new scope — the spec's "Sent to `<to>`: `<text>`" line depends on it.

- [ ] **Step 4: Implement**

In `src/providers/canonical/tool-call.ts`, widen the `'mcp'` member (line 57):

```ts
  | { kind: 'mcp'; label: string; server: string; tool: string; input?: Record<string, unknown> }
```

Wire `input` through in whichever adapter builds this arm (found in Step 3) — pass the tool call's raw arguments object as-is.

In `src/webview/components/tool-render.ts`, `describeTool`'s `'mcp'` case (line 139-143):

```ts
    case 'mcp': {
      // The one deliberate exception to "nothing here branches on a tool's
      // name" — see the spec's section D. A second tool needing
      // name-specific rendering should become a ToolCall kind of its own
      // instead of a second exception here.
      if (tool.tool === 'marcode__send_message') {
        const to = typeof tool.input?.to === 'string' ? tool.input.to : '';
        return header('send', tool.label, `Sent to ${to}`, false);
      }
      // The server already has its own chip in `tool-card.tsx`, inches to the
      // left — repeating it here read as `[wrench] github Call tool github ·
      // list_repos` at 300px. The tool name alone is the primary.
      return header('wrench', tool.label, tool.tool, false);
    }
```

`describeInput`'s `'mcp'` case (find its exact current body first — the earlier explore pass located it around line 245-248 but did not quote it; read it before editing):

```ts
    case 'mcp':
      if (tool.tool === 'marcode__send_message') {
        const text = typeof tool.input?.text === 'string' ? tool.input.text : '';
        if (text) { blocks.push({ kind: 'note', text }); }
        break;
      }
      // ...existing generic mcp input rendering, unchanged...
      break;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:unit --grep "marcode__send_message"`
Expected: PASS. Also run: `yarn test:unit --grep "tool-render"` to confirm no regression in the generic `'mcp'` rendering for other tools (e.g. `spawn_session`, `recall`).

- [ ] **Step 6: Commit**

```bash
git add src/providers/canonical/tool-call.ts src/webview/components/tool-render.ts src/test/unit/tool-render.test.ts
# plus whichever map-tools.ts / map-events.ts file Step 3 identified
git commit -m "feat: render marcode__send_message tool calls as 'Sent to <name>'"
```

---

### Task 10: Transcript rendering of `from`

**Files:**
- Modify: `src/webview/components/transcript-item.tsx:127-183` (`UserItem`)
- Test: `src/test/dom/transcript-item.test.tsx` (or the existing DOM test file covering `UserItem` — check `src/test/dom/` for one first, e.g. alongside `question-card.test.tsx`, `relocation-card.test.tsx`; if none exists for plain user items, create one following `src/test/dom/harness.tsx`'s pattern)

**Interfaces:**
- Consumes: `TranscriptItem`'s `from` field (Task 1).

- [ ] **Step 1: Write the failing test**

Following `src/test/dom/harness.tsx`'s pattern (mount via `sendFromHost`, real `StoreProvider`, assert on strings/booleans/counts — never a DOM node):

```tsx
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { screen } from '@testing-library/dom';
import { mountWithSession, sendFromHost } from './harness'; // match whatever this suite's existing DOM tests actually import

suite('transcript-item from sender', () => {
  test('a delivered message shows "Message from <name>" instead of "You"', async () => {
    const { sessionId } = await mountWithSession();
    sendFromHost({
      t: 'session-patch', id: sessionId,
      patch: {
        op: 'append',
        item: {
          id: 'u1', ts: 0, role: 'user', text: 'do the thing',
          from: { sessionId: 's-other', name: 'sender' },
        },
      },
    });
    assert.strictEqual(screen.queryByText('Message from sender') !== null, true);
    assert.strictEqual(screen.queryByText('You') === null, true);
  });

  test('a human-typed message still shows "You"', async () => {
    const { sessionId } = await mountWithSession();
    sendFromHost({
      t: 'session-patch', id: sessionId,
      patch: { op: 'append', item: { id: 'u2', ts: 0, role: 'user', text: 'hi' } },
    });
    assert.strictEqual(screen.queryByText('You') !== null, true);
  });
});
```

(Adjust the mount/send helper names to whatever `src/test/dom/harness.tsx` actually exports — read it first; this plan describes the intent, the harness's real exports are the source of truth for exact call shapes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "from sender"`
Expected: FAIL — label always reads "You".

- [ ] **Step 3: Implement**

In `src/webview/components/transcript-item.tsx`, `UserItem` (line 127-143), change the shell's `label`:

```tsx
function UserItem({
  item, onFork,
}: {
  item: Extract<TranscriptItem, { role: 'user' }>;
  onFork?: () => void;
}) {
  const { post } = useStore();
  const ctx = item.context;
  const { prose, blocks } = splitComposed(item.text, item.refs ?? [], item.fileRefs ?? []);

  return (
    <TranscriptItemShell
      role="user"
      label={item.from ? `Message from ${item.from.name}` : 'You'}
      ts={item.ts}
      onFork={onFork}
    >
```

(No other change in this function — everything below the shell's opening tag stays exactly as it is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:dom --grep "from sender"`
Expected: PASS

- [ ] **Step 5: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/transcript-item.tsx`
Expected: exit 0. If exit 2, fix the flagged findings before continuing (resolve the actual `<impeccable-skill-dir>` path in this repo's `.claude` setup first).

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/transcript-item.tsx src/test/dom/transcript-item.test.tsx
git commit -m "feat: render a distinct label for a message delivered by another session"
```

---

### Task 11: Roster — rename dialog

**Files:**
- Create: `src/webview/components/rename-session-dialog.tsx`
- Modify: `src/webview/components/session-row.tsx`
- Test: `src/test/dom/rename-session-dialog.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary.name` (Task 1), posts `{ t: 'rename-session'; id: SessionId; name: string }` (Task 1/3).

- [ ] **Step 1: Write the failing test**

```tsx
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { fireEvent, screen } from '@testing-library/dom';
import { mountWithSession } from './harness'; // match the real harness export used by session-row's own existing DOM tests, if any

suite('rename session', () => {
  test('opening the rename dialog and submitting a new name posts rename-session', async () => {
    const { sessionId, posted } = await mountWithSession({ name: 'old-name' });
    fireEvent.click(screen.getByLabelText(`More actions for old-name`));
    fireEvent.click(screen.getByText('Rename…'));
    const input = screen.getByLabelText('New name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new-name' } });
    fireEvent.click(screen.getByText('Save'));
    assert.strictEqual(
      posted.some((m) => m.t === 'rename-session' && m.id === sessionId && m.name === 'new-name'),
      true,
    );
  });
});
```

(As with prior DOM tasks, confirm `mountWithSession`/`posted`-capturing shape against `src/test/dom/harness.tsx`'s real exports before finalizing this test — the plan states intent, the harness is authoritative for call shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "rename session"`
Expected: FAIL — no "Rename…" item exists yet.

- [ ] **Step 3: Implement the dialog**

Create `src/webview/components/rename-session-dialog.tsx`, following `bring-back-dialog.tsx`'s `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`/`DialogClose` composition and `session-create-dialog.tsx`'s controlled `Input` usage:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

/**
 * Renames a session. Names are unique per window (case-insensitive,
 * enforced host-side by `SessionManager.rename`) — the only client-side
 * validation here is non-empty, so an obviously bad submission never leaves
 * the composer, but a collision is still reported by the host, since only it
 * knows the full live roster.
 */
export function RenameSessionDialog({
  session, open, onOpenChange,
}: { session: SessionSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { post } = useStore();
  const [value, setValue] = useState(session.name);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) { setValue(session.name); } onOpenChange(next); }}>
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          <div className="border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">Rename session</DialogTitle>
          </div>
        </DialogHeader>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">New name</span>
          <Input
            aria-label="New name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={value.trim().length === 0}
            onClick={() => {
              post({ t: 'rename-session', id: session.id, name: value.trim() });
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire the trigger into `SessionRow`**

Modify `src/webview/components/session-row.tsx` to add local `open` state and a "Rename…" item in the actions submenu, above "Delete…":

```tsx
import { useState } from 'react';
import { MoreHorizontalIcon } from 'lucide-react';
import {
  DropdownMenuCheckboxItem, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { RenameSessionDialog } from './rename-session-dialog';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

export function SessionRow({
  session, open, onToggle,
}: {
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { post } = useStore();
  const [renameOpen, setRenameOpen] = useState(false);

  return (
    <div className="group/row flex items-center gap-1">
      <DropdownMenuCheckboxItem
        checked={open}
        onCheckedChange={onToggle}
        className="min-w-0 flex-1"
      >
        <span className="truncate">{session.title}</span>
      </DropdownMenuCheckboxItem>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={`More actions for ${session.name}`}
          className="shrink-0 opacity-0 [&>svg:last-child]:hidden group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
        >
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => setRenameOpen(true)}>
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => post({ t: 'close-session', id: session.id })}>
            Archive {session.title}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger aria-label={`Delete session ${session.title}`}>
              Delete…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Keep it</DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => post({ t: 'delete-session', id: session.id })}
              >
                Delete {session.title}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <RenameSessionDialog session={session} open={renameOpen} onOpenChange={setRenameOpen} />
    </div>
  );
}
```

(The `aria-label` on the actions trigger switches from `session.title` to `session.name` here since the test in Step 1 looks it up by name — `name` is always present and unique, unlike `title`, which starts as `'Untitled'` for every session and stays that way until a first send.)

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:dom --grep "rename session"`
Expected: PASS

- [ ] **Step 6: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/rename-session-dialog.tsx src/webview/components/session-row.tsx`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/rename-session-dialog.tsx src/webview/components/session-row.tsx \
  src/test/dom/rename-session-dialog.test.tsx
git commit -m "feat: rename a session from the roster"
```

---

### Task 12: `@` mentions prefer `name` over `title`

**Files:**
- Modify: `src/webview/lib/session-mentions.ts:47-84`
- Test: `src/test/unit/session-refs.test.ts` (or wherever `sessionMentions` is currently unit-tested — check that file first)

**Interfaces:**
- Consumes: `SessionSummary.name` (Task 1).
- Produces: no signature change to `sessionMentions` — only which field it reads for `label`/`baseToken`.

- [ ] **Step 1: Write the failing test**

```ts
test('sessionMentions labels a renamed session by its name, not its title', () => {
  const sessions: SessionSummary[] = [
    fakeSession({ id: 's1', title: 'Untitled', name: 'renamed-one' }),
  ];
  const options = sessionMentions(sessions, 's-self', false);
  assert.strictEqual(options.find((o) => o.id === 's1')?.label, 'renamed-one');
});

test('sessionMentions still disambiguates two sessions sharing a default name', () => {
  const sessions: SessionSummary[] = [
    fakeSession({ id: 's1', title: 'Untitled', name: 'claude-1' }),
    fakeSession({ id: 's2', title: 'Untitled', name: 'claude-1' }),
  ];
  const options = sessionMentions(sessions, 's-self', false);
  assert.notStrictEqual(
    options.find((o) => o.id === 's1')?.label,
    options.find((o) => o.id === 's2')?.label,
  );
});
```

(Use whatever `fakeSession`/`SessionSummary` fixture helper this test file already has for building a minimal summary — it will need updating to require `name` regardless, per Task 1.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "sessionMentions"`
Expected: FAIL — label currently reads `title` (`'Untitled'`), not `name`.

- [ ] **Step 3: Implement**

In `src/webview/lib/session-mentions.ts` (around line 62-82), swap the label source from `s.title` to `s.name` (the collision-counting and `slug()` calls follow the same swap):

```ts
  const referable = sessions.filter((s) => s.id !== selfId && !s.archived);
  const seen = new Map<string, number>();
  for (const s of referable) { seen.set(s.name, (seen.get(s.name) ?? 0) + 1); }

  for (const s of referable) {
    options.push({
      id: s.id,
      label: (seen.get(s.name) ?? 0) > 1 ? `${s.name} (${shortId(s.id)})` : s.name,
      hint: 'last reply',
      group: 'Sessions',
      baseToken: slug(s.name),
      payload: {
        kind: 'session-ref',
        ref: { sessionId: s.id, kind: 'message', title: s.name },
      },
    });
  }
```

The comment above this block (originally explaining the `title`-collision problem) should be updated to reflect that `name` is now unique by construction (Task 2's `rename()`), so the collision path only fires for two sessions that both still hold their *default* auto-generated names — still possible in principle if `defaultName`'s counter ever repeats across a reload, so the suffix logic stays as a safety net, not dead code.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "sessionMentions"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/session-mentions.ts src/test/unit/session-refs.test.ts
git commit -m "feat: @ mentions label sessions by name instead of title"
```

---

### Task 13: Full gate and final review

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `yarn test:unit`
Expected: PASS, zero regressions.

- [ ] **Step 2: Run the full DOM suite**

Run: `yarn test:dom`
Expected: PASS, zero regressions.

- [ ] **Step 3: Run the VS Code integration suite**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 4: Run lint, types, compile**

Run: `yarn lint && yarn check-types && yarn run compile`
Expected: all three PASS.

- [ ] **Step 5: Run impeccable's `critique` over the touched webview surfaces**

Follow the `impeccable` skill's `critique` flow over `src/webview` and compare against any prior baseline already sitting in `.impeccable/critique/` in this working tree (first run if none exists yet). The score must not go down.

- [ ] **Step 6: Manual smoke test**

Using the `run` skill, launch the extension. Create two sessions on different providers, rename each, and from one session's composer, ask it to call `marcode__send_message` to the other by name. Confirm: the target's turn interrupts (if busy) or starts (if idle), its transcript shows "Message from `<sender>`", and the sender's transcript shows a "Sent to `<name>`" tool card. Then close and reopen the panel (reload) and confirm both transcript items survive unchanged.

- [ ] **Step 7: Final commit / prepare for PR**

```bash
git status --short
git log --oneline master..feat/cross-session-messaging
```

Confirm the branch contains the spec commit plus every task commit above, nothing else, then open the PR per the `pr-summary` skill or the project's usual flow.
