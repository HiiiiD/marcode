# Session Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach files to a session by paperclip button, drag-and-drop, or pasted screenshot, and have both backends receive them natively.

**Architecture:** An attachment is a file on disk with an absolute path. Pasted bytes cross the wire once, are written by a new `AttachmentStore` under `context.storageUri`, and become an `Attachment` the host mints. The pending set lives on `AgentSession` (host state, shipped on `SessionSnapshot`, replaced wholesale by a `session-attachments` message), is drained by `send`, and is rendered by each provider in its own shape — `ImageBlockParam` for Claude, `{type:'localImage', path}` for Codex.

**Tech Stack:** TypeScript, React 19, Tailwind v4, shadcn over Base UI, esbuild, mocha (unit + jsdom DOM tests), `@anthropic-ai/claude-agent-sdk`, codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-08-16-session-attachments-design.md`

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts` imports `vscode`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions. Nothing rejects across `postMessage`.
- Filenames are kebab-case. Component identifiers stay PascalCase.
- UI: shadcn components from `@/components/ui/*` only — no bare `<button>`, `<input>`, `<select>`, `<textarea>`. Compose classNames with `cn` from `@/lib/utils`, never template literals.
- Prefer short Tailwind token utilities (`bg-muted`, `text-muted-foreground`); arbitrary values only for computed values (`min()`, `calc()`, `color-mix()`).
- DOM tests drive components through the real `StoreProvider` via `sendFromHost`. Never mock `useStore`, never hand-build a `ClientState`.
- **Never pass a DOM node to an assertion.** Compare booleans, strings or counts.
- Caps, fixed: **10 MB** per attachment, **10** attachments pending per session.
- Attachment directory: `<transcript rootDir>/attachments/<sessionId>/`.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after every task.
- `yarn lint`, `yarn check-types`, `yarn run compile` must pass before every commit.
- Unit tests: `yarn test:unit`. DOM tests: `yarn test:dom`.
- Branch: create `feat/session-attachments` off `master` before Task 1 (`git checkout -b feat/session-attachments`).

---

### Task 1: `Attachment` type and `AttachmentStore`

The store is the only thing that mints an `Attachment`. It writes pasted bytes, adopts existing paths in place, enforces the caps, and reaps a session's directory.

**Files:**
- Modify: `src/protocol/messages.ts` (add the `Attachment` type near `SessionRef`, line ~24)
- Create: `src/host/attachment-store.ts`
- Test: `src/test/unit/attachment-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AttachmentKind = 'image' | 'file'`
  - `interface Attachment { id: string; path: string; name: string; kind: AttachmentKind; mediaType?: string; bytes: number }`
  - `class AttachmentStore { constructor(rootDir: string); savePaste(sessionId: string, input: { name: string; mediaType?: string; base64: string }): Promise<Attachment | { error: string }>; adopt(sessionId: string, paths: string[]): Promise<{ attachments: Attachment[]; rejected: string[] }>; remove(sessionId: string): Promise<void> }`
  - `const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`
  - `const MAX_PENDING = 10`

- [ ] **Step 1: Add the wire type**

In `src/protocol/messages.ts`, immediately after the `SessionRef` interface (line 24), add:

```ts
export type AttachmentKind = 'image' | 'file';

/**
 * A file carried by a turn. Always a real path on disk: a pasted screenshot
 * is written to `context.storageUri` before it becomes one, so paste, the
 * file picker and drag-and-drop all converge on a single model before
 * anything downstream has to care which one it was.
 *
 * `kind` is what decides how a provider renders it — an image goes inline as
 * a native image input, anything else is named by path for the agent to read
 * with its own tools.
 */
export interface Attachment {
  /** Stable within a session. The chip's key and the handle `attach-remove` names. */
  id: string;
  /** Absolute. Deliberately not workspace-relative: a screenshot in ~/Downloads is the common case. */
  path: string;
  /** Basename. What the chip shows. */
  name: string;
  kind: AttachmentKind;
  /** Set for images; supplies the Claude block's `media_type`. */
  mediaType?: string;
  bytes: number;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/test/unit/attachment-store.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from '../../host/attachment-store';

async function tmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-attach-'));
}

/** A 1x1 PNG. Small, and a real image so kind-sniffing has something honest to read. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

suite('AttachmentStore', () => {
  test('savePaste writes the bytes and mints an image attachment', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const result = await store.savePaste('s1', {
      name: 'screenshot.png', mediaType: 'image/png', base64: PNG_B64,
    });

    assert.strictEqual('error' in result, false);
    const att = result as Exclude<typeof result, { error: string }>;
    assert.strictEqual(att.kind, 'image');
    assert.strictEqual(att.mediaType, 'image/png');
    assert.strictEqual(att.name, 'screenshot.png');
    assert.strictEqual(path.isAbsolute(att.path), true);
    assert.strictEqual(att.path.startsWith(path.join(root, 'attachments', 's1')), true);
    const onDisk = await fs.readFile(att.path);
    assert.strictEqual(onDisk.toString('base64'), PNG_B64);
    assert.strictEqual(att.bytes, onDisk.byteLength);
  });

  test('savePaste refuses anything over the size cap without writing', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7).toString('base64');
    const result = await store.savePaste('s1', { name: 'big.png', mediaType: 'image/png', base64: huge });

    assert.strictEqual('error' in result, true);
    assert.match((result as { error: string }).error, /10 MB/);
    const dir = path.join(root, 'attachments', 's1');
    const listed = await fs.readdir(dir).catch(() => [] as string[]);
    assert.strictEqual(listed.length, 0);
  });

  test('savePaste never collides two pastes of the same name', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const a = await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });
    const b = await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });

    const pa = (a as Attachment).path;
    const pb = (b as Attachment).path;
    assert.strictEqual(pa === pb, false);
    assert.strictEqual((a as Attachment).id === (b as Attachment).id, false);
  });

  test('adopt references an existing file in place and sniffs its kind', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    const outside = path.join(await tmpRoot(), 'notes.md');
    await fs.writeFile(outside, '# hello', 'utf8');

    const { attachments, rejected } = await store.adopt('s1', [outside]);

    assert.strictEqual(rejected.length, 0);
    assert.strictEqual(attachments.length, 1);
    assert.strictEqual(attachments[0].kind, 'file');
    assert.strictEqual(attachments[0].path, outside);
    assert.strictEqual(attachments[0].name, 'notes.md');
    assert.strictEqual(attachments[0].bytes, 7);
  });

  test('adopt rejects a missing path instead of throwing', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const { attachments, rejected } = await store.adopt('s1', [path.join(root, 'nope.txt')]);

    assert.strictEqual(attachments.length, 0);
    assert.strictEqual(rejected.length, 1);
  });

  test('remove reaps the session directory', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });

    await store.remove('s1');

    const exists = await fs.stat(path.join(root, 'attachments', 's1')).then(() => true, () => false);
    assert.strictEqual(exists, false);
  });
});
```

Add the missing import at the top of the test file: `import type { Attachment } from '../../protocol/messages';`

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../host/attachment-store'`.

- [ ] **Step 4: Write the store**

Create `src/host/attachment-store.ts`:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Attachment, AttachmentKind } from '../protocol/messages';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING = 10;

const IMAGE_EXT = new Map<string, string>([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

/**
 * Kind is decided by mediaType when the clipboard supplied one, and by
 * extension otherwise. Deliberately not by sniffing magic bytes: the only
 * consumer of `kind` is which provider payload an attachment becomes, and a
 * file the user believes is a PNG should travel as one even if it is not —
 * the backend's own error is a better report than a silent reclassification.
 */
function kindOf(name: string, mediaType?: string): { kind: AttachmentKind; mediaType?: string } {
  if (mediaType?.startsWith('image/')) { return { kind: 'image', mediaType }; }
  const guessed = IMAGE_EXT.get(path.extname(name).toLowerCase());
  return guessed ? { kind: 'image', mediaType: guessed } : { kind: 'file' };
}

/**
 * The one thing that mints an `Attachment`.
 *
 * A sibling of TranscriptStore: same rootDir, no `vscode` import, so it unit
 * tests outside the extension host. Pasted bytes are written here because a
 * screenshot has no path of its own; a picked or dropped file is referenced
 * where it already lives, since a file the user already has on disk is
 * already durable and copying it would only create a second thing to keep in
 * sync.
 */
export class AttachmentStore {
  private counter = 0;

  constructor(private readonly rootDir: string) {}

  private dirFor(sessionId: string): string {
    return path.join(this.rootDir, 'attachments', sessionId);
  }

  async savePaste(
    sessionId: string,
    input: { name: string; mediaType?: string; base64: string },
  ): Promise<Attachment | { error: string }> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.base64, 'base64');
    } catch {
      return { error: 'That paste was not readable.' };
    }
    if (bytes.byteLength === 0) { return { error: 'That paste was empty.' }; }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { error: 'Attachments are limited to 10 MB.' };
    }

    const { kind, mediaType } = kindOf(input.name, input.mediaType);
    const id = this.nextId();
    const dir = this.dirFor(sessionId);
    const file = path.join(dir, `${id}${path.extname(input.name) || extFor(mediaType)}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      // Atomic, matching TranscriptStore.writeAtomic: a partial write lands on
      // a temp file and the destination is only ever swapped in whole.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
    } catch (err) {
      return { error: `Could not save that attachment: ${(err as Error).message}` };
    }
    return { id, path: file, name: input.name, kind, mediaType, bytes: bytes.byteLength };
  }

  async adopt(sessionId: string, paths: string[]): Promise<{ attachments: Attachment[]; rejected: string[] }> {
    const attachments: Attachment[] = [];
    const rejected: string[] = [];
    for (const p of paths) {
      let size: number;
      try {
        const stat = await fs.stat(p);
        if (!stat.isFile()) { rejected.push(p); continue; }
        size = stat.size;
      } catch {
        rejected.push(p);
        continue;
      }
      if (size > MAX_ATTACHMENT_BYTES) { rejected.push(p); continue; }
      const name = path.basename(p);
      const { kind, mediaType } = kindOf(name);
      attachments.push({ id: this.nextId(), path: p, name, kind, mediaType, bytes: size });
    }
    return { attachments, rejected };
  }

  /** Reaps a deleted session's pasted files. Best effort: a failure here must not fail the delete. */
  async remove(sessionId: string): Promise<void> {
    await fs.rm(this.dirFor(sessionId), { recursive: true, force: true }).catch(() => {});
  }

  private nextId(): string {
    this.counter += 1;
    return `a${Date.now().toString(36)}${this.counter}`;
  }
}

function extFor(mediaType?: string): string {
  for (const [ext, mt] of IMAGE_EXT) { if (mt === mediaType) { return ext; } }
  return '';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, including the six new `AttachmentStore` tests.

- [ ] **Step 6: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/protocol/messages.ts src/host/attachment-store.ts src/test/unit/attachment-store.test.ts
git commit -m "feat: attachment store"
```

---

### Task 2: Pending attachments on `AgentSession`

The session owns the pending set and drains it on send.

**Files:**
- Modify: `src/protocol/messages.ts` (user `TranscriptItem`, `SessionSnapshot`)
- Modify: `src/host/agent-session.ts` (`send`, new pending state, snapshot)
- Test: `src/test/unit/agent-session-attachments.test.ts`

**Interfaces:**
- Consumes: `Attachment` from Task 1.
- Produces on `AgentSession`:
  - `get pendingAttachments(): Attachment[]`
  - `addAttachments(next: Attachment[]): void`
  - `removeAttachment(attachmentId: string): void`
  - `send(text: string, context?: EditorContext, refs?: SessionRef[]): void` — unchanged signature; drains the pending set internally.

- [ ] **Step 1: Extend the wire types**

In `src/protocol/messages.ts`, add `attachments` to the user arm of `TranscriptItem` (after `refs`, line 37):

```ts
      /**
       * Files this message carried. Metadata about the message exactly like
       * `context` and `refs` above — `text` is the fully-composed prompt, and
       * an attachment never appears in it: an image goes to the provider as a
       * native image input, and a file goes as a path line the provider adds.
       */
      attachments?: Attachment[];
```

And in `SessionSnapshot`, after `mcpServers` (line 141):

```ts
  /**
   * Composed but not yet sent. Live host state like `mcpServers`, deliberately
   * not on SessionState (which is what index.json stores) — but it does
   * outlive a webview reload, because the extension host does.
   */
  pendingAttachments: Attachment[];
```

- [ ] **Step 2: Write the failing tests**

Create `src/test/unit/agent-session-attachments.test.ts`. Mirror the construction the existing `src/test/unit/agent-session.test.ts` uses — open that file and reuse its session-building helper verbatim rather than inventing a second one.

```ts
import * as assert from 'assert';
import type { Attachment } from '../../protocol/messages';

/** Replace with the helper `src/test/unit/agent-session.test.ts` already uses. */
import { makeSession } from './agent-session.test';

function att(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, path: `/tmp/${id}.png`, name: `${id}.png`, kind: 'image', mediaType: 'image/png', bytes: 4, ...over };
}

suite('AgentSession attachments', () => {
  test('added attachments show up as pending', async () => {
    const { session } = await makeSession();
    session.addAttachments([att('a1')]);
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a1']);
  });

  test('removeAttachment drops one by id', async () => {
    const { session } = await makeSession();
    session.addAttachments([att('a1'), att('a2')]);
    session.removeAttachment('a1');
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a2']);
  });

  test('addAttachments refuses past the pending cap', async () => {
    const { session } = await makeSession();
    session.addAttachments(Array.from({ length: 10 }, (_, i) => att(`a${i}`)));
    session.addAttachments([att('overflow')]);
    assert.strictEqual(session.pendingAttachments.length, 10);
    assert.strictEqual(session.pendingAttachments.some((a) => a.id === 'overflow'), false);
  });

  test('send drains the pending set onto the transcript item and the run', async () => {
    const { session, run } = await makeSession();
    session.addAttachments([att('a1')]);

    session.send('look at this');

    assert.strictEqual(session.pendingAttachments.length, 0);
    const snap = await session.snapshot();
    const last = snap.items.at(-1);
    assert.strictEqual(last?.role, 'user');
    assert.deepStrictEqual(
      last?.role === 'user' ? last.attachments?.map((a) => a.id) : undefined,
      ['a1'],
    );
    // The fake run records every (text, context, attachments) triple it was sent.
    assert.deepStrictEqual(run.sent.at(-1)?.attachments?.map((a) => a.id), ['a1']);
  });

  test('a send with nothing pending carries no attachments field', async () => {
    const { session } = await makeSession();
    session.send('plain');
    const snap = await session.snapshot();
    const last = snap.items.at(-1);
    assert.strictEqual(last?.role === 'user' && last.attachments === undefined, true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `session.addAttachments is not a function`.

- [ ] **Step 4: Implement on `AgentSession`**

In `src/host/agent-session.ts`, add the field and accessors near the other live state, and change `send` (line 210) to drain:

```ts
  /**
   * Composed but not yet sent. Host state, not webview state: attachments
   * arrive asynchronously (a paste is written to disk before it becomes one),
   * so a composer-local list would be the webview holding something the host
   * does not.
   */
  private attachments: Attachment[] = [];

  get pendingAttachments(): Attachment[] { return [...this.attachments]; }

  /** Silently ignores anything past the cap — the router reports the refusal. */
  addAttachments(next: Attachment[]): void {
    const room = MAX_PENDING - this.attachments.length;
    if (room <= 0) { return; }
    this.attachments = [...this.attachments, ...next.slice(0, room)];
    this.sink.changed();
  }

  removeAttachment(attachmentId: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== attachmentId);
    this.sink.changed();
  }

  send(text: string, context?: EditorContext, refs?: SessionRef[]): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    // Drained before anything else can append: the pending set belongs to the
    // turn being composed, and a paste that lands while the provider is
    // starting belongs to the next one.
    const attachments = this.attachments;
    this.attachments = [];
    const item: TranscriptItem = {
      id: nextId('u'), ts: Date.now(), role: 'user', text,
      ...(context ? { context } : {}),
      ...(refs && refs.length > 0 ? { refs } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    const outgoing = this.seed ? `${this.seed}\n\n---\n\n${text}` : text;
    this.seed = undefined;
    try {
      this.run.send(outgoing, context, attachments.length > 0 ? attachments : undefined);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }
```

Import `MAX_PENDING` from `./attachment-store` and `Attachment` from `../protocol/messages`. In the method that builds the snapshot, add `pendingAttachments: this.pendingAttachments`.

`run.send`'s third parameter does not exist yet — Task 3 adds it. Until then `yarn check-types` fails on that line; that is expected and Task 3 clears it. **Do not** commit this task before Task 3's type change if the repo's commit gate must pass; instead, apply Task 3 Step 1 (the `AgentRun.send` signature) now, then return here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/protocol/messages.ts src/host/agent-session.ts src/providers/types.ts src/test/unit/agent-session-attachments.test.ts
git commit -m "feat: pending attachments on a session"
```

---

### Task 3: Claude renders attachments as image blocks

**Files:**
- Modify: `src/providers/types.ts:194` (`AgentRun.send`)
- Modify: `src/providers/claude/claude-provider.ts:519-530`
- Create: `src/providers/attachment-payload.ts` (shared, provider-agnostic)
- Modify: `src/providers/fake/fake-provider.ts:126`
- Test: `src/test/unit/attachment-payload.test.ts`, and a new case in the existing Claude provider suite

**Interfaces:**
- Consumes: `Attachment` from Task 1.
- Produces:
  - `AgentRun.send(text: string, context?: EditorContext, attachments?: Attachment[]): void`
  - `function attachmentLines(attachments: Attachment[] | undefined): string` — the path lines appended to a prompt for non-image attachments; `''` when there are none.
  - `function imageAttachments(attachments: Attachment[] | undefined): Attachment[]`
  - `FakeProvider`'s recorded sends become `{ text, context, attachments }`.

- [ ] **Step 1: Widen the interface**

In `src/providers/types.ts`, replace line 194:

```ts
export interface AgentRun {
  /**
   * `attachments` belong to the turn `text` was composed with, which is why
   * they ride this call rather than a method of their own: a provider cannot
   * represent a turn whose files arrived independently of its prose.
   */
  send(text: string, context?: EditorContext, attachments?: Attachment[]): void;
```

Import `Attachment` from `../protocol/messages`… **no** — that would invert the dependency (`protocol` imports from `providers`, never the reverse). Move the `Attachment` and `AttachmentKind` declarations into `src/providers/types.ts` beside `EditorContext` (line ~71) and re-export them from `messages.ts` in the existing `export type { ... }` block at lines 1-9, exactly as `EditorContext` is handled today. Update Task 1's import in `attachment-store.ts` to `from '../providers/types'` if it is cleaner there; either import path is fine as long as the declaration lives in `providers/types.ts`.

- [ ] **Step 2: Write the failing tests**

Create `src/test/unit/attachment-payload.test.ts`:

```ts
import * as assert from 'assert';
import type { Attachment } from '../../providers/types';
import { attachmentLines, imageAttachments } from '../../providers/attachment-payload';

const image: Attachment = {
  id: 'a1', path: '/tmp/shot.png', name: 'shot.png',
  kind: 'image', mediaType: 'image/png', bytes: 10,
};
const file: Attachment = {
  id: 'a2', path: '/work/notes.md', name: 'notes.md', kind: 'file', bytes: 7,
};

suite('attachment payload', () => {
  test('no attachments produces no lines', () => {
    assert.strictEqual(attachmentLines(undefined), '');
    assert.strictEqual(attachmentLines([]), '');
  });

  test('an image contributes no text — it travels as an image input', () => {
    assert.strictEqual(attachmentLines([image]), '');
  });

  test('a file is named by absolute path', () => {
    const lines = attachmentLines([file]);
    assert.strictEqual(lines.includes('/work/notes.md'), true);
    assert.strictEqual(lines.startsWith('\n'), true);
  });

  test('imageAttachments selects only images', () => {
    assert.deepStrictEqual(imageAttachments([image, file]).map((a) => a.id), ['a1']);
    assert.deepStrictEqual(imageAttachments(undefined), []);
  });
});
```

Add to the existing Claude provider unit suite (find it under `src/test/unit/`, the one that already exercises `send`; follow its existing setup verbatim):

```ts
  test('send appends one image block per image attachment', () => {
    // Arrange the provider exactly as the neighbouring send test does, then:
    run.send('look', undefined, [
      { id: 'a1', path: pngOnDisk, name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: 4 },
    ]);

    const content = lastPrompt().message.content as Array<{ type: string; source?: { media_type: string } }>;
    assert.strictEqual(content.length, 2);
    assert.strictEqual(content[0].type, 'text');
    assert.strictEqual(content[1].type, 'image');
    assert.strictEqual(content[1].source?.media_type, 'image/png');
  });
```

`pngOnDisk` must be a real file the test writes to a tmpdir first — the provider reads the bytes off the path.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../providers/attachment-payload'`.

- [ ] **Step 4: Implement**

Create `src/providers/attachment-payload.ts`:

```ts
import * as fs from 'node:fs';
import type { Attachment } from './types';

/**
 * The prompt text a non-image attachment contributes.
 *
 * Images contribute nothing here: they go to the backend as a native image
 * input, and naming them in the text as well would tell the model to go and
 * read a file it can already see.
 */
export function attachmentLines(attachments: Attachment[] | undefined): string {
  const files = (attachments ?? []).filter((a) => a.kind !== 'image');
  if (files.length === 0) { return ''; }
  const lines = files.map((a) => `- ${a.path}`).join('\n');
  return `\n\nAttached files:\n${lines}`;
}

export function imageAttachments(attachments: Attachment[] | undefined): Attachment[] {
  return (attachments ?? []).filter((a) => a.kind === 'image');
}

/**
 * Base64 for an image attachment, or undefined if it has gone since it was
 * attached. Errors are state: an unreadable image drops out of the turn
 * rather than failing it, because the prose the user wrote is still worth
 * sending.
 */
export function readBase64(a: Attachment): string | undefined {
  try {
    return fs.readFileSync(a.path).toString('base64');
  } catch {
    return undefined;
  }
}
```

Then in `src/providers/claude/claude-provider.ts`, replace the `send` at line 519:

```ts
      send: (text: string, context?: EditorContext, attachments?: Attachment[]) => {
        ensureStarted();
        // One text block, then one image block per image attachment. The text
        // block's shape is unchanged whether or not context is attached, for
        // the same reason as before; images are additive.
        const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
        const content: ContentBlockParam[] = [
          { type: 'text', text: `${body}${attachmentLines(attachments)}` },
        ];
        for (const image of imageAttachments(attachments)) {
          const data = readBase64(image);
          if (!data) { continue; }
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: (image.mediaType ?? 'image/png') as 'image/png',
              data,
            },
          });
        }
        prompts.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        });
      },
```

Import `ContentBlockParam` from `@anthropic-ai/sdk/resources/messages` (follow whatever import style the file already uses for SDK types), and the three helpers from `../attachment-payload`.

In `src/providers/fake/fake-provider.ts:126`, widen the recorder:

```ts
      send: (text: string, context?: EditorContext, attachments?: Attachment[]) => {
        this.sent.push({ text, context, attachments });
```

and update the field's type and its doc comment (line 83) to `/** Records every (text, context, attachments) triple passed to send, for assertions. */`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/providers/ src/test/unit/attachment-payload.test.ts
git commit -m "feat: claude sends image attachments as image blocks"
```

---

### Task 4: Codex renders attachments as `localImage` inputs

**Files:**
- Modify: `src/providers/codex/wire.ts` (add `UserInput`, model `imageView`)
- Modify: `src/providers/codex/codex-run.ts:343-376`
- Test: add cases to the existing `src/test/unit/codex-run.test.ts`

**Interfaces:**
- Consumes: `Attachment`, `attachmentLines`, `imageAttachments` from Task 3.
- Produces: `type UserInput` in `wire.ts`, mirroring `.codex-bindings/v2/UserInput.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/codex-run.test.ts`, following the file's existing pattern for asserting a `turn/start` payload:

```ts
  test('turn/start carries one localImage item per image attachment', async () => {
    // Build the run exactly as the neighbouring send test does, then:
    run.send('look at this', undefined, [
      { id: 'a1', path: '/tmp/shot.png', name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: 4 },
      { id: 'a2', path: '/work/notes.md', name: 'notes.md', kind: 'file', bytes: 7 },
    ]);
    await flush(); // the suite's existing helper for draining ensureStarted()

    const params = lastRequest('turn/start').params as { input: Array<Record<string, unknown>> };
    assert.strictEqual(params.input.length, 2);
    assert.strictEqual(params.input[0].type, 'text');
    // The non-image attachment is named in the text, not sent as an input item.
    assert.strictEqual(String(params.input[0].text).includes('/work/notes.md'), true);
    assert.deepStrictEqual(params.input[1], { type: 'localImage', path: '/tmp/shot.png', detail: 'auto' });
  });

  test('a send with no attachments is byte-identical to today', async () => {
    run.send('plain');
    await flush();
    const params = lastRequest('turn/start').params as { input: Array<Record<string, unknown>> };
    assert.deepStrictEqual(params.input, [{ type: 'text', text: 'plain', text_elements: [] }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — the first test gets `input.length === 1`.

- [ ] **Step 3: Add the wire type**

In `src/providers/codex/wire.ts`, add — keeping the file's existing "verified against 0.147.0" comment convention:

```ts
/**
 * `turn/start`'s input items. Mirrors `.codex-bindings/v2/UserInput.ts`,
 * verified against codex-cli 0.147.0. Only the variants this panel actually
 * sends are declared: adding one is a deliberate act, and the skew test
 * checks method names only, so the payload shape is guarded by
 * `codex-run.test.ts` instead.
 */
export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string; detail?: ImageDetail };

export type ImageDetail = 'auto' | 'low' | 'high' | 'original';
```

Also add the `imageView` arm to the `ThreadItem` union in `wire.ts` (around line 101-137), so an echoed image is a known item rather than falling through the tolerant catch-all:

```ts
  /**
   * An image the user sent, echoed back into the thread. Modelled so it does
   * not land in the catch-all; it renders as nothing on its own, because the
   * user item that carried it is already in the transcript.
   */
  | { type: 'imageView'; id: string; path: string }
```

- [ ] **Step 4: Implement the send**

In `src/providers/codex/codex-run.ts`, replace the `send` at line 343:

```ts
  send(text: string, context?: EditorContext, attachments?: Attachment[]): void {
    // One text item, same as before, plus one localImage item per image.
    // Codex takes a path here rather than bytes, so nothing is re-encoded.
    const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    const input: UserInput[] = [
      { type: 'text', text: `${body}${attachmentLines(attachments)}`, text_elements: [] },
    ];
    for (const image of imageAttachments(attachments)) {
      input.push({ type: 'localImage', path: image.path, detail: 'auto' });
    }
    this.ensureStarted().then((threadId) => {
      if (this.dead || !threadId) { return; }
      const settings = codexSettings(this.mode);
      this.server.request('turn/start', {
        threadId,
        input,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandboxPolicy: sandboxPolicyOf(this.mode),
        model: this.model,
        effort: this.effort,
      }).catch((err: unknown) => {
        this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
      });
    });
  }
```

Keep the existing block comment about `TurnStartParams` overrides in place, unchanged, above `approvalPolicy`.

In `src/providers/codex/map-events.ts`, make `imageView` map to no event (an explicit empty return with a one-line comment), so it is a decision rather than an omission.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, including the untouched-payload regression test.

- [ ] **Step 6: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/providers/codex/ src/test/unit/codex-run.test.ts
git commit -m "feat: codex sends image attachments as localImage inputs"
```

---

### Task 5: Router messages and the file-picker seam

**Files:**
- Modify: `src/protocol/messages.ts` (four `WebviewToHost` tags, two `HostToWebview`)
- Create: `src/host/file-uri.ts`
- Modify: `src/host/message-router.ts` (handlers, `KNOWN_MESSAGE_TAGS`, `AttachmentHost`)
- Modify: `src/host/session-manager.ts` (reap on delete; expose the store)
- Modify: `src/extension.ts` (construct the store, supply the real `AttachmentHost`)
- Test: `src/test/unit/file-uri.test.ts`, and new cases in `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `AttachmentStore` (Task 1), `AgentSession.addAttachments` / `removeAttachment` / `pendingAttachments` (Task 2).
- Produces:
  - `interface AttachmentHost { pick(): Promise<string[]> }`
  - `function fsPathOfUri(uri: string): string | undefined`
  - `MessageRouter` constructor gains two parameters: `attachments: AttachmentStore`, `picker: AttachmentHost = NO_PICKER`.

- [ ] **Step 1: Add the wire messages**

In `src/protocol/messages.ts`, in `WebviewToHost` after `set-include-context` (line 252):

```ts
  /**
   * A pasted image. `base64` is the only place bytes ever cross this wire,
   * and they cross exactly once: the host writes them to disk and everything
   * afterwards refers to the path.
   */
  | { t: 'attach-paste'; id: SessionId; name: string; mediaType?: string; base64: string }
  /** Open the host's file picker for this session. The host owns the dialog. */
  | { t: 'attach-pick'; id: SessionId }
  /** A drop. `uris` are what the DataTransfer carried, unparsed. */
  | { t: 'attach-drop'; id: SessionId; uris: string[] }
  | { t: 'attach-remove'; id: SessionId; attachmentId: string }
```

In `HostToWebview` after `session-mcp` (line 320):

```ts
  /** Full replacement, matching `session-invocables` and `session-mcp`. */
  | { t: 'session-attachments'; id: SessionId; attachments: Attachment[] }
  /**
   * One attachment did not make it, and why. Not an error state for the
   * session — the composer is still usable and everything else attached
   * fine — so this is a transient line in the composer, not a transcript item.
   */
  | { t: 'attachments-rejected'; id: SessionId; reason: string }
```

- [ ] **Step 2: Write the failing `file-uri` test**

Create `src/test/unit/file-uri.test.ts`:

```ts
import * as assert from 'assert';
import { fsPathOfUri } from '../../host/file-uri';

suite('fsPathOfUri', () => {
  test('decodes a posix file uri', () => {
    assert.strictEqual(fsPathOfUri('file:///home/me/a%20file.png'), '/home/me/a file.png');
  });

  test('decodes a windows file uri without the leading slash', () => {
    assert.strictEqual(fsPathOfUri('file:///e%3A/work/shot.png'), 'e:/work/shot.png');
  });

  test('refuses a non-file scheme', () => {
    assert.strictEqual(fsPathOfUri('https://example.com/x.png'), undefined);
    assert.strictEqual(fsPathOfUri('untitled:Untitled-1'), undefined);
  });

  test('refuses junk', () => {
    assert.strictEqual(fsPathOfUri('not a uri'), undefined);
    assert.strictEqual(fsPathOfUri(''), undefined);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../host/file-uri'`.

- [ ] **Step 4: Implement `file-uri.ts`**

```ts
/**
 * A dropped `text/uri-list` entry as a filesystem path.
 *
 * Deliberately not `vscode.Uri.parse`: this is reached from MessageRouter,
 * which must stay free of `vscode` so it unit-tests outside the extension
 * host. Anything that is not a plain `file:` URI answers undefined — a drop
 * from a browser or an untitled editor names nothing on disk.
 */
export function fsPathOfUri(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'file:') { return undefined; }
  const decoded = decodeURIComponent(parsed.pathname);
  // Windows: `file:///e:/x` parses to `/e:/x`; the leading slash is not part
  // of the path.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}
```

- [ ] **Step 5: Write the failing router tests**

Add to `src/test/unit/message-router.test.ts`, using its existing harness (a fake `SessionManager` and a captured `emit`):

```ts
  test('attach-paste writes the file and emits the new pending set', async () => {
    const { router, emitted, session } = await routerWithSession();
    await router.handle({
      t: 'attach-paste', id: 'a', name: 'shot.png', mediaType: 'image/png', base64: PNG_B64,
    });

    const msg = emitted().at(-1) as { t: string; id: string; attachments: { name: string }[] };
    assert.strictEqual(msg.t, 'session-attachments');
    assert.strictEqual(msg.id, 'a');
    assert.deepStrictEqual(msg.attachments.map((x) => x.name), ['shot.png']);
    assert.strictEqual(session.pendingAttachments.length, 1);
  });

  test('an oversized paste is rejected without touching the pending set', async () => {
    const { router, emitted, session } = await routerWithSession();
    const huge = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
    await router.handle({ t: 'attach-paste', id: 'a', name: 'big.png', mediaType: 'image/png', base64: huge });

    const msg = emitted().at(-1) as { t: string; reason: string };
    assert.strictEqual(msg.t, 'attachments-rejected');
    assert.match(msg.reason, /10 MB/);
    assert.strictEqual(session.pendingAttachments.length, 0);
  });

  test('attach-drop turns file uris into attachments and ignores the rest', async () => {
    const { router, emitted, session } = await routerWithSession();
    const real = await writeTmpFile('notes.md', '# hi');
    await router.handle({
      t: 'attach-drop', id: 'a',
      uris: [`file:///${real.replace(/\\/g, '/').replace(/^\//, '')}`, 'https://example.com/x.png'],
    });

    assert.strictEqual(session.pendingAttachments.length, 1);
    assert.strictEqual(session.pendingAttachments[0].name, 'notes.md');
    assert.strictEqual((emitted().at(-1) as { t: string }).t, 'session-attachments');
  });

  test('attach-pick adopts what the host dialog returned', async () => {
    const real = await writeTmpFile('pick.md', 'x');
    const { router, session } = await routerWithSession({ pick: async () => [real] });
    await router.handle({ t: 'attach-pick', id: 'a' });
    assert.deepStrictEqual(session.pendingAttachments.map((x) => x.name), ['pick.md']);
  });

  test('attach-pick with a cancelled dialog emits nothing new', async () => {
    const { router, emitted, session } = await routerWithSession({ pick: async () => [] });
    const before = emitted().length;
    await router.handle({ t: 'attach-pick', id: 'a' });
    assert.strictEqual(emitted().length, before);
    assert.strictEqual(session.pendingAttachments.length, 0);
  });

  test('attach-remove drops one and re-emits', async () => {
    const { router, emitted, session } = await routerWithSession();
    await router.handle({ t: 'attach-paste', id: 'a', name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });
    const id = session.pendingAttachments[0].id;

    await router.handle({ t: 'attach-remove', id: 'a', attachmentId: id });

    assert.strictEqual(session.pendingAttachments.length, 0);
    const msg = emitted().at(-1) as { t: string; attachments: unknown[] };
    assert.strictEqual(msg.t, 'session-attachments');
    assert.strictEqual(msg.attachments.length, 0);
  });

  test('an unknown session id is a no-op, not a throw', async () => {
    const { router } = await routerWithSession();
    await router.handle({ t: 'attach-remove', id: 'nope', attachmentId: 'x' });
    // Reaching here without a rejection is the assertion.
    assert.strictEqual(true, true);
  });
```

Write `routerWithSession(picker?)` and `writeTmpFile` as local helpers in that suite, built from whatever fakes the file already has; `PNG_B64` is the same 1x1 PNG constant Task 1 used.

- [ ] **Step 6: Run them to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — the router drops `attach-paste` as a malformed message.

- [ ] **Step 7: Implement the router changes**

In `src/host/message-router.ts`:

```ts
/**
 * The file dialog, kept behind an interface for the same reason as
 * `EditorContextHost`: this module must not import `vscode`. Resolves to []
 * when the user cancels.
 */
export interface AttachmentHost { pick(): Promise<string[]> }

const NO_PICKER: AttachmentHost = { pick: async () => [] };
```

Constructor gains `private readonly attachments: AttachmentStore` and `private readonly picker: AttachmentHost = NO_PICKER`.

Cases, added to the switch:

```ts
      case 'attach-paste': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const saved = await this.attachments.savePaste(msg.id, msg);
        if ('error' in saved) {
          this.emit({ t: 'attachments-rejected', id: msg.id, reason: saved.error });
          return;
        }
        session.addAttachments([saved]);
        this.emitAttachments(session, msg.id);
        return;
      }

      case 'attach-pick': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const picked = await this.picker.pick();
        // A cancelled dialog is not an event: emitting an unchanged set would
        // make the composer flicker for a user who changed their mind.
        if (picked.length === 0) { return; }
        await this.adopt(session, msg.id, picked);
        return;
      }

      case 'attach-drop': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const paths = msg.uris.map(fsPathOfUri).filter((p): p is string => p !== undefined);
        if (paths.length === 0) {
          this.emit({
            t: 'attachments-rejected', id: msg.id,
            reason: 'That drop carried nothing on disk.',
          });
          return;
        }
        await this.adopt(session, msg.id, paths);
        return;
      }

      case 'attach-remove': {
        const session = this.manager.get(msg.id);
        if (!session) { return; }
        session.removeAttachment(msg.attachmentId);
        this.emitAttachments(session, msg.id);
        return;
      }
```

And the two private helpers:

```ts
  private async adopt(session: AgentSession, id: SessionId, paths: string[]): Promise<void> {
    const { attachments, rejected } = await this.attachments.adopt(id, paths);
    if (attachments.length > 0) {
      session.addAttachments(attachments);
      this.emitAttachments(session, id);
    }
    if (rejected.length > 0) {
      this.emit({
        t: 'attachments-rejected', id,
        reason: rejected.length === 1
          ? `Could not attach ${rejected[0]}.`
          : `Could not attach ${rejected.length} of those files.`,
      });
    }
  }

  private emitAttachments(session: AgentSession, id: SessionId): void {
    this.emit({ t: 'session-attachments', id, attachments: session.pendingAttachments });
  }
```

Add all four tags to `KNOWN_MESSAGE_TAGS`.

In `src/host/session-manager.ts`, call `attachments.remove(id)` from the same path that removes a session's transcript, and include `pendingAttachments` wherever a snapshot is built if `AgentSession.snapshot()` does not already supply it.

In `src/extension.ts`, construct `new AttachmentStore(rootDir)` beside `new TranscriptStore(rootDir)` (line 61) and pass it plus the real picker down to `PanelViewProvider` → `MessageRouter`:

```ts
const picker: AttachmentHost = {
  pick: async () => {
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: 'Attach',
    });
    return chosen?.map((u) => u.fsPath) ?? [];
  },
};
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 9: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/protocol/messages.ts src/host/ src/extension.ts src/test/unit/
git commit -m "feat: route attachment messages"
```

---

### Task 6: The chip strip

Attachments render, and can be removed. No way to add one from the UI yet — Task 7 supplies those.

**Files:**
- Modify: `src/webview/reducer.ts` (`PaneState.attachments`, two cases)
- Create: `src/webview/components/attachment-chips.tsx`
- Modify: `src/webview/components/composer.tsx` (mount the strip)
- Test: `src/test/dom/attachments.test.tsx`

**Interfaces:**
- Consumes: `session-attachments`, `attachments-rejected`, `attach-remove` (Task 5); `SessionSnapshot.pendingAttachments` (Task 2).
- Produces:
  - `PaneState.attachments: Attachment[]`
  - `function AttachmentChips({ pane }: { pane: PaneState })`

- [ ] **Step 1: Write the failing DOM test**

Create `src/test/dom/attachments.test.tsx`:

```tsx
import { Composer } from "@/components/composer";
import type { PaneState } from "@/reducer";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { Attachment } from "../../protocol/messages";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderWithStore, sendFromHost } from "./harness";

const NO_EFFORT = catalog()[0].models[1];

function pane(attachments: Attachment[] = []): PaneState {
  return {
    summary: summary('a'), items: [], hasMore: false, pending: [],
    mcpServers: [], attachments,
  };
}

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1', path: '/tmp/shot.png', name: 'shot.png',
    kind: 'image', mediaType: 'image/png', bytes: 2048, ...over,
  };
}

suite("Attachment chips", () => {
  test("a session-attachments message renders one chip per attachment", () => {
    sendFromHost({
      t: "hydrate",
      sessions: [summary("a")],
      layout: layoutOf("a"),
      snapshots: [snapshot("a")],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });
    sendFromHost({ t: "session-attachments", id: "a", attachments: [att(), att({ id: 'a2', name: 'notes.md', kind: 'file' })] });

    // Rendered through the store, so this reads the reducer's output.
    assert.strictEqual(screen.getAllByRole("listitem").length >= 2, true);
    assert.strictEqual(screen.getByText("shot.png") !== null, true);
    assert.strictEqual(screen.getByText("notes.md") !== null, true);
  });

  test("removing a chip posts attach-remove", async () => {
    renderWithStore(<Composer pane={pane([att()])} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /remove shot\.png/i }));

    assert.deepStrictEqual(posted().at(-1), { t: "attach-remove", id: "a", attachmentId: "a1" });
  });

  test("no attachments renders no strip", () => {
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    assert.strictEqual(container.querySelector('[data-testid="attachment-chips"]') === null, true);
  });

  test("a rejection renders its reason", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({ t: "attachments-rejected", id: "a", reason: "Attachments are limited to 10 MB." });

    assert.strictEqual(screen.getByText("Attachments are limited to 10 MB.") !== null, true);
  });
});
```

Note the first test renders the app-level tree; use `renderApp()` from the harness there, matching how `composer.test.tsx` combines `hydrateOne()` with a render.

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — `attachments` is not a property of `PaneState`.

- [ ] **Step 3: Extend the reducer**

In `src/webview/reducer.ts`, add to `PaneState` (after `mcpServers`, line 16):

```ts
  /** Composed but not sent. Host state, mirrored — see the spec's Decisions. */
  attachments: Attachment[];
```

Add `rejectionBySession: Record<SessionId, string | undefined>` to `ClientState`, initialised to `{}` wherever the initial state is built. Then add the two cases beside `session-invocables`:

```ts
    case 'session-attachments': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      // Full replacement, matching the seam: no merge, no ordering to keep.
      // A new set also clears the last rejection — it is stale the moment
      // something else succeeds.
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, attachments: msg.attachments } },
        rejectionBySession: { ...state.rejectionBySession, [msg.id]: undefined },
      };
    }

    case 'attachments-rejected':
      return {
        ...state,
        rejectionBySession: { ...state.rejectionBySession, [msg.id]: msg.reason },
      };
```

And in both places a pane is built from a snapshot (lines ~118 and ~235), add `attachments: s.pendingAttachments ?? []`.

- [ ] **Step 4: Write the chip strip**

Create `src/webview/components/attachment-chips.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileText, ImageIcon, X } from 'lucide-react';
import type { Attachment } from '../../protocol/messages';
import type { PaneState } from '../reducer';
import { useStore } from '../store';

/**
 * What this turn will carry, and the only way to take one back off.
 *
 * A list, not a row of buttons: these are items with a removal action each,
 * and a screen reader user needs the count before deciding to walk them. The
 * name truncates rather than wraps — at 300px a long filename would push the
 * remove control off the chip, and the full name is on the chip's title.
 */
export function AttachmentChips({ pane }: { pane: PaneState }) {
  const { post } = useStore();
  const items = pane.attachments;
  if (items.length === 0) { return null; }

  return (
    <ul
      data-testid="attachment-chips"
      aria-label="Attachments"
      className="flex flex-wrap gap-1"
    >
      {items.map((a) => (
        <li key={a.id}>
          <span
            className={cn(
              'flex max-w-48 items-center gap-1 rounded-md border border-border',
              'bg-muted py-0.5 pl-1.5 pr-0.5 text-xs',
            )}
            title={`${a.path} · ${sizeOf(a)}`}
          >
            {a.kind === 'image'
              ? <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              : <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="truncate">{a.name}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4 shrink-0"
              aria-label={`Remove ${a.name}`}
              onClick={() => post({
                t: 'attach-remove', id: pane.summary.id, attachmentId: a.id,
              })}
            >
              <X />
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Percentages are for shares; a file's size is a size, so it reads as one. */
function sizeOf(a: Attachment): string {
  const kb = a.bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
```

- [ ] **Step 5: Mount it in the composer**

In `src/webview/components/composer.tsx`, add a third `block-start` addon after the `refMenu` block (line 244):

```tsx
        {(pane.attachments.length > 0 || rejection) && (
          <InputGroupAddon align="block-start" className="flex-col items-start gap-1 p-1">
            <AttachmentChips pane={pane} />
            {rejection && (
              // Not a transcript item: nothing about the session failed, and
              // the next successful attach clears it (see the reducer).
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>{rejection}</span>
              </p>
            )}
          </InputGroupAddon>
        )}
```

with `const rejection = state.rejectionBySession[pane.summary.id];` declared beside the other derived values, and the `AttachmentChips` import added.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test:dom && yarn test:unit`
Expected: PASS. Existing DOM suites that hand-build a `PaneState` will fail to type-check until they gain `attachments: []` — add it to every such fixture, including `src/test/fixtures/protocol.ts`'s `snapshot()`, which gains `pendingAttachments: []`.

- [ ] **Step 7: Run the UI detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/attachment-chips.tsx src/webview/components/composer.tsx`
Expected: exit 0. A non-zero exit is a failing check — fix the findings before committing.

- [ ] **Step 8: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/webview/ src/test/
git commit -m "feat: attachment chips in the composer"
```

---

### Task 7: Paperclip, paste and drop

The three ways in.

**Files:**
- Modify: `src/webview/components/composer.tsx` (button, `onPaste`, `onDragOver`/`onDrop`/`onDragLeave`)
- Modify: `src/webview/components/editor-context-toggle.tsx:1,47` (glyph swap)
- Create: `src/webview/lib/read-attachment.ts`
- Test: cases added to `src/test/dom/attachments.test.tsx`; `src/test/unit/read-attachment.test.ts`

**Interfaces:**
- Consumes: `attach-paste`, `attach-pick`, `attach-drop` (Task 5); `AttachmentChips` (Task 6).
- Produces: `function base64Of(file: File): Promise<string>` and `function urisOf(dt: DataTransfer): string[]` in `read-attachment.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/dom/attachments.test.tsx`:

```tsx
  test("the paperclip posts attach-pick", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Attach files" }));
    assert.deepStrictEqual(posted().at(-1), { t: "attach-pick", id: "a" });
  });

  test("pasting an image posts attach-paste with its bytes", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message");

    const file = new File([Uint8Array.from([1, 2, 3, 4])], "image.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    await userEvent.click(box);
    await act(async () => {
      box.dispatchEvent(Object.assign(
        new Event("paste", { bubbles: true }),
        { clipboardData: dt },
      ));
      await new Promise((r) => setTimeout(r, 0)); // FileReader is async
    });

    const msg = posted().at(-1) as { t: string; id: string; mediaType: string; base64: string };
    assert.strictEqual(msg.t, "attach-paste");
    assert.strictEqual(msg.id, "a");
    assert.strictEqual(msg.mediaType, "image/png");
    assert.strictEqual(msg.base64, "AQIDBA==");
  });

  test("pasting plain text does not attach anything", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message");
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello");
    const before = posted().length;
    await act(async () => {
      box.dispatchEvent(Object.assign(new Event("paste", { bubbles: true }), { clipboardData: dt }));
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.strictEqual(posted().length, before);
  });

  test("dropping files posts attach-drop with their uris", async () => {
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const zone = container.querySelector('[data-testid="composer-drop"]') as HTMLElement;

    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///tmp/a.png\r\nfile:///tmp/b.md");
    await act(async () => {
      zone.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: dt }));
    });

    assert.deepStrictEqual(posted().at(-1), {
      t: "attach-drop", id: "a", uris: ["file:///tmp/a.png", "file:///tmp/b.md"],
    });
  });
```

Import `act` from `@testing-library/react` in this suite. If jsdom's `DataTransfer` is unavailable in this environment, build a minimal stand-in object with `items`, `files`, `types` and `getData` in the suite rather than reaching for a polyfill package.

Create `src/test/unit/read-attachment.test.ts`:

```ts
import * as assert from 'assert';
import { urisOf } from '../../webview/lib/read-attachment';

function dt(uriList: string): DataTransfer {
  return { getData: (t: string) => (t === 'text/uri-list' ? uriList : ''), types: ['text/uri-list'] } as unknown as DataTransfer;
}

suite('urisOf', () => {
  test('splits a uri-list on CRLF and drops comments', () => {
    assert.deepStrictEqual(
      urisOf(dt('# comment\r\nfile:///a.png\r\nfile:///b.md\r\n')),
      ['file:///a.png', 'file:///b.md'],
    );
  });

  test('an empty list yields nothing', () => {
    assert.deepStrictEqual(urisOf(dt('')), []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:dom && yarn test:unit`
Expected: FAIL — no "Attach files" button; `read-attachment` not found.

- [ ] **Step 3: Write the reader helpers**

Create `src/webview/lib/read-attachment.ts`:

```ts
/**
 * Base64 for a clipboard or dropped File, without the data-URL prefix.
 *
 * FileReader rather than `arrayBuffer()` + manual encoding: the webview has no
 * Buffer, and hand-rolling base64 over a multi-megabyte screenshot in the
 * render thread is exactly the frame drop this panel cannot afford.
 */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** `text/uri-list` per RFC 2483: CRLF-separated, `#` lines are comments. */
export function urisOf(dt: DataTransfer): string[] {
  return dt.getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
```

- [ ] **Step 4: Wire the composer**

In `src/webview/components/composer.tsx`:

Add local state `const [dragging, setDragging] = useState(false);` and the handler:

```tsx
  const attachFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      void base64Of(file).then((base64) => {
        post({
          t: 'attach-paste', id: pane.summary.id, name: file.name || 'pasted-image.png',
          mediaType: file.type || undefined, base64,
        });
      }).catch(() => {
        // Errors are state, never exceptions: an unreadable clipboard entry
        // simply does not attach. Nothing rejects across postMessage.
      });
    }
  };
```

Wrap the outer container as the drop zone (line 204):

```tsx
    <div
      className="@container p-2"
      data-testid="composer-drop"
      onDragOver={(e) => {
        // Required: without preventDefault the browser navigates to the file
        // and the drop event never fires.
        e.preventDefault();
        if (!dragging) { setDragging(true); }
      }}
      onDragLeave={(e) => {
        // Only when the pointer genuinely left the zone — dragleave also fires
        // when it crosses onto a child, and a ring that flickers per child is
        // worse than no ring.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDragging(false); }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (readOnly) { return; }
        const uris = urisOf(e.dataTransfer);
        if (uris.length > 0) {
          post({ t: 'attach-drop', id: pane.summary.id, uris });
          return;
        }
        // A drop from outside the IDE carries Files but no uri-list, and its
        // bytes are all there is — the same path as a paste.
        if (e.dataTransfer.files.length > 0) { attachFiles(e.dataTransfer.files); }
      }}
    >
```

Put the ring on the `InputGroup` so the affordance sits on the box, not the padding:

```tsx
      <InputGroup className={cn(dragging && 'ring-2 ring-ring')}>
```

Add `onPaste` to `InputGroupTextarea`:

```tsx
          onPaste={(e) => {
            // Only claim the paste when it carries files. A normal text paste
            // must fall through untouched, and a screenshot arrives as a File
            // with an empty `text/plain`.
            const files = e.clipboardData?.files;
            if (!files || files.length === 0) { return; }
            e.preventDefault();
            attachFiles(files);
          }}
```

Add the button, first in the block-end row before the `/` trigger (line 316):

```tsx
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Attach files"
            title="Attach files"
            disabled={readOnly}
            aria-describedby={readOnly ? unavailableReasonId : undefined}
            onClick={() => post({ t: 'attach-pick', id: pane.summary.id })}
          >
            <Paperclip />
          </Button>
```

Update the textarea placeholder to announce the third input, keeping it short enough for 300px:

```tsx
          placeholder="Message the agent… @ references a session, paste or drop files"
```

- [ ] **Step 5: Swap the editor-context glyph**

In `src/webview/components/editor-context-toggle.tsx`, change line 1 to `import { FileCode2 } from 'lucide-react';` and line 47 to `<FileCode2 aria-hidden="true" />`. Add one line to that component's doc comment:

```
 * The glyph is a file, not a paperclip: this names the file the user is
 * looking at, and the paperclip belongs to the attach control beside it.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test:dom && yarn test:unit`
Expected: PASS.

- [ ] **Step 7: Run the UI detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/composer.tsx src/webview/components/editor-context-toggle.tsx`
Expected: exit 0.

- [ ] **Step 8: Verify and commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/webview/ src/test/
git commit -m "feat: attach files by button, paste and drop"
```

---

### Task 8: Transcript record and the merge gate

A sent turn shows what it carried, and the branch is ready to merge.

**Files:**
- Modify: `src/webview/components/transcript-item.tsx` (render `attachments` on a user item)
- Test: a case in `src/test/dom/attachments.test.tsx`

**Interfaces:**
- Consumes: `TranscriptItem.attachments` (Task 2); `AttachmentChips`'s chip styling (Task 6) — extract the chip into a shared `AttachmentChip` if reusing it here means duplicating markup.

- [ ] **Step 1: Write the failing test**

```tsx
  test("a sent user message lists what it carried", () => {
    renderApp();
    sendFromHost({
      t: "hydrate",
      sessions: [summary("a")],
      layout: layoutOf("a"),
      snapshots: [{
        ...snapshot("a"),
        items: [{
          id: "u1", ts: 1, role: "user", text: "look at this",
          attachments: [att({ name: "shot.png" })],
        }],
      }],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.strictEqual(screen.getByText("shot.png") !== null, true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — "shot.png" is not in the document.

- [ ] **Step 3: Render them**

In `src/webview/components/transcript-item.tsx`, in the user arm — beside where `refs` and `context` already render — add a read-only row of chips (no remove button; a sent turn is a record, not a draft). Reuse the chip markup by extracting `AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void })` from `attachment-chips.tsx` and rendering it with `onRemove` omitted here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Run the detector and the critique**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/transcript-item.tsx src/webview/components/attachment-chips.tsx
```
Expected: exit 0.

Then run `critique` over `src/webview` and compare against the previous run in `.impeccable/critique/`. The score is expected to go up, never down. If it dropped, fix what the critique names before merging.

- [ ] **Step 6: Full gate**

```bash
yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom
```
Expected: all pass, no skips.

- [ ] **Step 7: Manual verification in a real window**

Press F5 to launch the extension host. In the panel: paste a screenshot (chip with the name appears), drag a file from the Explorer onto the composer (chip appears, ring shows during the drag), click the paperclip and pick a file outside the workspace (chip appears), remove one (chip goes), then send and confirm the agent describes the image. Repeat once on a Codex session and once on a Claude session — this is the only step that proves the provider payloads against a live backend.

- [ ] **Step 8: Commit**

```bash
git add src/webview/
git commit -m "feat: sent turns show the files they carried"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the `Attachment` type and store → Task 1; pending-set ownership (Decision 3) → Task 2; provider interface widening (Decision 6) and Claude rendering (Decision 5) → Task 3; Codex rendering plus the `wire.ts`/`imageView` gaps → Task 4; host minting (Decision 2), out-of-workspace paths (Decision 4), the router seam and the error table → Task 5; chips, the reducer and rejection copy → Task 6; the three input paths and the glyph swap (Decision 7) → Task 7; the transcript record and the merge gate → Task 8. The spec's Deferred list is implemented by no task, deliberately.

**Known ordering hazard.** Task 2 writes a call to `run.send`'s third parameter, which Task 3 Step 1 declares. Task 2 Step 4 says so explicitly and tells the implementer to pull that one signature change forward so the commit gate passes.

**Type consistency.** `Attachment` is declared once, in `src/providers/types.ts`, and re-exported from `messages.ts` (Task 3 Step 1 corrects Task 1's initial placement — follow it). `pendingAttachments` is the host/snapshot name; `attachments` is the `PaneState` and `TranscriptItem` name; `attach-paste` / `attach-pick` / `attach-drop` / `attach-remove` inbound, `session-attachments` / `attachments-rejected` outbound. `MAX_PENDING` and `MAX_ATTACHMENT_BYTES` are exported from `attachment-store.ts` and imported wherever a cap is enforced — no second literal.
