# Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one session's output become another session's input — pulled into an existing composer with `@<session>`, or used to seed a brand-new session with `@handoff`.

**Architecture:** The webview authors references as structured `SessionRef` objects and never asks the host to parse `@` out of message text. The host resolves each ref against `TranscriptStore` at send time, appends the resolved payloads to the user's prose as fenced blocks, and records both the resolved text and the ref metadata on the user transcript item. `@handoff` reuses the existing create dialog, pre-filled from the source session, with a seed message posted alongside `create-session`.

**Tech Stack:** TypeScript, React 19, Tailwind v4, esbuild (node/CJS host bundle + browser/IIFE webview bundle), mocha + tsx for unit tests, mocha + jsdom + @testing-library/react for DOM tests.

**Spec:** [docs/superpowers/specs/2026-08-15-session-handoff-design.md](../specs/2026-08-15-session-handoff-design.md)

## Global Constraints

These come from `CLAUDE.md` and hold for every task below.

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`. Neither does `src/host/message-router.ts` **nor the new `src/host/session-refs.ts`** — that is what keeps them unit-testable outside the extension host.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- **Errors are state, never exceptions.** Nothing rejects across `postMessage`; a failure becomes a transcript item.
- Filenames are **kebab-case**, including React components. Component identifiers stay PascalCase.
- **shadcn only.** No bare `<select>`, `<button>`, `<input>`, `<textarea>` in feature code — use `@/components/ui/*`. The registry is **Base UI**-backed (`@base-ui/react`), never Radix.
- Compose classNames with `cn` from `@/lib/utils` — never template literals.
- **DOM tests drive components through the real `StoreProvider`.** State arrives as genuine `HostToWebview` messages via `sendFromHost`; assertions read the messages posted back with `posted()`. Never mock `useStore`, never hand-build a `ClientState`.
- **Never pass a DOM node to an assertion.** `assert.strictEqual(container.querySelector('x') === null, true)` — never `assert.strictEqual(container.querySelector('x'), null)`. The node-valued form allocated 3.5GB in 4 seconds and took a machine down on 2026-08-14.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after every task.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before a commit.
- **Never add a `Co-Authored-By` trailer** to any commit message.

**Test commands:**
- Unit: `yarn test:unit` (narrow with `--grep "<suite name>"`)
- DOM: `yarn test:dom` (narrow with `--grep "<suite name>"`)

## Spec refinement decided during planning

The spec says an unresolvable ref produces an error item in the receiving session but does not say whether the send proceeds. **It does not.** A message reading "Implement the plan above" with no plan attached invites the agent to invent one, which is a worse failure than not sending. Any unresolved ref aborts the whole send and produces one error item naming it. Same rule for a seeded creation: the session is still created, but the first message is not sent and the error item explains why.

## File Structure

**Created:**
- `src/host/session-refs.ts` — pure payload extraction and prompt composition. No `vscode`, no I/O.
- `src/webview/lib/mention-menu.ts` — caret-aware `@` query, filtering, token uniquification, splicing, pruning. Source-agnostic and pure.
- `src/webview/lib/session-mentions.ts` — the rows sessions contribute to that menu. One source among several; file tagging will arrive as a sibling module.
- `src/webview/components/ref-menu.tsx` — the `@` menu rows.
- `src/webview/lib/use-ref-menu.ts` — the hook binding the two together, shared by the composer and the create dialog.
- `src/test/unit/session-refs.test.ts`
- `src/test/unit/mention-menu.test.ts`
- `src/test/unit/session-mentions.test.ts`
- `src/test/dom/session-handoff.test.tsx`

**Modified:**
- `src/protocol/messages.ts` — `RefKind`, `SessionRef`, `refs?` on the user item, `refs?` on `send`, `seed?` on `create-session`.
- `src/host/agent-session.ts` — expose the open assistant item id; add `noteError`; accept `refs` on `send`.
- `src/host/session-manager.ts` — `resolveRefs`.
- `src/host/message-router.ts` — resolve refs on `send`; resolve seed on `create-session`.
- `src/webview/components/composer.tsx` — `@` menu wiring, refs on submit, handoff dialog.
- `src/webview/components/session-create-dialog.tsx` — optional seed composer; `onCreate` gains a second argument.
- `src/webview/components/session-create-settings.ts` — `settingsFor(state, sessionId)`, with `inheritedSettings` delegating to it.
- `src/webview/components/transcript-item.tsx` — render `refs` as collapsed chips on the user item.

---

### Task 1: Protocol types and the pure resolver

**Files:**
- Modify: `src/protocol/messages.ts`
- Create: `src/host/session-refs.ts`
- Test: `src/test/unit/session-refs.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` from `src/protocol/messages.ts`.
- Produces:
  - `type RefKind = 'message' | 'plan'`
  - `interface SessionRef { sessionId: SessionId; kind: RefKind; title: string }`
  - `findPayload(items: TranscriptItem[], kind: RefKind, excludeItemId?: string): string | undefined`
  - `composePrompt(prose: string, blocks: ResolvedBlock[]): string`
  - `interface ResolvedBlock { title: string; kind: RefKind; text: string }`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/session-refs.test.ts`:

```ts
import * as assert from 'assert';
import { composePrompt, findPayload } from '../../host/session-refs';
import type { TranscriptItem } from '../../protocol/messages';

function assistant(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'assistant', text };
}

function plan(id: string, text: string, state: 'running' | 'ok' | 'error' = 'ok'): TranscriptItem {
  return {
    id, ts: 1, role: 'tool', toolId: `t-${id}`,
    tool: { kind: 'plan', label: 'ExitPlanMode', text },
    state,
  };
}

suite('session refs', () => {
  test('message takes the most recent assistant item', () => {
    const items = [assistant('a1', 'first'), assistant('a2', 'second')];
    assert.strictEqual(findPayload(items, 'message'), 'second');
  });

  test('message skips the item that is still streaming', () => {
    const items = [assistant('a1', 'settled'), assistant('a2', 'half-writt')];
    assert.strictEqual(findPayload(items, 'message', 'a2'), 'settled');
  });

  test('message ignores an empty assistant item', () => {
    const items = [assistant('a1', 'real'), assistant('a2', '   ')];
    assert.strictEqual(findPayload(items, 'message'), 'real');
  });

  test('message returns undefined when there is none', () => {
    assert.strictEqual(findPayload([], 'message'), undefined);
  });

  test('plan takes the most recent settled plan call, across turns', () => {
    const items = [
      plan('p1', 'old plan'),
      { id: 'u1', ts: 2, role: 'user', text: 'go on' } as TranscriptItem,
      plan('p2', 'new plan'),
      assistant('a1', 'done'),
    ];
    assert.strictEqual(findPayload(items, 'plan'), 'new plan');
  });

  test('plan ignores an unsettled plan call', () => {
    const items = [plan('p1', 'settled'), plan('p2', 'in flight', 'running')];
    assert.strictEqual(findPayload(items, 'plan'), 'settled');
  });

  test('plan ignores tool calls that are not plans', () => {
    const items: TranscriptItem[] = [{
      id: 't1', ts: 1, role: 'tool', toolId: 'x',
      tool: { kind: 'command', label: 'Bash', command: 'ls' },
      state: 'ok',
    }];
    assert.strictEqual(findPayload(items, 'plan'), undefined);
  });

  test('composePrompt appends fenced blocks after the prose', () => {
    const out = composePrompt('Implement @agent-2 plan here.', [
      { title: 'agent-2', kind: 'plan', text: 'step one' },
    ]);
    assert.strictEqual(
      out,
      'Implement @agent-2 plan here.\n\n'
      + '--- plan from agent-2 ---\n'
      + 'step one\n'
      + '--- end plan from agent-2 ---',
    );
  });

  test('composePrompt with no blocks returns the prose unchanged', () => {
    assert.strictEqual(composePrompt('hello', []), 'hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "session refs"`
Expected: FAIL — `Cannot find module '../../host/session-refs'`

- [ ] **Step 3: Add the protocol types**

In `src/protocol/messages.ts`, after the `SessionStatus` line, add:

```ts
export type RefKind = 'message' | 'plan';

/**
 * A reference from one session's message to another session's output.
 *
 * `title` travels with the ref rather than being looked up: a transcript item
 * outlives the session it references, and a chip that renders "unknown
 * session" once the source is deleted records less than the one that kept the
 * name it had when the handoff happened.
 */
export interface SessionRef { sessionId: SessionId; kind: RefKind; title: string }
```

Add `refs?: SessionRef[]` to the user arm of `TranscriptItem`:

```ts
  | (ItemBase & {
      role: 'user'; text: string;
      context?: EditorContext;
      /**
       * Sessions this message pulled from. Metadata about the message that
       * the message text cannot carry, exactly like `context` above — `text`
       * is already the fully-composed prompt the provider received.
       */
      refs?: SessionRef[];
    })
```

- [ ] **Step 4: Write the resolver**

Create `src/host/session-refs.ts`:

```ts
import type { RefKind, TranscriptItem } from '../protocol/messages';

/** One resolved reference, ready to be appended to a prompt. */
export interface ResolvedBlock { title: string; kind: RefKind; text: string }

/**
 * The text a reference resolves to, or `undefined` when the source has
 * nothing to give.
 *
 * Searches backwards, so "most recent" costs no sort. `excludeItemId` is the
 * live session's currently-open assistant item: an in-flight answer is never
 * a candidate, which is what lets a reference resolve against a session that
 * is still running without ever pulling half a sentence.
 *
 * `plan` deliberately searches across turns rather than stopping at the last
 * user message. A plan is often several turns old by the time it is handed
 * off, and a rule that found nothing in that case would send the user looking
 * for a payload that is plainly on screen.
 */
export function findPayload(
  items: TranscriptItem[], kind: RefKind, excludeItemId?: string,
): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.id === excludeItemId) { continue; }
    if (kind === 'message') {
      if (item.role === 'assistant' && item.text.trim().length > 0) {
        return item.text;
      }
      continue;
    }
    if (item.role === 'tool' && item.state === 'ok' && item.tool.kind === 'plan') {
      return item.tool.text;
    }
  }
  return undefined;
}

/**
 * The prose as typed, with each payload appended after it as a delimited
 * block.
 *
 * Positional rather than substitutional: the composer's `@agent-2 plan` token
 * stays readable in the text and the content follows it, so there is no
 * placeholder scheme that a user editing their own message could break.
 */
export function composePrompt(prose: string, blocks: ResolvedBlock[]): string {
  if (blocks.length === 0) { return prose; }
  const rendered = blocks.map((b) =>
    `--- ${b.kind} from ${b.title} ---\n${b.text}\n--- end ${b.kind} from ${b.title} ---`);
  return [prose, ...rendered].join('\n\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:unit --grep "session refs"`
Expected: PASS, 9 passing

- [ ] **Step 6: Verify the whole unit suite and types**

Run: `yarn test:unit && yarn check-types`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/protocol/messages.ts src/host/session-refs.ts src/test/unit/session-refs.test.ts
git commit -m "feat: resolve session reference payloads from a transcript"
```

---

### Task 2: Session plumbing — open item id, error notes, `resolveRefs`

**Files:**
- Modify: `src/host/agent-session.ts`
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `findPayload` from Task 1.
- Produces:
  - `AgentSession.openItemId: string | undefined` (getter)
  - `AgentSession.noteError(message: string): void`
  - `AgentSession.send(text: string, context?: EditorContext, refs?: SessionRef[]): void`
  - `SessionManager.resolveRefs(refs: SessionRef[]): Promise<{ blocks: ResolvedBlock[]; missing: SessionRef[] }>`

- [ ] **Step 1: Write the failing test**

Append inside the existing `suite('SessionManager', …)` in `src/test/unit/session-manager.test.ts`:

```ts
  test('resolveRefs returns the source session\'s last assistant message', async () => {
    const session = await manager.create('fake', dir);
    session.send('hello');
    await settle();

    const { blocks, missing } = await manager.resolveRefs([
      { sessionId: session.state.id, kind: 'message', title: 'agent-1' },
    ]);

    assert.strictEqual(missing.length, 0);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].title, 'agent-1');
    assert.strictEqual(blocks[0].kind, 'message');
    assert.strictEqual(blocks[0].text, 'ok');
  });

  test('resolveRefs reports a ref it cannot satisfy', async () => {
    const session = await manager.create('fake', dir);

    const { blocks, missing } = await manager.resolveRefs([
      { sessionId: session.state.id, kind: 'message', title: 'agent-1' },
    ]);

    assert.strictEqual(blocks.length, 0);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].title, 'agent-1');
  });

  test('resolveRefs reports a ref to a session that does not exist', async () => {
    const { blocks, missing } = await manager.resolveRefs([
      { sessionId: 'nope', kind: 'message', title: 'ghost' },
    ]);

    assert.strictEqual(blocks.length, 0);
    assert.strictEqual(missing.length, 1);
  });

  test('noteError appends an error item without ending the session', async () => {
    const session = await manager.create('fake', dir);
    session.noteError('could not resolve');
    await settle();

    const snapshot = await session.snapshot();
    const errors = snapshot.items.filter((i) => i.role === 'error');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(session.state.status, 'idle');
  });
```

The `FakeProvider` configured at the top of this suite replies `'ok'` to any message without `rm` in it — that is where `blocks[0].text === 'ok'` comes from.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "SessionManager"`
Expected: FAIL — `manager.resolveRefs is not a function`

- [ ] **Step 3: Expose the open item id and add `noteError` on `AgentSession`**

In `src/host/agent-session.ts`, next to the existing `get isEmpty()`:

```ts
  /**
   * The assistant item currently being streamed into, if any.
   *
   * Exposed for reference resolution: an in-flight answer must never be what
   * a handoff pulls, and this is the only place that knows which item it is.
   */
  get openItemId(): string | undefined { return this.openAssistantId; }

  /**
   * An error that belongs in this session's transcript without ending it.
   *
   * Deliberately not `fail()`: an unresolvable reference means one message
   * could not be sent, not that the conversation is broken. Moving the
   * session to `error` would claim otherwise, and the roster would show a
   * dead session the user could still happily type into.
   */
  noteError(message: string): void {
    this.appendItem({ id: nextId('e'), ts: Date.now(), role: 'error', message });
    void this.scheduleFlush();
  }
```

- [ ] **Step 4: Carry `refs` through `send`**

In `src/host/agent-session.ts`, change the `send` signature and the item it appends. The provider still receives only `text` — `refs` is transcript metadata:

```ts
  send(text: string, context?: EditorContext, refs?: SessionRef[]): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    const item: TranscriptItem = {
      id: nextId('u'), ts: Date.now(), role: 'user', text,
      ...(context ? { context } : {}),
      ...(refs && refs.length > 0 ? { refs } : {}),
    };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    try {
      this.run.send(text, context);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }
```

Add `SessionRef` to the type import from `../protocol/messages` at the top of the file.

Note on the title: `text` here is the **composed** prompt, so a first message that is mostly a pulled plan will title the session with the start of that plan. That is correct — it is what was actually sent.

- [ ] **Step 5: Add `resolveRefs` to `SessionManager`**

In `src/host/session-manager.ts`, import the resolver:

```ts
import { findPayload, type ResolvedBlock } from './session-refs';
```

and add `SessionRef` to the existing type import from `../protocol/messages`. Then add the method, next to `contextBreakdown`:

```ts
  /**
   * Resolves each reference against the session it names.
   *
   * Never rejects and never throws: this is answered onto the wire, where
   * errors are state. A ref naming a deleted session, or one whose source has
   * produced nothing of that kind yet, comes back in `missing` for the caller
   * to report into the receiving transcript.
   *
   * A live session is asked through `snapshot()`, which flushes its pending
   * writes first — without that, a payload from a turn that ended moments ago
   * would still be sitting in the store's queue and resolve as absent.
   */
  async resolveRefs(
    refs: SessionRef[],
  ): Promise<{ blocks: ResolvedBlock[]; missing: SessionRef[] }> {
    const blocks: ResolvedBlock[] = [];
    const missing: SessionRef[] = [];

    for (const ref of refs) {
      if (!this.meta.has(ref.sessionId)) { missing.push(ref); continue; }
      const live = this.live.get(ref.sessionId);
      const items = live
        ? (await live.snapshot()).items
        : (await this.store.tail(ref.sessionId)).items;
      const text = findPayload(items, ref.kind, live?.openItemId);
      if (text === undefined) { missing.push(ref); continue; }
      blocks.push({ title: ref.title, kind: ref.kind, text });
    }

    return { blocks, missing };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:unit --grep "SessionManager"`
Expected: PASS

- [ ] **Step 7: Run the whole unit suite and types**

Run: `yarn test:unit && yarn check-types`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/host/agent-session.ts src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: resolve session refs through the session manager"
```

---

### Task 3: Router — `send` carrying refs

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/host/message-router.ts`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `SessionManager.resolveRefs`, `AgentSession.noteError`, `composePrompt` from Task 1.
- Produces: `send` messages may carry `refs?: SessionRef[]`.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level suite in `src/test/unit/message-router.test.ts`, matching that file's existing setup helpers:

```ts
  test('send with a ref composes the payload into the prompt', async () => {
    const source = await manager.create('fake', dir);
    source.send('plan it');
    await settle();
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do @agent-1 message',
      refs: [{ sessionId: source.state.id, kind: 'message', title: 'agent-1' }],
    });
    await settle();

    const items = (await target.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text.includes('Do @agent-1 message'), true);
    assert.strictEqual(user?.role === 'user' && user.text.includes('--- message from agent-1 ---'), true);
    assert.strictEqual(user?.role === 'user' && user.refs?.length, 1);
  });

  test('send with an unresolvable ref sends nothing and records why', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({
      t: 'send', id: target.state.id, text: 'Do @ghost message',
      refs: [{ sessionId: 'nope', kind: 'message', title: 'ghost' }],
    });
    await settle();

    const items = (await target.snapshot()).items;
    assert.strictEqual(items.some((i) => i.role === 'user'), false);
    const error = items.find((i) => i.role === 'error');
    assert.strictEqual(error?.role === 'error' && error.message.includes('ghost'), true);
    assert.strictEqual(target.state.status, 'idle');
  });

  test('send without refs is unchanged', async () => {
    const target = await manager.create('fake', dir);

    await router.handle({ t: 'send', id: target.state.id, text: 'plain' });
    await settle();

    const items = (await target.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text, 'plain');
    assert.strictEqual(user?.role === 'user' && user.refs, undefined);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "MessageRouter"`
Expected: FAIL — the composed text assertion fails; the prompt is still `'Do @agent-1 message'` with no block appended

- [ ] **Step 3: Add `refs` to the wire type**

In `src/protocol/messages.ts`, change the `send` arm of `WebviewToHost`:

```ts
  | { t: 'send'; id: SessionId; text: string; refs?: SessionRef[] }
```

- [ ] **Step 4: Resolve refs in the router**

In `src/host/message-router.ts`, add the import:

```ts
import { composePrompt } from './session-refs';
```

and replace the `send` case:

```ts
      case 'send': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const context = session.state.includeEditorContext
          ? this.editor.current() ?? undefined
          : undefined;

        const refs = msg.refs ?? [];
        if (refs.length === 0) {
          session.send(msg.text, context);
          return;
        }

        const { blocks, missing } = await this.manager.resolveRefs(refs);
        // All or nothing. A prompt that says "implement the plan above" with
        // no plan above is an invitation to invent one, which is worse than
        // not sending at all.
        if (missing.length > 0) {
          const names = missing.map((r) => `${r.title} (${r.kind})`).join(', ');
          session.noteError(
            `Nothing to hand off from ${names}. `
            + 'That session has not produced one yet.',
          );
          return;
        }
        session.send(composePrompt(msg.text, blocks), context, refs);
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:unit --grep "MessageRouter"`
Expected: PASS

- [ ] **Step 6: Run the whole unit suite, types and lint**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/protocol/messages.ts src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: compose session refs into an outgoing message"
```

---

### Task 4: Router — `create-session` carrying a seed

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/host/message-router.ts`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: `create-session` messages may carry `seed?: { text: string; refs: SessionRef[] }`.

- [ ] **Step 1: Write the failing test**

Append to the same suite in `src/test/unit/message-router.test.ts`:

```ts
  test('create-session with a seed sends the composed first message', async () => {
    const source = await manager.create('fake', dir);
    source.send('plan it');
    await settle();

    await router.handle({
      t: 'create-session', providerId: 'fake', cwd: '',
      seed: {
        text: 'Execute @agent-1 message',
        refs: [{ sessionId: source.state.id, kind: 'message', title: 'agent-1' }],
      },
    });
    await settle();

    const created = manager.summaries().find((s) => s.id !== source.state.id);
    assert.strictEqual(created !== undefined, true);
    const items = (await manager.get(created!.id)!.snapshot()).items;
    const user = items.find((i) => i.role === 'user');
    assert.strictEqual(user?.role === 'user' && user.text.includes('--- message from agent-1 ---'), true);
  });

  test('create-session with an unresolvable seed still creates the session', async () => {
    await router.handle({
      t: 'create-session', providerId: 'fake', cwd: '',
      seed: {
        text: 'Execute @ghost message',
        refs: [{ sessionId: 'nope', kind: 'message', title: 'ghost' }],
      },
    });
    await settle();

    const created = manager.summaries()[0];
    const items = (await manager.get(created.id)!.snapshot()).items;
    assert.strictEqual(items.some((i) => i.role === 'user'), false);
    assert.strictEqual(items.some((i) => i.role === 'error'), true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "MessageRouter"`
Expected: FAIL — no user item on the created session; the seed is ignored

- [ ] **Step 3: Add `seed` to the wire type**

In `src/protocol/messages.ts`, extend the `create-session` arm:

```ts
  | { t: 'create-session'; providerId: string; cwd: string; model?: string;
      effort?: EffortLevel; mode?: PermissionMode;
      /**
       * The new session's first message, sent immediately after creation.
       * Carried on creation rather than posted as a follow-up `send` because
       * the webview does not know the new session's id until the host has
       * made it — a two-step version would have to wait for the snapshot and
       * would lose the seed if the panel reloaded in between.
       */
      seed?: { text: string; refs: SessionRef[] } }
```

- [ ] **Step 4: Send the seed after creating**

In `src/host/message-router.ts`, replace the `create-session` case:

```ts
      case 'create-session': {
        const session = await this.manager.create(
          msg.providerId, msg.cwd || this.defaultCwd, msg.model, msg.effort, msg.mode,
        );
        if (msg.seed) {
          const { blocks, missing } = await this.manager.resolveRefs(msg.seed.refs);
          if (missing.length > 0) {
            const names = missing.map((r) => `${r.title} (${r.kind})`).join(', ');
            session.noteError(
              `Nothing to hand off from ${names}. `
              + 'That session has not produced one yet.',
            );
          } else {
            const context = session.state.includeEditorContext
              ? this.editor.current() ?? undefined
              : undefined;
            session.send(
              composePrompt(msg.seed.text, blocks), context,
              msg.seed.refs.length > 0 ? msg.seed.refs : undefined,
            );
          }
        }
        this.emit({ t: 'session-snapshot', session: await session.snapshot() });
        return;
      }
```

The snapshot is emitted **after** the seed is sent, so the pane arrives already showing the first message rather than filling in a beat later.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:unit --grep "MessageRouter"`
Expected: PASS

- [ ] **Step 6: Run the whole unit suite, types and lint**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/protocol/messages.ts src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: seed a new session with a handoff message"
```

---

### Task 5: The `@` menu library

> **Superseded in part by Task 5b.** Task 5 shipped as written below. A
> requirement then arrived — the same `@` menu will soon tag files in the
> session's cwd — and Task 5b splits this module into source-agnostic
> machinery (`mention-menu.ts`) plus a session source
> (`session-mentions.ts`). Tasks 6 and 7 are written against the **5b** API.
> The section below is kept as the record of what Task 5 built.

**Files:**
- Create: `src/webview/lib/session-ref-menu.ts`
- Test: `src/test/unit/session-ref-menu.test.ts`

**Interfaces:**
- Consumes: `SessionRef`, `RefKind`, `SessionSummary` from the protocol.
- Produces:
  - `interface RefOption { id: string; label: string; hint: string; kind: RefKind | 'handoff'; sessionId?: SessionId }`
  - `interface PendingRef { token: string; ref: SessionRef }`
  - `refQuery(text: string, caret: number): { query: string; start: number } | undefined`
  - `refOptions(sessions: SessionSummary[], selfId: SessionId): RefOption[]`
  - `filterRefOptions(options: RefOption[], query: string): RefOption[]`
  - `tokenFor(option: RefOption, taken: string[]): string`
  - `spliceRef(text: string, start: number, caret: number, token: string): { text: string; caret: number }`
  - `pruneRefs(text: string, pending: PendingRef[]): PendingRef[]`

Why this is not `invocable-menu.ts`: that menu triggers only at position 0 and is blocked whenever a draft exists (`menuQuery` in `src/webview/lib/invocable-menu.ts`, `menuBlocked` in `composer.tsx`). References belong *inside* prose, so this one triggers at any word boundary and splices at the caret.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/session-ref-menu.test.ts`:

```ts
import * as assert from 'assert';
import {
  filterRefOptions, pruneRefs, refOptions, refQuery, spliceRef, tokenFor,
} from '../../webview/lib/session-ref-menu';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session ref menu', () => {
  test('opens on @ at the start of the text', () => {
    assert.deepStrictEqual(refQuery('@', 1), { query: '', start: 0 });
  });

  test('opens on @ after a space, mid-prose', () => {
    assert.deepStrictEqual(refQuery('use @pla', 8), { query: 'pla', start: 4 });
  });

  test('does not open on an @ glued to a word', () => {
    assert.strictEqual(refQuery('me@example.com', 14), undefined);
  });

  test('closes once the query contains whitespace', () => {
    assert.strictEqual(refQuery('@plan now', 9), undefined);
  });

  test('ignores an @ that is after the caret', () => {
    assert.strictEqual(refQuery('hello @x', 5), undefined);
  });

  test('offers handoff plus one row per kind per other session', () => {
    const options = refOptions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    assert.strictEqual(options[0].kind, 'handoff');
    assert.strictEqual(options.length, 3);
    assert.strictEqual(options.filter((o) => o.sessionId === 's-2').length, 2);
    assert.strictEqual(options.some((o) => o.sessionId === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const options = refOptions([summary('s-1', 'me'), archived], 's-1');
    assert.strictEqual(options.length, 1);
  });

  test('filters on label and kind', () => {
    const options = refOptions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    assert.strictEqual(filterRefOptions(options, 'refac').length, 2);
    assert.strictEqual(filterRefOptions(options, 'hand').length, 1);
  });

  test('tokenFor slugs the label and disambiguates a collision', () => {
    const option = { id: 'x', label: 'Refactor Store', hint: '', kind: 'plan' as const, sessionId: 's-2' };
    assert.strictEqual(tokenFor(option, []), '@refactor-store:plan');
    assert.strictEqual(tokenFor(option, ['@refactor-store:plan']), '@refactor-store:plan-2');
  });

  test('spliceRef replaces the query span and leaves the caret after it', () => {
    const out = spliceRef('use @pla and go', 4, 8, '@refactor-store:plan');
    assert.strictEqual(out.text, 'use @refactor-store:plan and go');
    assert.strictEqual(out.caret, 24);
  });

  test('pruneRefs drops a ref whose token the user deleted', () => {
    const pending = [
      { token: '@a:plan', ref: { sessionId: 's-2', kind: 'plan' as const, title: 'a' } },
      { token: '@b:message', ref: { sessionId: 's-3', kind: 'message' as const, title: 'b' } },
    ];
    assert.strictEqual(pruneRefs('only @a:plan survives', pending).length, 1);
    assert.strictEqual(pruneRefs('neither', pending).length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "session ref menu"`
Expected: FAIL — `Cannot find module '../../webview/lib/session-ref-menu'`

- [ ] **Step 3: Write the library**

Create `src/webview/lib/session-ref-menu.ts`:

```ts
import type { RefKind, SessionId, SessionRef, SessionSummary } from '../../protocol/messages';

/** One row in the `@` menu. `handoff` is the only kind with no source session. */
export interface RefOption {
  id: string;
  label: string;
  hint: string;
  kind: RefKind | 'handoff';
  sessionId?: SessionId;
}

/**
 * A reference the composer holds while the message is being written. `token`
 * is the literal text in the box; it never reaches the wire — it exists so a
 * user who deletes the token deletes the reference with it (see pruneRefs).
 */
export interface PendingRef { token: string; ref: SessionRef }

const KINDS: { kind: RefKind; hint: string }[] = [
  { kind: 'message', hint: 'last reply' },
  { kind: 'plan', hint: 'last plan' },
];

/**
 * The active `@` query and where it starts, or `undefined` for "no menu".
 *
 * Unlike the `/` menu this triggers anywhere a word can start, because a
 * reference belongs inside a sentence rather than instead of one. An `@`
 * glued to the previous character is not a trigger, which is what keeps email
 * addresses and npm scopes from opening it.
 */
export function refQuery(
  text: string, caret: number,
): { query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) { return undefined; }
  if (start > 0 && !/\s/.test(before[start - 1])) { return undefined; }
  const query = before.slice(start + 1);
  if (/\s/.test(query)) { return undefined; }
  return { query, start };
}

/** `@handoff`, then every other live session crossed with the payload kinds. */
export function refOptions(sessions: SessionSummary[], selfId: SessionId): RefOption[] {
  const options: RefOption[] = [{
    id: 'handoff',
    label: 'handoff',
    hint: 'start a new session from this one',
    kind: 'handoff',
  }];
  for (const s of sessions) {
    if (s.id === selfId || s.archived) { continue; }
    for (const { kind, hint } of KINDS) {
      options.push({ id: `${s.id}:${kind}`, label: s.title, hint, kind, sessionId: s.id });
    }
  }
  return options;
}

export function filterRefOptions(options: RefOption[], query: string): RefOption[] {
  if (query.length === 0) { return options; }
  const needle = query.toLowerCase();
  return options.filter((o) =>
    o.label.toLowerCase().includes(needle) || o.kind.toLowerCase().includes(needle));
}

function slug(label: string): string {
  const out = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (out.length > 0 ? out : 'session').slice(0, 24);
}

/**
 * The literal token for an option, unique against `taken`.
 *
 * Two sessions can share a title — every session starts as `Untitled` — and a
 * duplicate token would make `pruneRefs` unable to tell which reference the
 * user deleted.
 */
export function tokenFor(option: RefOption, taken: string[]): string {
  const base = `@${slug(option.label)}:${option.kind}`;
  if (!taken.includes(base)) { return base; }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) { return candidate; }
  }
}

/** Replaces the `@query` span with `token`, leaving the caret after it. */
export function spliceRef(
  text: string, start: number, caret: number, token: string,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, start)}${token}${text.slice(caret)}`,
    caret: start + token.length,
  };
}

/** The references whose tokens are still present in the text. */
export function pruneRefs(text: string, pending: PendingRef[]): PendingRef[] {
  return pending.filter((p) => text.includes(p.token));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "session ref menu"`
Expected: PASS, 11 passing

- [ ] **Step 5: Run the whole unit suite, types and lint**

Run: `yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/lib/session-ref-menu.ts src/test/unit/session-ref-menu.test.ts
git commit -m "feat: add the session reference menu library"
```

---

### Task 6: The `@` menu in the composer

**Files:**
- Create: `src/webview/components/ref-menu.tsx`
- Modify: `src/webview/components/composer.tsx`
- Test: `src/test/dom/session-handoff.test.tsx`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: the composer posts `send` with `refs` when the box holds reference tokens.

**Before writing any of this**, invoke the `impeccable` skill's `shape` flow for the `@` menu surface, per `CLAUDE.md`. The panel is **Operate** mode: a 300–500px sidebar during a long-running turn, where scanability and native VS Code expectations outrank expression.

- [ ] **Step 1: Write the failing test**

Create `src/test/dom/session-handoff.test.tsx`:

```tsx
import * as assert from 'assert';
import { fireEvent, screen } from '@testing-library/react';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

function hydrateTwoSessions(): void {
  const a = summary('s-1', 'agent one');
  const b = summary('s-2', 'refactor store');
  sendFromHost({
    t: 'hydrate',
    sessions: [a, b],
    layout: { orientation: 'vertical', panes: [{ sessionId: 's-1', size: 1 }] },
    snapshots: [{ ...a, items: [], hasMore: false, pending: [], mcpServers: [] }],
    catalog: [{
      id: 'fake', displayName: 'Fake',
      models: [{ id: 'm', displayName: 'M' }],
      permissionModes: [{ id: 'default' }],
    }],
    unavailable: [],
    usage: {},
  });
}

suite('session handoff', () => {
  setup(() => resetHost());

  test('typing @ opens the menu with the other session', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@' } });

    assert.strictEqual(screen.getAllByText('refactor store').length > 0, true);
    assert.strictEqual(screen.getAllByText('handoff').length, 1);
  });

  test('picking a session inserts a token and sends refs with the message', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.change(box, { target: { value: `${(box as HTMLTextAreaElement).value} now` } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1);
    const sent = sends[0] as { text: string; refs?: { sessionId: string; kind: string }[] };
    assert.strictEqual(sent.refs?.length, 1);
    assert.strictEqual(sent.refs?.[0].sessionId, 's-2');
    assert.strictEqual(sent.text.includes('@refactor-store:'), true);
  });

  test('deleting the token drops the ref', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'Do it myself' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    const sent = sends[0] as { refs?: unknown[] };
    assert.strictEqual(sent.refs, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "session handoff"`
Expected: FAIL — no menu opens; `getAllByText('handoff')` throws

- [ ] **Step 3: Write the menu component**

Create `src/webview/components/ref-menu.tsx`, mirroring the structure of the existing `invocable-menu.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { MentionOption } from '../lib/mention-menu';

/**
 * The `@` menu rows. Presentation only — every decision about what is in the
 * list, and what picking one does, lives in `lib/mention-menu.ts` and its
 * source modules.
 *
 * `onMouseDown` with `preventDefault`, not `onClick`: the composer closes the
 * menu on blur, and a click that blurred the textarea first would unmount the
 * row before its handler ran.
 */
export function RefMenu({
  rows, activeIndex, listId, onPick,
}: {
  rows: MentionOption[];
  activeIndex: number;
  listId: string;
  onPick: (option: MentionOption) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">No sessions to reference</p>
    );
  }

  return (
    <ul id={listId} role="listbox" className="max-h-48 overflow-y-auto">
      {rows.map((option, i) => (
        <li
          key={option.id}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => { e.preventDefault(); onPick(option); }}
          className={cn(
            'flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 text-xs',
            i === activeIndex && 'bg-accent text-accent-foreground',
          )}
        >
          <span className="min-w-0 truncate font-medium">{option.label}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{option.hint}</span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Wire the composer**

In `src/webview/components/composer.tsx`:

Add imports:

```tsx
import {
  filterMentions, mentionQuery, pruneMentions, sessionRefsOf, spliceMention, tokenFor,
  type MentionOption, type PendingMention,
} from "../lib/mention-menu";
import { sessionMentions } from "../lib/session-mentions";
import { RefMenu } from "./ref-menu";
```

Add state beside the existing `text`/`ghost` state:

```tsx
  const { state } = useStore();
  const [refs, setRefs] = useState<PendingMention[]>([]);
  const [caret, setCaret] = useState(0);
  const [refDismissed, setRefDismissed] = useState(false);
```

`useStore()` is already destructured for `post` — extend that call to `const { state, post } = useStore();` rather than calling it twice.

Add the derived menu state below the existing `menuOpen`/`view` block:

```tsx
  const refHit = refDismissed ? undefined : mentionQuery(text, caret);
  // One array per source, concatenated. File tagging arrives as one more
  // source here and changes nothing else.
  const refRows = refHit
    ? filterMentions(sessionMentions(state.sessions, pane.summary.id), refHit.query)
    : [];
  // The two menus never share the screen: `/` only triggers on an empty box at
  // position 0, `@` only on a word boundary, and `menuOpen` wins if both ever
  // manage to be true.
  const refOpen = refHit !== undefined && !menuOpen;
  const refListId = `session-refs-${pane.summary.id}`;
  const refIndex = Math.min(activeIndex, Math.max(0, refRows.length - 1));
```

Add the picker:

```tsx
  const pickRef = (option: MentionOption) => {
    if (!refHit) { return; }
    if (option.payload.kind === 'action') {
      // An action row inserts no token: it opens a dialog instead of
      // referencing anything. Strip the query the user typed to get there.
      setText(spliceMention(text, refHit.start, caret, '').text);
      setHandoffOpen(true);
      setRefDismissed(true);
      return;
    }
    const token = tokenFor(option, refs.map((r) => r.token));
    const next = spliceMention(text, refHit.start, caret, token);
    setText(next.text);
    setCaret(next.caret);
    setRefs([...refs, { token, payload: option.payload }]);
    setActiveIndex(0);
  };
```

`setHandoffOpen` arrives in Task 7 — declare it now as `const [handoffOpen, setHandoffOpen] = useState(false);` beside the other state, and leave the dialog itself for that task.

In the textarea's `onChange`, keep the caret and prune in step:

```tsx
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setRefs((current) => pruneMentions(e.target.value, current));
            setGhost("");
            setActiveIndex(0);
            setDismissed(false);
            setRefDismissed(false);
          }}
```

Add key handling for the ref menu, immediately **before** the existing `if (menuOpen && !composingEnter)` block so it takes the keys first when open:

```tsx
            if (refOpen && !composingEnter) {
              const action = menuKeyAction(e.key);
              if (action !== "pass") {
                e.preventDefault();
                if (action === "move-down") { setActiveIndex(nextIndex(refIndex, 1, refRows.length)); }
                if (action === "move-up") { setActiveIndex(nextIndex(refIndex, -1, refRows.length)); }
                if (action === "select" && refRows[refIndex]) { pickRef(refRows[refIndex]); }
                if (action === "close") { setRefDismissed(true); }
                return;
              }
            }
```

Render the menu beside the existing one, inside `InputGroup`:

```tsx
        {refOpen && (
          <InputGroupAddon align="block-start" className="p-1">
            <RefMenu
              rows={refRows}
              activeIndex={refIndex}
              listId={refListId}
              onPick={pickRef}
            />
          </InputGroupAddon>
        )}
```

Send the refs in `submit`, and clear them:

```tsx
    } else {
      const carried = sessionRefsOf(pruneMentions(trimmed, refs));
      post({
        t: "send", id: pane.summary.id, text: trimmed,
        ...(carried.length > 0 ? { refs: carried } : {}),
      });
    }
    setText("");
    setGhost("");
    setRefs([]);
    setDismissed(false);
    setRefDismissed(false);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:dom --grep "session handoff"`
Expected: PASS, 3 passing

- [ ] **Step 6: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/ref-menu.tsx src/webview/components/composer.tsx`
Expected: exit 0. Exit 2 means findings — fix them before committing; a non-zero exit is a failing check, not a suggestion.

- [ ] **Step 7: Run the full checks**

Run: `yarn test:dom && yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/webview/components/ref-menu.tsx src/webview/components/composer.tsx src/test/dom/session-handoff.test.tsx
git commit -m "feat: reference another session from the composer"
```

---

### Task 7: `@handoff` opens the seeded create dialog

**Files:**
- Modify: `src/webview/components/session-create-settings.ts`
- Modify: `src/webview/components/session-create-dialog.tsx`
- Modify: `src/webview/components/composer.tsx`
- Test: `src/test/dom/session-handoff.test.tsx`

**Interfaces:**
- Consumes: `MentionOption` whose `payload.kind === 'action'` from Task 5b; `seed` on `create-session` from Task 4.
- Produces:
  - `settingsFor(state: ClientState, sessionId: SessionId | null | undefined): CreateSettings | undefined`
  - `SessionCreateDialog` gains `seedable?: boolean`; `onCreate: (settings: CreateSettings, seed?: string) => void`

- [ ] **Step 1: Write the failing test**

Append to `suite('session handoff', …)` in `src/test/dom/session-handoff.test.tsx`:

```tsx
  test('picking handoff opens the create dialog and posts a seed', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@hand' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const seed = screen.getByLabelText('First message');
    fireEvent.change(seed, { target: { value: 'Execute the plan in docs/x.md' } });
    fireEvent.click(screen.getByText('Create and send'));

    const creates = posted().filter((m) => m.t === 'create-session');
    assert.strictEqual(creates.length, 1);
    const sent = creates[0] as { seed?: { text: string; refs: unknown[] } };
    assert.strictEqual(sent.seed?.text, 'Execute the plan in docs/x.md');
    assert.strictEqual(sent.seed?.refs.length, 0);
  });

  test('the handoff dialog inherits the source session provider and model', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@hand' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('Create and send'));

    const creates = posted().filter((m) => m.t === 'create-session');
    const sent = creates[0] as { providerId: string; model: string };
    assert.strictEqual(sent.providerId, 'fake');
    assert.strictEqual(sent.model, 'm');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "session handoff"`
Expected: FAIL — `getByLabelText('First message')` throws; no dialog renders

- [ ] **Step 3: Add `settingsFor`**

In `src/webview/components/session-create-settings.ts`, extract the body of `inheritedSettings` so both callers share it:

```ts
/**
 * The settings of a specific session, resolved against the catalog as it
 * stands now.
 *
 * Split out of `inheritedSettings` because handoff copies the session the
 * user is handing off FROM, which is the pane they typed `@handoff` in — not
 * whichever session happens to be focused.
 */
export function settingsFor(
  state: ClientState, sessionId: SessionId | null | undefined,
): CreateSettings | undefined {
  const source = state.sessions.find((s) => s.id === sessionId);
  const provider = state.catalog.find((p) => p.id === source?.providerId) ?? state.catalog[0];
  if (!provider) { return undefined; }

  const inherited = provider.id === source?.providerId
    ? findModel(provider.models, source.model)
    : undefined;
  const model = inherited ?? provider.models[0];
  if (!model) { return undefined; }

  return {
    providerId: provider.id,
    model: model.id,
    effort: resolveEffort(model, inherited ? source?.effort : undefined),
    mode: source?.permissionMode ?? "default",
  };
}

export function inheritedSettings(state: ClientState): CreateSettings | undefined {
  return settingsFor(state, state.focusedSessionId);
}
```

Add `SessionId` to the type import at the top of the file. Keep the existing doc comment on `inheritedSettings` — the reasoning about the focused session still applies to it.

Extend `createMessage` to carry a seed:

```ts
/** The wire message for `settings`. `cwd: ''` means the workspace root. */
export function createMessage(
  settings: CreateSettings,
  seed?: { text: string; refs: SessionRef[] },
): WebviewToHost {
  return {
    t: "create-session",
    providerId: settings.providerId,
    cwd: "",
    model: settings.model,
    ...(settings.effort ? { effort: settings.effort } : {}),
    mode: settings.mode,
    ...(seed ? { seed } : {}),
  };
}
```

Add `SessionRef` to the type import.

- [ ] **Step 4: Add the seed composer to the dialog**

In `src/webview/components/session-create-dialog.tsx`, add the prop to both components and thread it through. Use the vendored `Textarea` — never a bare `<textarea>`:

```tsx
import { Textarea } from "@/components/ui/textarea";
```

On `SessionCreateDialog`, add `seedable?: boolean` and widen `onCreate`:

```tsx
  seedable?: boolean;
  onCreate: (settings: CreateSettings, seed?: string) => void;
```

Pass both into `CreateForm`, and set the title from it:

```tsx
        <DialogTitle>{seedable ? "Hand off to a new session" : "New session"}</DialogTitle>
```

In `CreateForm`, add the state and the field. The field goes **first** in the scrolling body: it is the thing the user came to write, and burying it under the model list in a 300px sidebar puts it below the fold.

```tsx
  const [seedText, setSeedText] = useState("");
```

```tsx
        {seedable && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${ids}-seed`} className="text-xs font-medium text-muted-foreground">
              First message
            </label>
            <Textarea
              id={`${ids}-seed`}
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              placeholder="Execute the plan in docs/superpowers/plans/…"
              className="min-h-16"
            />
          </div>
        )}
```

And the confirm button:

```tsx
        <Button
          size="sm"
          disabled={!provider || !model || (seedable && !seedText.trim())}
          onClick={() => {
            if (!provider || !model) { return; }
            onCreate({
              providerId: provider.id,
              model: model.id,
              ...(level ? { effort: level } : {}),
              mode: effectiveMode,
            }, seedable ? seedText.trim() : undefined);
          }}
        >
          {seedable ? "Create and send" : "Create session"}
        </Button>
```

If `src/webview/components/ui/textarea.tsx` is not vendored yet, vendor it before this step — do not hand-roll it and do not reach for a raw element.

The existing caller in `session-create-menu.tsx` needs no change: it passes no `seedable`, and its `onCreate` simply ignores the new second argument.

- [ ] **Step 5: Render the dialog from the composer**

In `src/webview/components/composer.tsx`, add imports:

```tsx
import { SessionCreateDialog } from "./session-create-dialog";
import { createMessage, settingsFor } from "./session-create-settings";
```

Derive the settings and render the dialog after the closing `</InputGroup>`:

```tsx
  const handoffSettings = settingsFor(state, pane.summary.id);
```

```tsx
      {handoffSettings && (
        <SessionCreateDialog
          open={handoffOpen}
          onOpenChange={setHandoffOpen}
          catalog={state.catalog}
          initial={handoffSettings}
          seedable
          onCreate={(chosen, seed) => {
            const carried = sessionRefsOf(pruneMentions(seed ?? "", refs));
            post(createMessage(chosen, {
              text: seed ?? "",
              refs: carried.map((r) => r.ref),
            }));
            setHandoffOpen(false);
          }}
        />
      )}
```

The composer's own `refs` are pruned against the **seed** text, so a reference only travels if its token is actually in the message being sent to the new session.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:dom --grep "session handoff"`
Expected: PASS, 5 passing

- [ ] **Step 7: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/session-create-dialog.tsx src/webview/components/composer.tsx`
Expected: exit 0

- [ ] **Step 8: Run the full checks**

Run: `yarn test:dom && yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/webview/components/session-create-settings.ts src/webview/components/session-create-dialog.tsx src/webview/components/composer.tsx src/test/dom/session-handoff.test.tsx
git commit -m "feat: hand off to a new session from the composer"
```

---

### Task 8: Render references in the transcript

**Files:**
- Modify: `src/webview/components/transcript-item.tsx`
- Test: `src/test/dom/session-handoff.test.tsx`

**Interfaces:**
- Consumes: `refs?: SessionRef[]` on the user item, from Task 1.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `suite('session handoff', …)`:

```tsx
  test('a user item with refs renders a collapsed source chip', () => {
    renderApp();
    hydrateTwoSessions();

    sendFromHost({
      t: 'session-patch', id: 's-1',
      patch: {
        op: 'append',
        item: {
          id: 'u1', ts: 1, role: 'user',
          text: 'Do it\n\n--- plan from refactor store ---\nstep one\n--- end plan from refactor store ---',
          refs: [{ sessionId: 's-2', kind: 'plan', title: 'refactor store' }],
        },
      },
    });

    assert.strictEqual(screen.getAllByText(/plan from refactor store/).length > 0, true);
    // Collapsed: the payload body is not in the document until it is opened.
    assert.strictEqual(screen.queryByText('step one') === null, true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "session handoff"`
Expected: FAIL — the whole composed text renders as one block, so `step one` is present

- [ ] **Step 3: Split the composed text for display**

In `src/webview/components/transcript-item.tsx`, replace `UserItem`:

```tsx
function UserItem({ item }: { item: Extract<TranscriptItem, { role: 'user' }> }) {
  const { post } = useStore();
  const ctx = item.context;
  // The item's `text` is the composed prompt, blocks included — it has to be,
  // since it is exactly what the provider received. For display the blocks are
  // lifted back out and shown as collapsed chips, so a handoff reads as one
  // sentence plus a source rather than as a wall of somebody else's output.
  const { prose, blocks } = splitComposed(item.text, item.refs ?? []);

  return (
    <TranscriptItemShell role="user" label="You" ts={item.ts}>
      {ctx && (
        <div className="mb-1 flex">
          <EditorContextChip
            ctx={ctx}
            onClick={() => post({
              t: 'reveal-file',
              path: ctx.path,
              startLine: ctx.selection?.ranges[0]?.startLine,
            })}
          />
        </div>
      )}
      <div className="wrap-break-word whitespace-pre-wrap">
        {prose}
      </div>
      {blocks.map((block) => (
        <details key={block.heading} className="mt-1.5">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {block.heading}
          </summary>
          <div className="mt-1 wrap-break-word whitespace-pre-wrap text-xs text-muted-foreground">
            {block.text}
          </div>
        </details>
      ))}
    </TranscriptItemShell>
  );
}

/**
 * Lifts the fenced blocks `composePrompt` appended back out of the text.
 *
 * Keyed off `refs` rather than pattern-matching every `---` line: a user whose
 * own prose contains a matching line must not have it swallowed, and the refs
 * say exactly which headings to look for.
 */
function splitComposed(text: string, refs: SessionRef[]): {
  prose: string;
  blocks: { heading: string; text: string }[];
} {
  const blocks: { heading: string; text: string }[] = [];
  let prose = text;

  for (const ref of refs) {
    const heading = `${ref.kind} from ${ref.title}`;
    const open = `--- ${heading} ---\n`;
    const close = `\n--- end ${heading} ---`;
    const start = prose.indexOf(open);
    if (start < 0) { continue; }
    const end = prose.indexOf(close, start);
    if (end < 0) { continue; }
    blocks.push({ heading, text: prose.slice(start + open.length, end) });
    prose = (prose.slice(0, start) + prose.slice(end + close.length)).trimEnd();
  }

  return { prose, blocks };
}
```

Add `SessionRef` to the type import at the top of the file.

`<details>`/`<summary>` are the one exception the shadcn rule does not cover — they are disclosure semantics, not a control, and the registry has no equivalent primitive. Do not substitute a `Button` here; a native `<details>` is keyboard- and screen-reader-correct with no JavaScript.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom --grep "session handoff"`
Expected: PASS, 6 passing

- [ ] **Step 5: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/transcript-item.tsx`
Expected: exit 0

- [ ] **Step 6: Run the full checks**

Run: `yarn test:dom && yarn test:unit && yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/transcript-item.tsx src/test/dom/session-handoff.test.tsx
git commit -m "feat: render handoff sources as collapsed chips"
```

---

### Task 9: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run every test suite**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS, no pending or skipped tests introduced by this work

- [ ] **Step 2: Run the build and static checks**

Run: `yarn run compile`
Expected: PASS — this runs esbuild, `check-types` and `lint` in one go

- [ ] **Step 3: Run the impeccable critique over the webview**

Run `critique` over `src/webview` per `CLAUDE.md`, and compare against the previous run already in `.impeccable/critique/`. That directory is gitignored, so a fresh clone has no baseline until `critique` has run there once.
Expected: the score goes up, never down. If it dropped, fix the regression before merging.

- [ ] **Step 4: Manual smoke in the dev host**

Run: `yarn dev`

Then, in the dev host:
1. Create two `fake` sessions and send a message in the first so it has a reply.
2. In the second session's composer, type `Do @` and confirm the menu lists the first session with `last reply` and `last plan` rows.
3. Pick `last reply`, finish the sentence, send. Confirm the transcript shows your sentence with a collapsed `message from …` chip beneath it, and that expanding it shows the first session's reply.
4. Type `@handoff`, confirm the dialog opens titled "Hand off to a new session" with the source's provider and model pre-selected, write a first message, and confirm a third session appears with that message already sent.
5. In a fresh session with no turns, reference it from another composer and confirm the receiving session shows an error item rather than sending.

- [ ] **Step 5: Commit any fixes**

Only if steps 1–4 turned up changes:

```bash
git add -A
git commit -m "fix: <what the verification turned up>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `@handoff` — seed a new session | 4, 7 |
| `@<session>` — pull a payload | 3, 5, 6 |
| Payload kinds `message` / `plan` | 1 |
| Wire protocol (`SessionRef`, `refs`, `seed`) | 1, 3, 4 |
| Host never parses `@` out of text | 3 (refs arrive structured), 5 (webview authors them) |
| Resolver, in-flight exclusion, cross-turn plan search | 1, 2 |
| Running source resolves normally | 1 (`excludeItemId`), 2 (`openItemId`) |
| Empty source → error item | 2, 3, 4 |
| Composing the prompt | 1, 3 |
| Composer `@` menu | 5, 6 |
| Transcript ref chips | 8 |
| Create dialog seed + `Create and send` | 7 |
| Testing split (unit / router / DOM) | 1–8 |
| `impeccable` before and after | 6, 7, 8, 9 |

Not implemented, and correctly so — the spec lists these under "Deliberately not in this design": per-item hand-off buttons, a `diff` payload, whole-transcript payload, an agent-callable handoff tool.

**Type consistency:** `RefKind`, `SessionRef`, `ResolvedBlock`, `PendingMention` and `MentionOption` are each defined once (Tasks 1 and 5b) and referenced by those names throughout. `findPayload`, `composePrompt`, `resolveRefs`, `noteError`, `openItemId`, `settingsFor` and `createMessage` keep the same signatures everywhere they appear.

**One thing to watch during execution:** Task 6 changes `const { post } = useStore()` to `const { state, post } = useStore()` in the composer. If a later task's diff reintroduces the single-destructure form, `state` goes undefined and the `@` menu silently lists nothing.
