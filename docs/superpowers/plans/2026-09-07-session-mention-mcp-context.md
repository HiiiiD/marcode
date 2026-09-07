# Session-mention autocomplete + marcode__get_session_context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the composer's `@session` mention from silently pulling a recap
into the outgoing message; keep it as a plain autocomplete for a session's
name. Give the agent its own tool, `marcode__get_session_context`, to fetch a
raw slice of another session's transcript whenever it decides it wants one.

**Architecture:** Two independent, sequential changes. (1) `session-mentions.ts`
stops attaching a `SessionRef` payload to a picked session row — the row still
autocompletes the name, but `sessionRefsOf()` (now dead) is deleted along with
its call sites in `composer.tsx`, so a fresh `send` never carries `refs` from
typed `@` mentions again. Legacy resolution (`session-refs.ts`, `RefKind`,
`SessionManager.resolveRefs()`) is untouched — old transcripts on disk still
need it. (2) `SessionManager` gains `transcriptTail()`, mirroring
`resolveRefs()`'s own live/dead session split but returning a raw, unsummarized
`TranscriptItem[]` slice instead of a recap. `self-control-mcp-server.ts`
exposes it as `marcode__get_session_context`, wired through `extension.ts`
exactly like every other `marcode__*` tool.

**Tech Stack:** TypeScript, React 19 (webview), `@modelcontextprotocol/sdk`
(host), mocha + `assert` (unit tests), jsdom + Testing Library (DOM tests).

**Spec:** [docs/superpowers/specs/2026-09-07-session-mention-mcp-context-design.md](../specs/2026-09-07-session-mention-mcp-context-design.md)

## Global Constraints

- `src/protocol/messages.ts` stays types-only; `RefKind` stays `'message' |
  'plan'` — do not remove either arm.
- `src/providers/`, `src/protocol/`, and `self-control-mcp-server.ts` import no
  `vscode` and stay structurally typed against `SessionManagerLike` (declared
  in `self-control-mcp-server.ts`), never the real `SessionManager` class.
- Filenames stay kebab-case; this plan touches no new files, so nothing to
  name.
- `yarn lint`, `yarn check-types`, and `yarn run compile` must all pass before
  each commit. Commit after every task, conventional-commit prefixes
  (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).
- No `Co-Authored-By` trailer on any commit.

---

### Task 1: `session-mentions.ts` stops attaching a `SessionRef`

**Files:**
- Modify: `src/webview/lib/session-mentions.ts`
- Modify: `src/webview/lib/file-mentions.ts:35-41` (doc comment only — drop the
  dangling reference to the function this task deletes)
- Test: `src/test/unit/session-mentions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SessionMentionPayload = { kind: 'name' } | { kind: 'action';
  action: 'handoff' }` — Task 2 (`composer.tsx`) reads this new shape.
  `sessionMentions()`'s signature (`(sessions, selfId, handoffAvailable) =>
  MentionOption<SessionMentionPayload>[]`) is unchanged. `sessionRefsOf` is
  **deleted** — Task 2 removes its only caller.

- [ ] **Step 1: Write the failing tests**

Replace the whole file `src/test/unit/session-mentions.test.ts` with:

```ts
import * as assert from 'assert';
import { sessionMentions, type SessionMentionPayload } from '../../webview/lib/session-mentions';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string, name?: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, name: name ?? title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session mentions', () => {
  test('offers handoff first, then exactly one row per other session', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    assert.strictEqual(rows[0].payload.kind, 'action');
    assert.strictEqual(rows[0].group, 'Actions');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.filter((r) => r.payload.kind === 'name' && r.id === 's-2').length, 1);
    const sessionRow = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(sessionRow?.group, 'Sessions');
  });

  test('hints "last reply" for a session row', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.hint, 'last reply');
  });

  test('omits the session doing the referencing', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'other')], 's-1', true);
    assert.strictEqual(rows.some((r) => r.payload.kind === 'name' && r.id === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const rows = sessionMentions([summary('s-1', 'me'), archived], 's-1', true);
    assert.strictEqual(rows.length, 1);
  });

  test('slugs the title into the base token', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'Refactor Store!')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.baseToken, 'refactor-store');
  });

  test('falls back to a stable slug for a title with no usable characters', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', '!!!')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.baseToken, 'session');
  });

  test('omits handoff when there is nothing to hand off to', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-2', 'other')], 's-1', false,
    );
    assert.strictEqual(rows.some((r) => r.payload.kind === 'action'), false);
    assert.strictEqual(rows.length, 1);
  });

  test('disambiguates identically titled sessions in the visible label', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-abcd', 'Untitled'), summary('s-wxyz', 'Untitled')],
      's-1', true,
    );
    const labels = rows
      .filter((r) => r.payload.kind === 'name')
      .map((r) => r.label);
    assert.strictEqual(new Set(labels).size, 2, 'the two sessions must read differently');
    assert.strictEqual(labels.every((l) => l.startsWith('Untitled (')), true);
  });

  test('leaves a unique title alone', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true,
    );
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.label, 'refactor store');
  });

  test('sessionMentions labels a renamed session by its name, not its title', () => {
    const sessions: SessionSummary[] = [
      summary('s1', 'Untitled', 'renamed-one'),
    ];
    const options = sessionMentions(sessions, 's-self', false);
    assert.strictEqual(options.find((o) => o.id === 's1')?.label, 'renamed-one');
  });

  test('sessionMentions still disambiguates two sessions sharing a default name', () => {
    const sessions: SessionSummary[] = [
      summary('s1', 'Untitled', 'claude-1'),
      summary('s2', 'Untitled', 'claude-1'),
    ];
    const options = sessionMentions(sessions, 's-self', false);
    assert.notStrictEqual(
      options.find((o) => o.id === 's1')?.label,
      options.find((o) => o.id === 's2')?.label,
    );
  });

  test('a session row carries no ref payload beyond its kind', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    const payload: SessionMentionPayload | undefined = row?.payload;
    assert.deepStrictEqual(payload, { kind: 'name' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "session mentions"`
Expected: FAIL — `sessionMentions` still produces `{kind: 'session-ref', ref}`,
so `payload.kind === 'name'` never matches and every row-count assertion
above fails.

- [ ] **Step 3: Update `session-mentions.ts`**

Replace the file's payload type, doc comment, and row-building loop:

```ts
import type { SessionId, SessionSummary } from '../../protocol/messages';
import type { MentionOption, PendingMention } from './mention-menu';

/**
 * What a row from this source means. Lives here, not in the menu machinery:
 * a source owns its own payload, which is what lets another source be added
 * beside this one without the machinery learning about either.
 *
 * A session row's payload carries nothing beyond its own kind: picking one
 * inserts the session's name as literal text and nothing else. Earlier this
 * carried a `SessionRef` that the host resolved into a recap and appended to
 * the outgoing message — that pull is gone. Pulling another session's
 * content is now something the agent does itself, mid-turn, through
 * `marcode__get_session_context` — never something the host attaches
 * silently because the user typed a name. `RefKind`/`SessionRef` still exist
 * on the wire (see `../../protocol/messages.ts`) and `session-refs.ts` still
 * resolves them — transcripts written before this change carry
 * `SessionRef{kind:'message'|'plan'}` entries and replaying those still has
 * to work.
 */
export type SessionMentionPayload =
  | { kind: 'name' }
  | { kind: 'action'; action: 'handoff' };

/**
 * Slugs a session title into a token-safe fragment.
 *
 * Capped, because the token is literal text the user has to read and edit
 * inside their own sentence, and a session titled with a whole paragraph
 * would otherwise put that paragraph in the box.
 */
function slug(title: string): string {
  const out = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (out.length > 0 ? out : 'session').slice(0, 24);
}

/**
 * The rows sessions contribute to the `@` menu: the handoff gesture, then one
 * row for each other live session — a fast way to type a session's name,
 * nothing more. Picking a row inserts its slugged name and attaches no
 * payload beyond `{kind: 'name'}`; nothing about the pick reaches the wire.
 *
 * One of possibly several sources — the composer concatenates what each
 * source offers, so adding file tagging later means adding a module beside
 * this one and one more array in the caller.
 *
 * `handoffAvailable` is a boolean rather than the catalog: whether there is a
 * provider to create against is the caller's knowledge, and a row that opens a
 * dialog which is not rendered looks like it worked and does nothing. Not
 * offering it is the only honest shape.
 */
export function sessionMentions(
  sessions: SessionSummary[], selfId: SessionId, handoffAvailable: boolean,
): MentionOption<SessionMentionPayload>[] {
  const options: MentionOption<SessionMentionPayload>[] = [];
  if (handoffAvailable) {
    options.push({
      id: 'handoff',
      label: 'handoff',
      hint: 'start a new session from this one',
      group: 'Actions',
      baseToken: 'handoff',
      payload: { kind: 'action', action: 'handoff' },
    });
  }

  const referable = sessions.filter((s) => s.id !== selfId && !s.archived);
  // Sessions are labeled by their `name`, which is unique by construction
  // (enforced in `SessionManager.rename()`). Two sessions can only collide if
  // they both still hold their default auto-generated names — unlikely but
  // possible if `defaultName`'s counter ever repeats across a reload. The
  // suffix logic stays as a safety net.
  const seen = new Map<string, number>();
  for (const s of referable) { seen.set(s.name, (seen.get(s.name) ?? 0) + 1); }

  for (const s of referable) {
    options.push({
      id: s.id,
      label: (seen.get(s.name) ?? 0) > 1 ? `${s.name} (${shortId(s.id)})` : s.name,
      hint: 'last reply',
      group: 'Sessions',
      baseToken: slug(s.name),
      payload: { kind: 'name' },
    });
  }
  return options;
}

/**
 * The tail of a session id, as a disambiguator for two identically titled
 * sessions. The tail rather than the head: ids share a generated prefix often
 * enough that the first characters are the ones that do not differ.
 */
function shortId(id: SessionId): string {
  return id.slice(-4);
}
```

`sessionRefsOf` and the now-unused `PendingMention`/`SessionRef` imports are
deleted along with it — `PendingMention` is no longer referenced in this file
at all once `sessionRefsOf` is gone, so drop that import too.

- [ ] **Step 4: Tweak `file-mentions.ts`'s doc comment**

`fileRefsOf`'s doc comment currently reads "Mirrors `sessionRefsOf`." That
function no longer exists. Update the comment at
`src/webview/lib/file-mentions.ts:35-41`:

```ts
/**
 * The file references among `pending`, in order.
 *
 * Generic over `P`: the composer's pending array holds every source's
 * payload in one union (`SessionMentionPayload | FileMentionPayload`), and
 * `Extract` is what lets this function narrow its own arm out of that union
 * without importing the other source's payload type.
 */
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit --grep "session mentions"`
Expected: PASS

- [ ] **Step 6: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors. (`composer.tsx` will fail type-checking here — it still
imports the now-deleted `sessionRefsOf` — that's expected; Task 2 fixes it.
If your tool run fails the whole task on this, proceed to Task 2 before
committing Task 1's diff; otherwise commit now and let Task 2 restore a green
`check-types`.)

- [ ] **Step 7: Commit**

```bash
git add src/webview/lib/session-mentions.ts src/webview/lib/file-mentions.ts src/test/unit/session-mentions.test.ts
git commit -m "feat: @ session mentions no longer attach a pulled recap"
```

---

### Task 2: `composer.tsx` stops sending `refs` from typed `@` mentions

**Files:**
- Modify: `src/webview/components/composer.tsx`
- Test: `src/test/dom/session-handoff.test.tsx`

**Interfaces:**
- Consumes: `SessionMentionPayload` from Task 1 (`{kind:'name'} |
  {kind:'action', action:'handoff'}`).
- Produces: a `send`/`create-session` message built from text containing an
  `@session` mention carries no `refs` field. (`@file` mentions are
  unaffected — `fileRefsOf`/`fileCarried` stay exactly as they are.)

- [ ] **Step 1: Write the failing tests**

In `src/test/dom/session-handoff.test.tsx`, replace these two tests:

```ts
  test('picking a session inserts a token and sends no refs — @ only autocompletes the name', () => {
    renderApp();
    hydrateTwoSessions();

    const box = messageBox();
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.change(box, { target: { value: `${(box as HTMLTextAreaElement).value} now` } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1);
    const sent = sends[0] as { text: string; refs?: unknown[] };
    assert.strictEqual(sent.refs, undefined);
    assert.strictEqual(sent.text.includes('@refactor-store'), true);
  });

  /**
   * The picking tests above type a trailing space before the second Enter,
   * which closes the menu through the whitespace rule in `mentionQuery` — so
   * they never exercise the state machine's own close. This one does: the
   * caret sits at the end of the freshly inserted token, so the query matches
   * again and the menu re-renders over the row just picked. Left open, the
   * next Enter re-enters the pick and inserts the SAME token twice.
   */
  test('Enter straight after a pick sends once, with the token inserted once', () => {
    renderApp();
    hydrateTwoSessions();

    const box = messageBox();
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1, 'the second Enter must send, not re-pick');
    const sent = sends[0] as { text: string };
    const occurrences = sent.text.split('@refactor-store').length - 1;
    assert.strictEqual(occurrences, 1, 'the token must be inserted once');
  });
```

The other tests in that file are untouched:
- `'deleting the token drops the ref'` already asserts `sent.refs === undefined`
  and keeps passing.
- `'picking handoff opens the create dialog and posts a seed'` already asserts
  `sent.seed?.refs.length === 0` and keeps passing.
- The chip-rendering tests (`'a user item with refs shows...'`, two-refs, and
  the degrade-to-plain-prose test) render **pre-existing** `session-patch`
  items carrying `refs` the host already resolved — they test legacy replay,
  not the composer, and are unaffected by this task.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:dom --grep "session handoff"`
Expected: FAIL — `composer.tsx` still calls `sessionRefsOf` and attaches
`refs` to the `send` message, so `sent.refs` is `{sessionId: 's-2', ...}[]`,
not `undefined`.

- [ ] **Step 3: Update `composer.tsx`**

Remove `sessionRefsOf` from the import at the top:

```ts
import {
  filterMentions, mentionQuery, pruneMentions, spliceMention, tokenFor,
  type MentionOption, type PendingMention,
} from "../lib/mention-menu";
import {
  sessionMentions, type SessionMentionPayload,
} from "../lib/session-mentions";
```

In `submit()` (around line 226-254), drop the `carried`/`refs` line:

```ts
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const intercept = interceptFor(trimmed);
    if (intercept === "context") {
      setContextOpen(true);
    } else {
      const pruned = pruneMentions(trimmed, refs);
      const fileCarried = fileRefsOf(pruned);
      post({
        t: "send", id: pane.summary.id, text: trimmed,
        ...(fileCarried.length > 0 ? { fileRefs: fileCarried } : {}),
      });
    }
    setText("");
    setGhost("");
    setRefs([]);
    menu.reset();
    refMenu.reset();
  };
```

In the `SessionCreateDialog`'s `onCreate` handler (around line 671-690), the
same edit:

```ts
          onCreate={(chosen, seed) => {
            const pruned = pruneMentions(seed ?? "", refs);
            const fileCarried = fileRefsOf(pruned);
            post(createMessage(chosen, {
              text: seed ?? "",
              ...(fileCarried.length > 0 ? { fileRefs: fileCarried } : {}),
            }));
            setHandoffOpen(false);
          }}
```

`createMessage`'s `refs` field (in `session-create-settings.ts`) is already
optional — check its call signature before editing if type-checking
complains; it should accept the omission without a change on that side, since
`fileRefs` was already conditionally spread the same way for the `refs` field
before this edit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:dom --grep "session handoff"`
Expected: PASS

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors.

- [ ] **Step 6: Run the impeccable detector over the touched webview file**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/composer.tsx`
Expected: exit 0. (No visual change was made — only a payload/wiring
simplification — so this is a confirmation, not expected to find anything.)

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/composer.tsx src/test/dom/session-handoff.test.tsx
git commit -m "feat: composer stops attaching refs from typed @ session mentions"
```

---

### Task 3: `SessionManager.transcriptTail()`

**Files:**
- Modify: `src/host/session-manager.ts` (add method near `resolveRefs()`,
  around line 1389)
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `this.meta: Map<SessionId, SessionState>`, `this.live:
  Map<SessionId, AgentSession>`, `this.store: TranscriptStore` (all existing
  private fields), `AgentSession.snapshot(): Promise<SessionSnapshot>`
  (existing, returns `{items: TranscriptItem[], ...}`), `TranscriptStore.tail(id,
  limit?): Promise<{items: TranscriptItem[], hasMore: boolean}>` (existing).
- Produces: `SessionManager.transcriptTail(id: SessionId, limit = 30):
  Promise<{items: TranscriptItem[]} | undefined>` — Task 4 wires this through
  `SessionManagerLike`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/session-manager.test.ts`, near the existing
`resolveRefs` tests:

```ts
  test('transcriptTail returns a live session\'s own items, most recent last', async () => {
    const session = await manager.create('fake', dir);
    session.send('hello');
    await settle();

    const tail = await manager.transcriptTail(session.state.id);

    assert.strictEqual(tail !== undefined, true);
    assert.strictEqual(tail!.items.some((i) => i.role === 'user' && i.text === 'hello'), true);
  });

  test('transcriptTail caps a live session\'s items to limit, keeping the most recent', async () => {
    const session = await manager.create('fake', dir);
    session.send('one');
    await settle();
    session.send('two');
    await settle();
    session.send('three');
    await settle();

    const tail = await manager.transcriptTail(session.state.id, 1);

    assert.strictEqual(tail!.items.length, 1);
    assert.strictEqual(tail!.items[0].role === 'user' && tail!.items[0].text, 'three');
  });

  test('transcriptTail reads a known-but-not-live session from the store', async () => {
    const created = await manager.create('fake', dir);
    created.send('hi from before restart');
    await settle();
    await manager.dispose();

    const restored = new SessionManager(store, providers, () => {});
    await restored.init();
    try {
      assert.strictEqual(restored.get(created.state.id), undefined, 'must not be live yet');
      const tail = await restored.transcriptTail(created.state.id);
      assert.strictEqual(tail !== undefined, true);
      assert.strictEqual(
        tail!.items.some((i) => i.role === 'user' && i.text === 'hi from before restart'),
        true,
      );
    } finally {
      await restored.dispose();
    }
  });

  test('transcriptTail returns undefined for an id this window has never heard of', async () => {
    const tail = await manager.transcriptTail('nope' as never);
    assert.strictEqual(tail, undefined);
  });
```

Check the suite-level `setup()`/`teardown()` in that file for how `manager`,
`dir`, `store`, and `providers` are constructed and whether `manager` is
recreated fresh per test — reuse those exact bindings rather than
constructing new ones, except in the "known-but-not-live" test above, which
deliberately needs a second `SessionManager` over the same `store`/`providers`
to simulate a restart (the same pattern
`self-control-mcp-server.test.ts`'s "reaches a session list_sessions
advertises but no pane has opened this launch" test already uses).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "transcriptTail"`
Expected: FAIL with `manager.transcriptTail is not a function`.

- [ ] **Step 3: Implement `transcriptTail()`**

Add to `src/host/session-manager.ts`, directly after `resolveRefs()` (after
line 1389):

```ts
  /**
   * A bounded, most-recent-last slice of `id`'s own transcript, raw and
   * unsummarized — for `marcode__get_session_context`, which reads a
   * session's activity itself rather than through `resolveRefs()`'s
   * host-built recap. Same live/dead split as `resolveRefs`: a live
   * session's `snapshot()` already flushes pending writes and holds
   * everything appended this launch, sliced to `limit` here since
   * `snapshot()` itself does not cap; a merely-known session (restored from
   * disk, not reopened this launch) reads its tail straight from the store,
   * which already caps. `undefined` only for an id this window has never
   * heard of.
   */
  async transcriptTail(
    id: SessionId, limit = 30,
  ): Promise<{ items: TranscriptItem[] } | undefined> {
    if (!this.meta.has(id)) { return undefined; }
    const live = this.live.get(id);
    if (live) {
      const { items } = await live.snapshot();
      return { items: items.slice(-limit) };
    }
    return this.store.tail(id, limit);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "transcriptTail"`
Expected: PASS

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: SessionManager.transcriptTail() reads a raw transcript slice"
```

---

### Task 4: `marcode__get_session_context` tool

**Files:**
- Modify: `src/host/self-control-mcp-server.ts`
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: `SessionManager.transcriptTail()` from Task 3, structurally
  through a new `SessionManagerLike.transcriptTail` method.
- Produces: the `marcode__get_session_context` MCP tool, registered in
  `buildMcpServer()`.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/self-control-mcp-server.test.ts`, add `transcriptTail` to
the `fakeManager()` defaults:

```ts
function fakeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    catalog: () => [
      { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }] },
    ],
    create: async () => ({ state: { id: 's-fake-1' } }),
    summaries: () => [],
    visibleIds: () => [],
    get: async () => undefined,
    transcriptTail: async () => ({ items: [] }),
    ...overrides,
  };
}
```

Then add a new suite, after `'SelfControlMcpServer cross-session messaging'`:

```ts
suite('SelfControlMcpServer session context', () => {
  test('marcode__get_session_context returns the target session\'s transcript tail', async () => {
    const items = [{ id: 'u1', ts: 1, role: 'user', text: 'hi' } as never];
    let seenId: string | undefined;
    let seenLimit: number | undefined;
    const manager = fakeManager({
      summaries: () => [
        { id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never,
        { id: 's-target', name: 'b', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never,
      ],
      transcriptTail: async (id, limit) => { seenId = id; seenLimit = limit; return { items }; },
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callTool(config, 'marcode__get_session_context', { name: 'b' });
    const body = JSON.parse(result.content[0].text) as { items: unknown[] };
    assert.deepStrictEqual(body.items, items);
    assert.strictEqual(seenId, 's-target');
    assert.strictEqual(seenLimit, 30);
    await server.dispose();
  });

  test('marcode__get_session_context passes a custom limit through', async () => {
    let seenLimit: number | undefined;
    const manager = fakeManager({
      summaries: () => [{ id: 's-target', name: 'b', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
      transcriptTail: async (_id, limit) => { seenLimit = limit; return { items: [] }; },
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    await callTool(config, 'marcode__get_session_context', { name: 'b', limit: 5 });
    assert.strictEqual(seenLimit, 5);
    await server.dispose();
  });

  test('marcode__get_session_context errors on an unknown session name', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const result = await callTool(config, 'marcode__get_session_context', { name: 'nobody' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('marcode__get_session_context errors when the name is the caller\'s own, case-insensitively', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'Alice', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__get_session_context', { name: 'alice' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('a real call against a real SessionManager returns the live session\'s own transcript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-self-control-ctx-'));
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const manager = new SessionManager(store, providers, () => {});
    await manager.init();

    try {
      const target = await manager.create('fake', process.cwd());
      manager.rename(target.state.id, 'target');
      target.send('hello');

      const server = new SelfControlMcpServer({
        catalog: () => manager.catalog(),
        create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
        summaries: () => manager.summaries(),
        visibleIds: () => manager.visibleIds(),
        get: async (id) => manager.get(id as never),
        transcriptTail: (id, limit) => manager.transcriptTail(id as never, limit),
      });
      const config = await server.start();
      const result = await callTool(config, 'marcode__get_session_context', { name: 'target' });
      const body = JSON.parse(result.content[0].text) as { items: { role: string; text?: string }[] };
      assert.strictEqual(body.items.some((i) => i.role === 'user' && i.text === 'hello'), true);
      await server.dispose();
    } finally {
      await manager.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "session context"`
Expected: FAIL — `marcode__get_session_context` is not a registered tool, so
`callTool` gets back a JSON-RPC "Unknown tool" style error, and every
assertion above about `body.items`/`seenId`/`seenLimit` fails or throws.
`fakeManager`'s added `transcriptTail` field will also fail `check-types`
until Step 3 adds it to the interface.

- [ ] **Step 3: Extend `SessionManagerLike` and register the tool**

In `src/host/self-control-mcp-server.ts`, add `TranscriptItem` to the
existing protocol import:

```ts
import type { PermissionMode, TranscriptItem } from '../protocol/messages';
```

Add a method to the `SessionManagerLike` interface (after `get()`, around
line 46):

```ts
  /**
   * A bounded, most-recent-last slice of a session's own transcript — live
   * or merely known (restored from disk, not yet reopened this launch). See
   * `SessionManager.transcriptTail()`. `undefined` only for an id this
   * window has never heard of; `marcode__get_session_context` has already
   * resolved the id from `summaries()` before calling this, so that case is
   * defensive here.
   */
  transcriptTail(id: string, limit?: number): Promise<{ items: TranscriptItem[] } | undefined>;
```

Register the tool in `buildMcpServer()`, after `marcode__send_message`
(after line 271, before `return mcp;`):

```ts
    mcp.registerTool(
      'marcode__get_session_context',
      {
        title: 'Read another Marcode session\'s recent activity',
        description: 'Marcode-specific: reads a bounded, raw slice of a DIFFERENT Marcode '
          + 'session\'s own transcript (its messages and tool calls, most recent last) — not a '
          + 'summary, and unrelated to any built-in memory/context tool you have, which only sees '
          + 'this conversation. Get the target name from marcode__list_sessions first. Nothing '
          + 'about another session is ever pulled in automatically — call this yourself whenever '
          + 'you decide you need to know what it did or said.',
        inputSchema: {
          name: z.string().describe('The target session\'s name, from marcode__list_sessions.'),
          limit: z.number().optional().describe('Max transcript items to return, most recent. Defaults to 30.'),
        },
      },
      async ({ name, limit }) => {
        const from = caller();
        if (from && name.toLowerCase() === from.name.toLowerCase()) {
          return { isError: true, content: [{ type: 'text', text: 'Cannot fetch your own context; you already have it.' }] };
        }
        const target = this.sessionManager.summaries()
          .find((s) => s.name.toLowerCase() === name.toLowerCase() && !s.archived);
        if (!target) {
          return { isError: true, content: [{ type: 'text', text: `Unknown session: ${name}` }] };
        }
        const tail = await this.sessionManager.transcriptTail(target.id, limit ?? 30);
        if (!tail) {
          return { isError: true, content: [{ type: 'text', text: `Session ${name} is not available.` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ items: tail.items }) }] };
      },
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "session context"`
Expected: PASS

- [ ] **Step 5: Run the whole unit suite**

Run: `yarn test:unit`
Expected: PASS — confirms the `SessionManagerLike` interface change didn't
break any other fake construction across the test file.

- [ ] **Step 6: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts
git commit -m "feat: add marcode__get_session_context MCP tool"
```

---

### Task 5: Wire `transcriptTail` through `extension.ts`

**Files:**
- Modify: `src/extension.ts:254-272`

**Interfaces:**
- Consumes: `SessionManager.transcriptTail()` (Task 3),
  `SessionManagerLike.transcriptTail` (Task 4).
- Produces: nothing further downstream — this is the last wiring point.

- [ ] **Step 1: Add the field to the `SelfControlMcpServer` construction**

In `src/extension.ts`, inside the object literal passed to `new
SelfControlMcpServer(...)` (around line 254-272), add `transcriptTail`
alongside the existing `get`:

```ts
  const selfControlServer = new SelfControlMcpServer({
    catalog: () => manager.catalog(),
    create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
    summaries: () => manager.summaries(),
    visibleIds: () => manager.visibleIds(),
    get: async (id) => {
      try {
        return await manager.open(id as SessionId);
      } catch {
        return undefined;
      }
    },
    transcriptTail: (id, limit) => manager.transcriptTail(id as SessionId, limit),
  }, memory);
```

This is the whole change — `SessionId` is already imported in this file (used
two lines above), and `manager.transcriptTail` already matches the interface
signature Task 4 declared.

- [ ] **Step 2: Type-check and compile**

Run: `yarn check-types && yarn run compile`
Expected: no errors. There is no unit test for `extension.ts` itself (it's the
activation wiring, exercised only by `@vscode/test-cli` integration tests,
which this plan does not add to); a clean compile is the verification here.

- [ ] **Step 3: Run the full test suite one more time**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS — final confirmation nothing upstream regressed.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire marcode__get_session_context into activate()"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (menu keeps rows, drops pull) → Tasks 1-2. §2 (new
  tool, same input/resolution/output shape as spec'd) → Tasks 3-4. §3
  (testing: session-mentions, composer/no-refs, new MCP tool tests) → Tasks
  1, 2, 4. Extension wiring wasn't called out as its own spec section but is
  required for the tool to actually run — Task 5.
- **Placeholder scan:** none — every step carries real code or an exact test
  command.
- **Type consistency:** `SessionMentionPayload`, `sessionMentions()`,
  `transcriptTail(id, limit?)`, and `SessionManagerLike.transcriptTail` are
  named and typed identically everywhere they're used across Tasks 1-5.
