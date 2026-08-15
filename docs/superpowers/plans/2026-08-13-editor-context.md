# Editor Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages sent from the panel carry the file the user is looking at, and the lines they have selected, with a per-session toggle to suppress it.

**Architecture:** The extension host owns the context. A pure builder turns a plain editor snapshot into an `EditorContext`; a tracker holds the latest one and survives the webview stealing editor focus; the router attaches it on `send` when the session's toggle is on. Providers own formatting. The webview receives the context only to render a chip.

**Tech Stack:** TypeScript, esbuild, React 19, Tailwind v4, shadcn (Base UI), mocha (`--ui tdd`), `@vscode/test-cli`.

**Spec:** [docs/superpowers/specs/2026-08-13-editor-context-design.md](../specs/2026-08-13-editor-context-design.md)

**Baseline:** every quoted snippet and line number in this plan was verified against `0c32be9` ("Feat/webview ux overhaul"). The webview moved substantially in that merge — `InputGroup` in the composer, `TranscriptItemShell` around every item, `useIsNarrow` in `App` — so if HEAD has moved again, re-read each file before applying its step and trust the file over this document.

## Global Constraints

Everything in the agent-manager plan's Global Constraints still applies. The ones this plan touches directly:

- **Filenames are kebab-case**, including React components. Component *identifiers* stay PascalCase.
- **`src/protocol/messages.ts` is types-only.** No runtime code, no `import ... from 'vscode'`.
- **No module under `src/providers/` or `src/protocol/` may import `vscode`.** `EditorContext` lives in `src/providers/types.ts`, so it must stay a plain data type.
- **`src/host/message-router.ts` must not import `vscode`.** It has unit tests that run outside the extension host; anything needing the VS Code API arrives through an injected interface.
- **Use shadcn components, never raw HTML controls.** The toggle is a `Button` from `@/components/ui/button`.
- **Use the short Tailwind utilities** — `text-muted-foreground`, `bg-muted`. No `[var(--…)]` arbitrary values.
- **Every protocol message addressed to a session carries an explicit `SessionId`.** `reveal-file` and `editor-context` are deliberately *not* session-addressed — they are global IDE state.
- **Errors are state, never exceptions across `postMessage`.**
- **Selection budget is 8000 characters**, defined once as `SELECTION_BUDGET` in `src/host/editor-context.ts`.
- **Line numbers on the wire are 1-based and inclusive** (what the editor gutter shows). VS Code's own `Position.line` is 0-based — convert at the adapter boundary and nowhere else.
- **Commit after every task.** Conventional-commit prefixes.

---

## File Structure

| Path | Responsibility | Status |
|---|---|---|
| `src/providers/types.ts` | `EditorContext` type; `AgentRun.send` gains an optional context arg | modify |
| `src/providers/format-editor-context.ts` | `EditorContext` → the prompt block every provider sends | create |
| `src/providers/fake/fake-provider.ts` | Record sent `(text, context)` pairs for assertions | modify |
| `src/providers/claude/claude-provider.ts` | Prepend the formatted block to the user turn | modify |
| `src/host/editor-context.ts` | `EditorSnapshot` → `EditorContext`: filter, merge, budget, relativize. Pure. | create |
| `src/host/editor-context-tracker.ts` | Holds the latest context; ignores focus loss; emits changes | create |
| `src/host/vscode-editor-source.ts` | The only file that turns real `vscode` editors into `EditorSnapshot` | create |
| `src/protocol/messages.ts` | `context` on user items, `includeEditorContext` on state, three new messages | modify |
| `src/host/agent-session.ts` | Store context on the user item; forward to the run; toggle setter | modify |
| `src/host/session-manager.ts` | Default the toggle on create and on restore | modify |
| `src/host/message-router.ts` | Attach context on `send`; handle the toggle and `reveal-file` | modify |
| `src/host/panel-view-provider.ts` | Pass the editor host into the router | modify |
| `src/extension.ts` | Build the source + tracker, push changes, implement `reveal` | modify |
| `src/webview/reducer.ts` | `editorContext` in client state | modify |
| `src/webview/components/editor-context-chip.tsx` | `chipLabel()`, the label, and the transcript chip | create |
| `src/webview/components/editor-context-toggle.tsx` | The composer control: attach on/off, container-responsive | create |
| `src/webview/components/composer.tsx` | Mount the toggle in the controls row; make the root a container | modify |
| `src/webview/components/transcript-item.tsx` | Chip above a user message that carried context | modify |

---

## Task Order

Strictly serial. Every task depends on the one before it, and several tasks touch the same files.

```
T1 (type + builder) → T2 (formatter + provider seam) → T3 (tracker + adapter)
   → T4 (protocol + session + manager) → T5 (router + wiring)
   → T6 (webview + manual verify) → T7 (critique before merge)
```

The UI in T6 was shaped through the `impeccable` skill before this plan was
revised; `PRODUCT.md` holds the product truth it was shaped against, and the
design brief sits at the head of that task. T6 ends with the mechanical
detector and T7 with the critique — both are gates, not suggestions.

---

## Task 1: EditorContext type and the pure builder

**Files:**
- Modify: `src/providers/types.ts`
- Create: `src/host/editor-context.ts`
- Test: `src/test/unit/editor-context.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EditorContext` (from `src/providers/types.ts`): `{ path: string; languageId: string; selection?: { ranges: { startLine: number; endLine: number; text: string }[]; truncated: boolean } }`
  - `EditorSnapshot` (from `src/host/editor-context.ts`): `{ fsPath: string; scheme: string; languageId: string; ranges: { startLine: number; endLine: number; text: string }[] }`
  - `toEditorContext(snap: EditorSnapshot, workspaceRoots: string[]): EditorContext | null`
  - `SELECTION_BUDGET: number`

- [ ] **Step 1: Add the `EditorContext` type**

Append to `src/providers/types.ts`, after `ModelInfo`:

```ts
/**
 * What the user is looking at in the editor when they hit send. Carries the
 * file reference always, and the selected text only when there is a
 * selection — the model has file-reading tools, so inlining a whole file on
 * every message would spend tokens on what it can fetch on demand.
 */
export interface EditorContext {
  /** Workspace-relative when inside an open folder, absolute otherwise. POSIX separators. */
  path: string;
  languageId: string;
  /** Absent when nothing is selected. */
  selection?: {
    /**
     * 1-based inclusive line numbers, sorted, non-overlapping. An array from
     * day one: multi-cursor selections are ordinary, and transcript items
     * persist to disk, so widening a scalar pair later would need a tolerant
     * reader for already-written history.
     */
    ranges: { startLine: number; endLine: number; text: string }[];
    /** True when text was cut or whole ranges dropped to fit the budget. */
    truncated: boolean;
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `src/test/unit/editor-context.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import {
  SELECTION_BUDGET, toEditorContext, type EditorSnapshot,
} from '../../host/editor-context';

const ROOT = path.resolve('/work/repo');

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    fsPath: path.join(ROOT, 'src', 'a.ts'),
    scheme: 'file',
    languageId: 'typescript',
    ranges: [],
    ...over,
  };
}

suite('toEditorContext', () => {
  test('a non-file scheme produces no context', () => {
    assert.strictEqual(toEditorContext(snap({ scheme: 'untitled' }), [ROOT]), null);
    assert.strictEqual(toEditorContext(snap({ scheme: 'output' }), [ROOT]), null);
  });

  test('no selection yields a file reference with no selection field', () => {
    const ctx = toEditorContext(snap(), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, 'src/a.ts');
    assert.strictEqual(ctx.languageId, 'typescript');
    assert.strictEqual(ctx.selection, undefined);
  });

  test('empty ranges are dropped, leaving a file reference', () => {
    const ctx = toEditorContext(snap({
      ranges: [{ startLine: 4, endLine: 4, text: '' }],
    }), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.selection, undefined);
  });

  test('a path outside every workspace root stays absolute', () => {
    const outside = path.resolve('/elsewhere/b.ts');
    const ctx = toEditorContext(snap({ fsPath: outside }), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, outside.replace(/\\/g, '/'));
  });

  test('the longest matching root wins', () => {
    const nested = path.resolve('/work/repo/packages/app');
    const ctx = toEditorContext(snap({
      fsPath: path.join(nested, 'src', 'a.ts'),
    }), [ROOT, nested]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, 'src/a.ts');
  });

  test('ranges are sorted by start line', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 40, endLine: 41, text: 'later' },
        { startLine: 10, endLine: 11, text: 'earlier' },
      ],
    }), [ROOT]);
    assert.deepStrictEqual(ctx?.selection?.ranges, [
      { startLine: 10, endLine: 11, text: 'earlier' },
      { startLine: 40, endLine: 41, text: 'later' },
    ]);
    assert.strictEqual(ctx?.selection?.truncated, false);
  });

  test('adjacent and overlapping ranges merge into one', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 10, endLine: 12, text: 'a' },
        { startLine: 13, endLine: 14, text: 'b' },
        { startLine: 30, endLine: 30, text: 'c' },
      ],
    }), [ROOT]);
    assert.deepStrictEqual(ctx?.selection?.ranges, [
      { startLine: 10, endLine: 14, text: 'a\nb' },
      { startLine: 30, endLine: 30, text: 'c' },
    ]);
  });

  test('a range past the budget is cut and its end line recomputed', () => {
    const big = 'x'.repeat(SELECTION_BUDGET + 500);
    const ctx = toEditorContext(snap({
      ranges: [{ startLine: 1, endLine: 900, text: big }],
    }), [ROOT]);
    assert.strictEqual(ctx?.selection?.ranges.length, 1);
    assert.strictEqual(ctx?.selection?.ranges[0].text.length, SELECTION_BUDGET);
    assert.strictEqual(ctx?.selection?.ranges[0].endLine, 1);
    assert.strictEqual(ctx?.selection?.truncated, true);
  });

  test('ranges past the budget are dropped, earlier ones kept whole', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 1, endLine: 2, text: 'y'.repeat(SELECTION_BUDGET) },
        { startLine: 50, endLine: 51, text: 'dropped' },
      ],
    }), [ROOT]);
    assert.strictEqual(ctx?.selection?.ranges.length, 1);
    assert.strictEqual(ctx?.selection?.ranges[0].startLine, 1);
    assert.strictEqual(ctx?.selection?.truncated, true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../host/editor-context'`.

- [ ] **Step 4: Write the builder**

Create `src/host/editor-context.ts`:

```ts
import * as path from 'node:path';
import type { EditorContext } from '../providers/types';

/** Total selected characters carried in one message. A guess; one constant to tune. */
export const SELECTION_BUDGET = 8000;

type Range = { startLine: number; endLine: number; text: string };

/**
 * A plain-data view of an editor. `src/host/vscode-editor-source.ts` is the
 * only place that builds one from the real VS Code API, which keeps
 * everything below unit-testable outside the extension host.
 *
 * `ranges` are 1-based inclusive and may arrive unsorted, empty, or
 * overlapping — normalizing them is this module's job.
 */
export interface EditorSnapshot {
  fsPath: string;
  scheme: string;
  languageId: string;
  ranges: Range[];
}

export function toEditorContext(
  snap: EditorSnapshot, workspaceRoots: string[],
): EditorContext | null {
  // Only real files. Output channels, webviews, untitled buffers and virtual
  // documents have no path worth sending.
  if (snap.scheme !== 'file') { return null; }

  const base: EditorContext = {
    path: displayPath(snap.fsPath, workspaceRoots),
    languageId: snap.languageId,
  };

  const merged = mergeRanges(snap.ranges.filter((r) => r.text.length > 0));
  if (merged.length === 0) { return base; }

  const { ranges, truncated } = applyBudget(merged);
  if (ranges.length === 0) { return base; }
  return { ...base, selection: { ranges, truncated } };
}

/**
 * Workspace-relative when the file sits under an open folder, absolute
 * otherwise. The longest matching root wins so a nested folder in a
 * multi-root workspace produces the shorter, more useful path.
 */
function displayPath(fsPath: string, workspaceRoots: string[]): string {
  const candidates = workspaceRoots
    .filter((root) => isInside(root, fsPath))
    .sort((a, b) => b.length - a.length);
  const root = candidates[0];
  const chosen = root ? path.relative(root, fsPath) : fsPath;
  return chosen.split(path.sep).join('/');
}

function isInside(root: string, fsPath: string): boolean {
  const rel = path.relative(root, fsPath);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * VS Code never hands out overlapping selections (it collapses multi-cursor
 * selections that touch), so merging is really about *adjacent* ranges —
 * two selections covering lines 10-12 and 13-14 read better as one block.
 * Overlap is handled anyway rather than trusting that invariant.
 */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const out: Range[] = [];
  for (const range of sorted) {
    const prev = out[out.length - 1];
    if (prev && range.startLine <= prev.endLine + 1) {
      out[out.length - 1] = {
        startLine: prev.startLine,
        endLine: Math.max(prev.endLine, range.endLine),
        text: `${prev.text}\n${range.text}`,
      };
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

/**
 * Fill ranges in document order until the budget runs out. A range that
 * doesn't fit is cut at the boundary (and its end line recomputed, so the
 * label never claims lines that aren't in the text); everything after it is
 * dropped. Either way `truncated` tells the model it is reading a partial
 * view.
 */
function applyBudget(ranges: Range[]): { ranges: Range[]; truncated: boolean } {
  const out: Range[] = [];
  let used = 0;
  for (const range of ranges) {
    const remaining = SELECTION_BUDGET - used;
    if (remaining <= 0) { return { ranges: out, truncated: true }; }
    if (range.text.length <= remaining) {
      out.push(range);
      used += range.text.length;
      continue;
    }
    const text = range.text.slice(0, remaining);
    out.push({
      startLine: range.startLine,
      endLine: range.startLine + countNewlines(text),
      text,
    });
    return { ranges: out, truncated: true };
  }
  return { ranges: out, truncated: false };
}

function countNewlines(text: string): number {
  let n = 0;
  for (const ch of text) { if (ch === '\n') { n++; } }
  return n;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, including every previously existing suite.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/host/editor-context.ts src/test/unit/editor-context.test.ts
git commit -m "feat: build an editor context from an editor snapshot"
```

---

## Task 2: The prompt block and the provider seam

**Files:**
- Create: `src/providers/format-editor-context.ts`
- Modify: `src/providers/types.ts` (the `AgentRun.send` signature)
- Modify: `src/providers/fake/fake-provider.ts`
- Modify: `src/providers/claude/claude-provider.ts:292-299`
- Test: `src/test/unit/format-editor-context.test.ts`, `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: `EditorContext` from Task 1.
- Produces:
  - `formatEditorContext(ctx: EditorContext): string`
  - `AgentRun.send(text: string, context?: EditorContext): void`
  - `FakeProvider.sent: { text: string; context?: EditorContext }[]`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/format-editor-context.test.ts`:

```ts
import * as assert from 'assert';
import { formatEditorContext } from '../../providers/format-editor-context';

suite('formatEditorContext', () => {
  test('no selection renders a self-closing reference', () => {
    const out = formatEditorContext({ path: 'src/a.ts', languageId: 'typescript' });
    assert.strictEqual(out, '<editor-context path="src/a.ts" language="typescript" />');
  });

  test('one range renders a body', () => {
    const out = formatEditorContext({
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [{ startLine: 60, endLine: 61, text: 'const a = 1;\nconst b = 2;' }],
        truncated: false,
      },
    });
    assert.strictEqual(out, [
      '<editor-context path="src/a.ts" language="typescript">',
      '<range lines="60-61">',
      'const a = 1;',
      'const b = 2;',
      '</range>',
      '</editor-context>',
    ].join('\n'));
  });

  test('several ranges and truncation are both visible to the model', () => {
    const out = formatEditorContext({
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [
          { startLine: 1, endLine: 1, text: 'one' },
          { startLine: 9, endLine: 9, text: 'two' },
        ],
        truncated: true,
      },
    });
    assert.ok(out.startsWith('<editor-context path="src/a.ts" language="typescript" truncated="true">'));
    assert.ok(out.includes('<range lines="1-1">\none\n</range>'));
    assert.ok(out.includes('<range lines="9-9">\ntwo\n</range>'));
  });

  test('quotes and angle brackets in a path cannot break out of the attribute', () => {
    const out = formatEditorContext({ path: 'a"><b.ts', languageId: 'plaintext' });
    assert.ok(!out.includes('a"><b.ts'));
    assert.ok(out.includes('a&quot;&gt;&lt;b.ts'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../providers/format-editor-context'`.

- [ ] **Step 3: Write the formatter**

Create `src/providers/format-editor-context.ts`:

```ts
import type { EditorContext } from './types';

/**
 * The one rendering of an editor context that goes to a model. Providers
 * share it so a prompt looks the same whichever agent is behind the session.
 *
 * XML-ish rather than a fenced code block: fences collide with fences inside
 * the selected text, and attributes carry the line numbers without a
 * convention the model has to infer.
 */
export function formatEditorContext(ctx: EditorContext): string {
  const head = `<editor-context path="${escapeAttr(ctx.path)}"`
    + ` language="${escapeAttr(ctx.languageId)}"`;

  if (!ctx.selection) { return `${head} />`; }

  const truncated = ctx.selection.truncated ? ' truncated="true"' : '';
  const body = ctx.selection.ranges
    .map((r) => `<range lines="${r.startLine}-${r.endLine}">\n${r.text}\n</range>`)
    .join('\n');
  return `${head}${truncated}>\n${body}\n</editor-context>`;
}

/**
 * A path is not trusted input for this purpose — a filename may legally
 * contain a quote or an angle bracket, which would otherwise close the
 * attribute early and hand the model a malformed, confusing block.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Widen the `AgentRun.send` signature**

In `src/providers/types.ts`, change the first line of the `AgentRun` interface body — that one line only:

```ts
  send(text: string, context?: EditorContext): void;
```

`AgentRun` also declares `setModel` alongside `setEffort`; do not retype the interface from memory or you will drop it. The new parameter is optional, so every existing caller and both existing providers still typecheck.

- [ ] **Step 5: Record sends in `FakeProvider`**

In `src/providers/fake/fake-provider.ts`, add the field next to `decisions`:

```ts
  /** Records every (text, context) pair passed to send, for assertions. */
  readonly sent: { text: string; context?: EditorContext }[] = [];
```

and change the returned `send` (around line 74) to:

```ts
      send: (text: string, context?: EditorContext) => {
        this.sent.push({ text, context });
        if (!started) {
          started = true;
          channel.push({ kind: 'session', resumeToken });
        }
        for (const ev of this.script(text)) { channel.push(ev); }
      },
```

Add `EditorContext` to the existing `import type { ... } from '../types';` list at the top of the file.

- [ ] **Step 6: Add the FakeProvider test**

Append to `src/test/unit/fake-provider.test.ts`, inside its existing top-level `suite`:

```ts
  test('send records the text and context it was given', () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('plain');
    run.send('with ctx', { path: 'src/a.ts', languageId: 'typescript' });
    assert.deepStrictEqual(provider.sent, [
      { text: 'plain', context: undefined },
      { text: 'with ctx', context: { path: 'src/a.ts', languageId: 'typescript' } },
    ]);
  });
```

- [ ] **Step 7: Prepend the block in `ClaudeProvider`**

In `src/providers/claude/claude-provider.ts`, replace the returned `send` (around line 292) with the version below. **Keep the `ensureStarted()` call** — the provider now constructs its query lazily, on the first send, and dropping that line breaks every session:

```ts
      send: (text: string, context?: EditorContext) => {
        ensureStarted();
        // One text block rather than two: the SDK accepts an array, but a
        // single block keeps the turn's shape identical whether or not
        // context is attached, so nothing downstream has to special-case it.
        const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
        prompts.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: body }] },
          parent_tool_use_id: null,
        });
      },
```

Add the import beside the existing `mapEvent` import:

```ts
import { formatEditorContext } from '../format-editor-context';
```

and add `EditorContext` to the existing `import type { ... } from '../types';` list.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

Run: `yarn check-types`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/providers src/test/unit/format-editor-context.test.ts src/test/unit/fake-provider.test.ts
git commit -m "feat: format editor context into the provider prompt"
```

---

## Task 3: The tracker and the VS Code adapter

**Files:**
- Create: `src/host/editor-context-tracker.ts`
- Create: `src/host/vscode-editor-source.ts`
- Test: `src/test/unit/editor-context-tracker.test.ts`

**Interfaces:**
- Consumes: `toEditorContext`, `EditorSnapshot` from Task 1.
- Produces:
  - `EditorSource` — `{ onDidChangeEditor(cb): Disposable; onDidCloseDocument(cb): Disposable; workspaceRoots(): string[] }`
  - `EditorContextTracker` — `new (source: EditorSource)`, `.current: EditorContext | null`, `.onChange(cb): Disposable`, `.dispose(): void`
  - `createVscodeEditorSource(): EditorSource & { dispose(): void }`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/editor-context-tracker.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import { EditorContextTracker, type EditorSource } from '../../host/editor-context-tracker';
import type { EditorSnapshot } from '../../host/editor-context';
import type { EditorContext } from '../../providers/types';

const ROOT = path.resolve('/work/repo');

class FakeSource implements EditorSource {
  private editorCb: ((snap: EditorSnapshot | null) => void) | undefined;
  private closeCb: ((fsPath: string) => void) | undefined;

  onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void) {
    this.editorCb = cb;
    return { dispose: () => { this.editorCb = undefined; } };
  }

  onDidCloseDocument(cb: (fsPath: string) => void) {
    this.closeCb = cb;
    return { dispose: () => { this.closeCb = undefined; } };
  }

  workspaceRoots(): string[] { return [ROOT]; }

  emitEditor(snap: EditorSnapshot | null): void { this.editorCb?.(snap); }
  emitClose(fsPath: string): void { this.closeCb?.(fsPath); }
}

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    fsPath: path.join(ROOT, 'src', 'a.ts'),
    scheme: 'file',
    languageId: 'typescript',
    ranges: [],
    ...over,
  };
}

suite('EditorContextTracker', () => {
  let source: FakeSource;
  let tracker: EditorContextTracker;
  let seen: (EditorContext | null)[];

  setup(() => {
    source = new FakeSource();
    tracker = new EditorContextTracker(source);
    seen = [];
    tracker.onChange((ctx) => seen.push(ctx));
  });

  teardown(() => { tracker.dispose(); });

  test('starts empty', () => {
    assert.strictEqual(tracker.current, null);
  });

  test('a file editor becomes the current context', () => {
    source.emitEditor(snap());
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('losing the active editor keeps the last context', () => {
    source.emitEditor(snap());
    // This is what the panel webview taking focus looks like: VS Code reports
    // activeTextEditor as undefined. Dropping the context here would break the
    // feature exactly when the user is typing into the composer.
    source.emitEditor(null);
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('a non-file editor is ignored rather than clearing', () => {
    source.emitEditor(snap());
    source.emitEditor(snap({ scheme: 'output', fsPath: 'extension-output' }));
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('an identical snapshot does not re-notify', () => {
    source.emitEditor(snap());
    source.emitEditor(snap());
    assert.strictEqual(seen.length, 1);
  });

  test('a selection change notifies with the new ranges', () => {
    source.emitEditor(snap());
    source.emitEditor(snap({ ranges: [{ startLine: 3, endLine: 4, text: 'hi' }] }));
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(tracker.current?.selection?.ranges, [
      { startLine: 3, endLine: 4, text: 'hi' },
    ]);
  });

  test('closing the tracked document clears the context', () => {
    source.emitEditor(snap());
    source.emitClose(path.join(ROOT, 'src', 'a.ts'));
    assert.strictEqual(tracker.current, null);
    assert.deepStrictEqual(seen[seen.length - 1], null);
  });

  test('closing an unrelated document leaves the context alone', () => {
    source.emitEditor(snap());
    source.emitClose(path.join(ROOT, 'src', 'other.ts'));
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
  });

  test('dispose stops delivery', () => {
    tracker.dispose();
    source.emitEditor(snap());
    assert.strictEqual(seen.length, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `Cannot find module '../../host/editor-context-tracker'`.

- [ ] **Step 3: Write the tracker**

Create `src/host/editor-context-tracker.ts`:

```ts
import { toEditorContext, type EditorSnapshot } from './editor-context';
import type { EditorContext } from '../providers/types';

export interface Disposable { dispose(): void }

/**
 * Where editor state comes from. `src/host/vscode-editor-source.ts` is the
 * real implementation; tests pass a fake, which is the whole reason this
 * interface exists — nothing here may import `vscode`.
 */
export interface EditorSource {
  /** Fires with the active editor, or null when there is none. */
  onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable;
  onDidCloseDocument(cb: (fsPath: string) => void): Disposable;
  workspaceRoots(): string[];
}

/**
 * Holds the editor context that a message will carry.
 *
 * The load-bearing behavior: `vscode.window.activeTextEditor` goes
 * `undefined` while the panel webview holds focus, and the user must focus
 * the composer to type. A live read at send time would therefore return
 * nothing exactly when it matters. So `null` and non-file editors are
 * treated as "no news" and the last valid value is kept. Only closing the
 * tracked document clears it.
 */
export class EditorContextTracker {
  private _current: EditorContext | null = null;
  private trackedPath: string | null = null;
  private readonly listeners = new Set<(ctx: EditorContext | null) => void>();
  private readonly subs: Disposable[] = [];
  private disposed = false;

  constructor(private readonly source: EditorSource) {
    this.subs.push(source.onDidChangeEditor((snap) => this.observe(snap)));
    this.subs.push(source.onDidCloseDocument((fsPath) => this.onClose(fsPath)));
  }

  get current(): EditorContext | null { return this._current; }

  onChange(cb: (ctx: EditorContext | null) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const sub of this.subs) { sub.dispose(); }
    this.subs.length = 0;
    this.listeners.clear();
  }

  private observe(snap: EditorSnapshot | null): void {
    if (this.disposed || !snap) { return; }
    const next = toEditorContext(snap, this.source.workspaceRoots());
    if (!next) { return; }
    this.trackedPath = snap.fsPath;
    this.set(next);
  }

  private onClose(fsPath: string): void {
    if (this.disposed || this.trackedPath !== fsPath) { return; }
    this.trackedPath = null;
    this.set(null);
  }

  /**
   * Structural equality via JSON: a bare cursor move produces a byte-identical
   * file-reference context, and selection events fire on every keystroke.
   * Without this the webview would be re-rendered for no visible change.
   */
  private set(next: EditorContext | null): void {
    if (JSON.stringify(next) === JSON.stringify(this._current)) { return; }
    this._current = next;
    for (const cb of this.listeners) { cb(next); }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Write the VS Code adapter**

Create `src/host/vscode-editor-source.ts`. This is the only file that touches the real editor API, so it stays thin enough to verify by eye and by the manual check in Task 6:

```ts
import * as vscode from 'vscode';
import type { EditorSnapshot } from './editor-context';
import type { Disposable, EditorSource } from './editor-context-tracker';

/**
 * The real `EditorSource`. The 0-based-to-1-based line conversion happens
 * here and nowhere else: everything above this boundary speaks the numbers
 * the editor gutter shows.
 */
export function createVscodeEditorSource(): EditorSource & { dispose(): void } {
  const subs: vscode.Disposable[] = [];

  /**
   * Each subscribe call returns a disposable that releases exactly the
   * subscriptions that call created. Returning a no-op and relying on the
   * aggregate `dispose()` below would mean `EditorContextTracker.dispose()`
   * silently unsubscribes nothing — the vscode listeners would keep firing
   * for the life of the extension, holding the tracker and its closures
   * alive. A disposable that does not unsubscribe is a lie about ownership.
   */
  const track = (...added: vscode.Disposable[]): Disposable => {
    subs.push(...added);
    return {
      dispose: () => {
        for (const sub of added) {
          sub.dispose();
          const i = subs.indexOf(sub);
          if (i >= 0) { subs.splice(i, 1); }
        }
      },
    };
  };

  return {
    onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable {
      const emit = (editor: vscode.TextEditor | undefined) => {
        cb(editor ? snapshot(editor) : null);
      };
      const disposable = track(
        vscode.window.onDidChangeActiveTextEditor(emit),
        vscode.window.onDidChangeTextEditorSelection((e) => emit(e.textEditor)),
      );
      // Seed from whatever is already open at activation, so the first
      // message of a session carries context without the user touching
      // anything.
      emit(vscode.window.activeTextEditor);
      return disposable;
    },

    onDidCloseDocument(cb: (fsPath: string) => void): Disposable {
      return track(vscode.workspace.onDidCloseTextDocument((doc) => cb(doc.uri.fsPath)));
    },

    workspaceRoots(): string[] {
      return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    },

    dispose(): void {
      for (const sub of subs) { sub.dispose(); }
      subs.length = 0;
    },
  };
}

function snapshot(editor: vscode.TextEditor): EditorSnapshot {
  return {
    fsPath: editor.document.uri.fsPath,
    scheme: editor.document.uri.scheme,
    languageId: editor.document.languageId,
    ranges: editor.selections
      .filter((sel) => !sel.isEmpty)
      .map((sel) => ({
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: editor.document.getText(sel),
      })),
  };
}
```

- [ ] **Step 6: Verify types and lint**

Run: `yarn check-types && yarn lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/host/editor-context-tracker.ts src/host/vscode-editor-source.ts src/test/unit/editor-context-tracker.test.ts
git commit -m "feat: track the active editor across webview focus loss"
```

---

## Task 4: Protocol, session, and the persisted toggle

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/host/agent-session.ts:60-73`
- Modify: `src/host/session-manager.ts:60-66,97-103`
- Test: `src/test/unit/protocol.test.ts`, `src/test/unit/agent-session.test.ts`, `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `EditorContext` from Task 1.
- Produces:
  - `TranscriptItem` user variant: `{ role: 'user'; text: string; context?: EditorContext }`
  - `SessionState.includeEditorContext: boolean`
  - `WebviewToHost`: `{ t: 'set-include-context'; id: SessionId; on: boolean }`, `{ t: 'reveal-file'; path: string; startLine?: number }`
  - `HostToWebview`: `{ t: 'editor-context'; ctx: EditorContext | null }`
  - `AgentSession.send(text: string, context?: EditorContext): void`
  - `AgentSession.setIncludeEditorContext(on: boolean): void`

- [ ] **Step 1: Extend the protocol**

In `src/protocol/messages.ts`:

Add `EditorContext` to the existing import and re-export:

```ts
import type {
  EditorContext, EffortLevel, ModelInfo, PermissionMode, ToolDecision,
} from '../providers/types';

export type { EditorContext, EffortLevel, ModelInfo, PermissionMode, ToolDecision };
```

Change the `user` member of `TranscriptItem`:

```ts
  | (ItemBase & { role: 'user'; text: string; context?: EditorContext })
```

Add to `SessionState`, after `permissionMode`:

```ts
  /** Whether sends from this session attach the editor context. Sticky. */
  includeEditorContext: boolean;
```

Add to `WebviewToHost`, after `set-permission-mode`:

```ts
  | { t: 'set-include-context'; id: SessionId; on: boolean }
  /** Not session-addressed: opening a file is global IDE state, not session state. */
  | { t: 'reveal-file'; path: string; startLine?: number }
```

Add to `HostToWebview`, after `sessions-changed`:

```ts
  /** Broadcast, not session-addressed: every composer shows the same editor. */
  | { t: 'editor-context'; ctx: EditorContext | null };
```

(remember to move the `;` off `sessions-changed`)

- [ ] **Step 2: Add the protocol type test**

Append to `src/test/unit/protocol.test.ts`, inside its existing top-level `suite`:

```ts
  test('the new editor-context messages are part of the unions', () => {
    const toHost: WebviewToHost[] = [
      { t: 'set-include-context', id: 's1', on: false },
      { t: 'reveal-file', path: 'src/a.ts', startLine: 12 },
      { t: 'reveal-file', path: 'src/a.ts' },
    ];
    const toWebview: HostToWebview[] = [
      { t: 'editor-context', ctx: null },
      { t: 'editor-context', ctx: { path: 'src/a.ts', languageId: 'typescript' } },
    ];
    assert.strictEqual(toHost.length, 3);
    assert.strictEqual(toWebview.length, 2);
  });

  test('a user item can carry an editor context', () => {
    const item: TranscriptItem = {
      id: 'u1', ts: 1, role: 'user', text: 'hi',
      context: {
        path: 'src/a.ts',
        languageId: 'typescript',
        selection: {
          ranges: [{ startLine: 1, endLine: 2, text: 'x' }],
          truncated: false,
        },
      },
    };
    assert.strictEqual(item.role, 'user');
  });
```

Make sure `WebviewToHost`, `HostToWebview` and `TranscriptItem` are in that file's import list.

- [ ] **Step 3: Write the failing AgentSession test**

Append to `src/test/unit/agent-session.test.ts`, inside its existing top-level `suite` (it already builds sessions over a `FakeProvider` — follow whatever helper that file uses to construct one; the assertions are what matter):

```ts
  test('send stores the context on the user item and forwards it to the run', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = makeSession(provider);
    const ctx = {
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 1, endLine: 2, text: 'x' }], truncated: false },
    };

    session.send('look at this', ctx);
    await settle();

    assert.deepStrictEqual(provider.sent[0], { text: 'look at this', context: ctx });
    const snapshot = await session.snapshot();
    const user = snapshot.items.find((i) => i.role === 'user');
    assert.ok(user && user.role === 'user');
    assert.deepStrictEqual(user.context, ctx);
  });

  test('send without a context leaves the user item unchanged', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = makeSession(provider);

    session.send('plain');
    await settle();

    const snapshot = await session.snapshot();
    const user = snapshot.items.find((i) => i.role === 'user');
    assert.ok(user && user.role === 'user');
    // Persisted transcripts written before this feature have no `context`;
    // a send with none must produce exactly that shape, not `context: null`.
    assert.strictEqual('context' in user, false);
  });

  test('setIncludeEditorContext flips the persisted flag', () => {
    const session = makeSession(new FakeProvider(() => []));
    assert.strictEqual(session.state.includeEditorContext, true);
    session.setIncludeEditorContext(false);
    assert.strictEqual(session.state.includeEditorContext, false);
  });
```

If that file has no `makeSession` helper, build the session the same way its existing tests do (a `SessionState` literal plus `new AgentSession(state, provider, store, sink)`), and add `includeEditorContext: true` to every `SessionState` literal in the file — the field is required, so the file will not compile without it.

- [ ] **Step 4: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — `session.send` rejects a second argument / `setIncludeEditorContext is not a function`.

- [ ] **Step 5: Implement in `AgentSession`**

In `src/host/agent-session.ts`, replace `send` (lines 60-73):

```ts
  send(text: string, context?: EditorContext): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    // Spread the context in only when there is one: a persisted user item
    // written before this feature has no `context` key at all, and every
    // consumer already handles its absence. Writing `context: undefined`
    // would serialize differently for no gain.
    const item: TranscriptItem = {
      id: nextId('u'), ts: Date.now(), role: 'user', text,
      ...(context ? { context } : {}),
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

Add the setter next to `setPermissionMode` (around line 124):

```ts
  setIncludeEditorContext(on: boolean): void {
    this._state.includeEditorContext = on;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }
```

Add `EditorContext` to the existing `import type { ... } from '../providers/types';` list.

- [ ] **Step 6: Default the flag in `SessionManager`**

In `src/host/session-manager.ts`, in `create()` (around line 98), add the field to the `SessionState` literal:

```ts
      title: 'Untitled', cwd, status: 'idle', permissionMode: 'default',
      includeEditorContext: true,
```

and in `init()` (around line 63), default it for rows written before this feature — an `index.json` from an earlier build has no such field, and `undefined` would read as "off":

```ts
      this.meta.set(state.id, {
        ...state,
        status: 'idle',
        includeEditorContext: state.includeEditorContext ?? true,
      });
```

- [ ] **Step 7: Add the restore test**

Append to `src/test/unit/session-manager.test.ts`, inside its existing top-level `suite`:

```ts
  test('a session restored without the flag defaults to attaching context', async () => {
    const store = new TranscriptStore(dir);
    // Written by a build that predates includeEditorContext.
    await store.writeIndex({
      sessions: [{
        id: 'legacy', providerId: 'fake', model: 'fake-small', title: 'Old',
        cwd: '/tmp', status: 'idle', permissionMode: 'default',
        usage: { inputTokens: 0, outputTokens: 0 },
        archived: false, createdAt: 1, updatedAt: 1,
      } as unknown as SessionState],
      layout: { orientation: 'vertical', panes: [] },
    });

    const restored = new SessionManager(store, providers, () => {});
    await restored.init();
    assert.strictEqual(restored.summaries()[0].includeEditorContext, true);
    await restored.dispose();
  });
```

Reuse whatever `dir` and `providers` bindings that file's `setup` already creates, and make sure `SessionState` is imported there.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS. Fix any `SessionState` literal elsewhere in the test tree that the new required field breaks — `yarn check-types` lists them all.

- [ ] **Step 9: Commit**

```bash
git add src/protocol src/host/agent-session.ts src/host/session-manager.ts src/test/unit
git commit -m "feat: carry editor context through the protocol and session state"
```

---

## Task 5: Router and extension wiring

**Files:**
- Modify: `src/host/message-router.ts:32-129,150-154`
- Modify: `src/host/panel-view-provider.ts:11-15,29`
- Modify: `src/extension.ts`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `EditorContextTracker` (Task 3), `AgentSession.setIncludeEditorContext` and the new messages (Task 4).
- Produces:
  - `EditorContextHost` (from `src/host/message-router.ts`): `{ current(): EditorContext | null; reveal(path: string, startLine?: number): void }`
  - `new MessageRouter(manager, emit, defaultCwd, editor?: EditorContextHost)`
  - `new PanelViewProvider(extensionUri, manager, defaultCwd, editor)`

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/message-router.test.ts`, inside its existing top-level `suite`:

```ts
  test('send attaches the tracked context when the session opts in', async () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const fake = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const providers = new Map<string, AgentProvider>([['fake', fake]]);
    const mgr = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await mgr.init();
    const r = new MessageRouter(mgr, (m) => sent.push(m), '/tmp', {
      current: () => ctx,
      reveal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: ctx });
    await mgr.dispose();
  });

  test('send attaches nothing when the session has opted out', async () => {
    const fake = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const providers = new Map<string, AgentProvider>([['fake', fake]]);
    const mgr = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await mgr.init();
    const r = new MessageRouter(mgr, (m) => sent.push(m), '/tmp', {
      current: () => ({ path: 'src/a.ts', languageId: 'typescript' }),
      reveal: () => {},
    });

    const session = await mgr.create('fake', '/tmp');
    await r.handle({ t: 'set-include-context', id: session.state.id, on: false });
    await r.handle({ t: 'send', id: session.state.id, text: 'hi' });
    await settle();

    assert.deepStrictEqual(fake.sent[0], { text: 'hi', context: undefined });
    assert.strictEqual(session.state.includeEditorContext, false);
    await mgr.dispose();
  });

  test('reveal-file reaches the editor host', async () => {
    const calls: { path: string; startLine?: number }[] = [];
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => null,
      reveal: (path, startLine) => calls.push({ path, startLine }),
    });

    await r.handle({ t: 'reveal-file', path: 'src/a.ts', startLine: 12 });

    assert.deepStrictEqual(calls, [{ path: 'src/a.ts', startLine: 12 }]);
  });

  test('ready emits the current editor context', async () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      current: () => ctx,
      reveal: () => {},
    });

    await r.handle({ t: 'ready' });

    const msg = sent.find((m) => m.t === 'editor-context') as
      Extract<HostToWebview, { t: 'editor-context' }>;
    assert.ok(msg);
    assert.deepStrictEqual(msg.ctx, ctx);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — the 4-argument `MessageRouter` constructor does not exist, and `set-include-context` / `reveal-file` are not routed.

- [ ] **Step 3: Wire the router**

In `src/host/message-router.ts`:

Add the injected interface above the class, and import the type:

```ts
import type {
  EditorContext, HostToWebview, SessionSnapshot, WebviewToHost,
} from '../protocol/messages';

/**
 * The router must stay free of `vscode` (it has unit tests that run outside
 * the extension host), so everything needing the real editor API arrives
 * through this. `src/extension.ts` supplies the real implementation.
 */
export interface EditorContextHost {
  current(): EditorContext | null;
  reveal(path: string, startLine?: number): void;
}

const NO_EDITOR: EditorContextHost = { current: () => null, reveal: () => {} };
```

Give the constructor a fourth parameter, defaulted so existing call sites and tests keep working:

```ts
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost = NO_EDITOR,
  ) {}
```

At the end of the `ready` case, after the `hydrate` emit and before its `return`, seed the webview — `editor-context` otherwise only arrives on the *next* editor change, so a freshly loaded panel would show "no editor" while a file sits open:

```ts
        this.emit({ t: 'editor-context', ctx: this.editor.current() });
        return;
```

Replace the `send` case (lines 91-95):

```ts
      case 'send': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const context = session.state.includeEditorContext
          ? this.editor.current() ?? undefined
          : undefined;
        session.send(msg.text, context);
        return;
      }
```

Add two cases after `set-permission-mode`:

```ts
      case 'set-include-context': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.setIncludeEditorContext(msg.on);
        return;
      }

      case 'reveal-file':
        this.editor.reveal(msg.path, msg.startLine);
        return;
```

Add both tags to `KNOWN_MESSAGE_TAGS` (around line 150) — the guard drops anything not listed, so forgetting this silently disables both messages:

```ts
const KNOWN_MESSAGE_TAGS = new Set<WebviewToHost['t']>([
  'ready', 'create-session', 'set-visible', 'set-layout', 'close-session',
  'delete-session', 'send', 'interrupt', 'set-effort', 'set-permission-mode',
  'set-model', 'permission-decision', 'load-more',
  'set-include-context', 'reveal-file',
]);
```

`set-model` is already in that set — this adds two tags, it does not rewrite the list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Pass the host through `PanelViewProvider`**

In `src/host/panel-view-provider.ts`, add the constructor parameter:

```ts
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
  ) {}
```

and pass it into the router (line 29):

```ts
    const router = new MessageRouter(
      this.manager, (m) => this.post(m), this.defaultCwd, this.editor,
    );
```

Change the import to bring in the type:

```ts
import { MessageRouter, type EditorContextHost } from './message-router';
```

- [ ] **Step 6: Build the tracker in `extension.ts`**

In `src/extension.ts`, add imports:

```ts
import { EditorContextTracker } from './host/editor-context-tracker';
import { createVscodeEditorSource } from './host/vscode-editor-source';
```

After `const defaultCwd = ...` (line 24), build the tracker and the host:

```ts
  const editorSource = createVscodeEditorSource();
  const tracker = new EditorContextTracker(editorSource);

  const editorHost = {
    current: () => tracker.current,
    reveal: (target: string, startLine?: number) => {
      void revealFile(target, startLine);
    },
  };

  provider = new PanelViewProvider(context.extensionUri, manager, defaultCwd, editorHost);

  // Push every change to the webview so the composer chip tracks the editor.
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));
```

Change the existing `provider = new PanelViewProvider(...)` line to the one above (it moves rather than duplicates), and extend the `context.subscriptions.push(...)` call to release the new objects:

```ts
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    { dispose: () => { void manager.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
  );
```

Add the helper at the bottom of the file, next to `deactivate`:

```ts
/**
 * Opens the file behind a transcript chip. `target` is whatever the chip
 * carried: workspace-relative for files inside an open folder, absolute
 * otherwise. A relative path is resolved against the first workspace folder
 * — imperfect in a multi-root workspace, and worth revisiting if that turns
 * out to bite; the context itself does not record which root it came from.
 */
async function revealFile(target: string, startLine?: number): Promise<void> {
  try {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const uri = path.isAbsolute(target)
      ? vscode.Uri.file(target)
      : roots.length > 0
        ? vscode.Uri.joinPath(roots[0].uri, target)
        : vscode.Uri.file(target);
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, (startLine ?? 1) - 1);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  } catch (err) {
    // A chip can outlive the file it points at (renamed, deleted, or from a
    // transcript restored in a different workspace). Failing to open one is
    // not worth a user-facing error.
    console.error('[hiiiid-code] could not reveal', target, err);
  }
}
```

Add `import * as path from 'node:path';` at the top.

- [ ] **Step 7: Verify types, lint and the full test run**

Run: `yarn check-types && yarn lint && yarn test:unit`
Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/host/message-router.ts src/host/panel-view-provider.ts src/extension.ts src/test/unit/message-router.test.ts
git commit -m "feat: attach the tracked editor context to sends"
```

---

## Task 6: The composer control and the transcript chip

**Design brief** (from `impeccable shape`; product truth in `PRODUCT.md`):

- **Mode: Operate.** A solo dev supervising 2–4 agents in a 300–500px sidebar, mid-turn. Before sending they must be able to answer "is my selection going with this?" at a glance; after sending, see which message carried what and click back to the code.
- **Direction: the incumbent world, extended.** shadcn/Base UI on VS Code theme tokens. The control is a toggle chip — `Button size="sm"`, lucide `Paperclip` — not a new pattern. On is `secondary` (filled), off is `ghost` with a muted icon. Filled-vs-unfilled carries the state visually; `aria-pressed` carries it for assistive tech. No colour-only state.
- **Responsive by container, not viewport.** A pane can be half the sidebar, so viewport width is the wrong signal: the composer root becomes a `@container` and the label is `hidden @[17rem]:inline`. Full-width sidebar shows `agent-session.ts:60-73 +2`; a split pane shows the icon alone with the path in `title` and `aria-label`.
- **Truncation is directional.** The basename truncates; the line span never does — `:60-73 +2` is the part that changes per message.
- **States.** No editor → the control is absent entirely (no dead affordance, no wasted line). Off → present and unfilled. Truncated selection → `(truncated)` in the title. Transcript chip only when context was actually attached, so a message sent with the toggle off looks exactly as it does today.
- **Anti-goals.** No extra row of chrome in the composer. No motion. No filename in the transcript that isn't clickable.

**Files:**
- Modify: `src/webview/reducer.ts:13-27,41-58`
- Create: `src/webview/components/editor-context-chip.tsx`
- Create: `src/webview/components/editor-context-toggle.tsx`
- Modify: `src/webview/components/composer.tsx:62-63,88`
- Modify: `src/webview/components/transcript-item.tsx:14-21`
- Test: `src/test/unit/webview-reducer.test.ts`, `src/test/unit/editor-context-chip.test.ts`, `src/test/dom/composer.test.tsx`, `src/test/dom/transcript-item.test.tsx`
- Modify: `src/test/fixtures/protocol.ts` (the new required `SessionSummary` field)

**Interfaces:**
- Consumes: `editor-context` and `set-include-context` messages, `SessionSummary.includeEditorContext`, `TranscriptItem.context` (Task 4).
- Produces: `ClientState.editorContext`, `chipLabel(ctx: EditorContext): string`, `<EditorContextLabel ctx>`, `<EditorContextChip ctx onClick>`, `<EditorContextToggle pane>`.

- [ ] **Step 1: Add the field to the test fixture**

`SessionSummary.includeEditorContext` became required in Task 4, so `src/test/fixtures/protocol.ts` no longer compiles. In `summary()`, add it after `permissionMode`:

```ts
    permissionMode: 'default',
    includeEditorContext: true,
```

- [ ] **Step 2: Write the failing reducer test**

Append to `src/test/unit/webview-reducer.test.ts`, inside its existing top-level `suite`:

```ts
  test('editor-context replaces the client-wide context', () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const next = reduce(initialState, { t: 'editor-context', ctx });
    assert.deepStrictEqual(next.editorContext, ctx);

    const cleared = reduce(next, { t: 'editor-context', ctx: null });
    assert.strictEqual(cleared.editorContext, null);
  });

  test('the initial state has no editor context', () => {
    assert.strictEqual(initialState.editorContext, null);
  });
```

- [ ] **Step 3: Write the failing chip-label test**

Create `src/test/unit/editor-context-chip.test.ts`:

```ts
import * as assert from 'assert';
import { chipLabel } from '../../webview/components/editor-context-chip';

suite('chipLabel', () => {
  test('a file reference is the basename alone', () => {
    assert.strictEqual(
      chipLabel({ path: 'src/host/agent-session.ts', languageId: 'typescript' }),
      'agent-session.ts',
    );
  });

  test('one range appends the line span', () => {
    assert.strictEqual(chipLabel({
      path: 'src/host/agent-session.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 60, endLine: 73, text: 'x' }], truncated: false },
    }), 'agent-session.ts:60-73');
  });

  test('a single-line range collapses to one number', () => {
    assert.strictEqual(chipLabel({
      path: 'a.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 7, endLine: 7, text: 'x' }], truncated: false },
    }), 'a.ts:7');
  });

  test('extra ranges are counted, not listed', () => {
    assert.strictEqual(chipLabel({
      path: 'a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [
          { startLine: 1, endLine: 2, text: 'x' },
          { startLine: 9, endLine: 9, text: 'y' },
          { startLine: 20, endLine: 21, text: 'z' },
        ],
        truncated: false,
      },
    }), 'a.ts:1-2 +2');
  });
});
```

- [ ] **Step 4: Write the failing DOM tests for the composer control**

Append to `src/test/dom/composer.test.tsx`, inside its existing top-level `suite`. These drive the real `StoreProvider` and feed genuine `HostToWebview` messages, per the DOM-test invariant in `CLAUDE.md` — never hand-build a `ClientState`.

```ts
  const CTX = {
    path: 'src/host/agent-session.ts',
    languageId: 'typescript',
    selection: { ranges: [{ startLine: 60, endLine: 73, text: 'x' }], truncated: false },
  };

  test('no editor context means no control at all', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    assert.strictEqual(screen.queryByRole('button', { name: /editor context/i }), null);
  });

  test('an editor context reveals the control, on and naming the file', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    sendFromHost({ t: 'editor-context', ctx: CTX });

    const toggle = screen.getByRole('button', { name: /editor context/i });
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'true');
    // The accessible name carries the file even when the container query has
    // collapsed the visible label to an icon.
    assert.ok(/agent-session\.ts/.test(toggle.getAttribute('aria-label') ?? ''));
  });

  test('clicking the control posts the opposite of the session flag', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    sendFromHost({ t: 'editor-context', ctx: CTX });

    await userEvent.click(screen.getByRole('button', { name: /editor context/i }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'set-include-context', id: 'a', on: false,
    });
  });

  test('a session with the flag off renders the control unpressed', () => {
    const off = {
      summary: summary('a', { includeEditorContext: false }),
      items: [], hasMore: false, pending: [],
    };
    renderWithStore(<Composer pane={off} model={NO_EFFORT} />);
    sendFromHost({ t: 'editor-context', ctx: CTX });

    const toggle = screen.getByRole('button', { name: /editor context/i });
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
  });

  test('a context with no selection names the file without a line span', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    sendFromHost({
      t: 'editor-context',
      ctx: { path: 'src/a.ts', languageId: 'typescript' },
    });

    const toggle = screen.getByRole('button', { name: /editor context/i });
    const label = toggle.getAttribute('aria-label') ?? '';
    assert.ok(label.includes('src/a.ts'));
    assert.ok(!label.includes(':'));
  });
```

jsdom does not evaluate container queries, so the label element is always present in the DOM there. Every assertion above therefore reads the accessible name, which is width-independent by design — the visible collapse is verified by hand in Step 10.

- [ ] **Step 5: Write the failing DOM test for the transcript chip**

`src/test/dom/transcript-item.test.tsx` already exists — append a second `suite` to it rather than creating the file. It currently drives `renderApp()` + `hydrateWithItems()`; these tests render the component directly under the store, which is equally legitimate and keeps the reveal assertion narrow. Add `userEvent`, `TranscriptItemView`, `posted` and `renderWithStore` to its imports:

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptItemView } from '@/components/transcript-item';
import type { TranscriptItem } from '../../protocol/messages';
import { posted, renderWithStore } from './harness';

const WITH_CONTEXT: TranscriptItem = {
  id: 'u1', ts: 1, role: 'user', text: 'fix the send path',
  context: {
    path: 'src/host/agent-session.ts',
    languageId: 'typescript',
    selection: { ranges: [{ startLine: 60, endLine: 73, text: 'x' }], truncated: false },
  },
};

const PLAIN: TranscriptItem = { id: 'u2', ts: 2, role: 'user', text: 'plain' };

suite('TranscriptItemView user context', () => {
  test('a message sent without context shows no chip', () => {
    renderWithStore(<TranscriptItemView item={PLAIN} sessionId="a" />);
    assert.strictEqual(screen.queryByRole('button', { name: /agent-session/ }), null);
    assert.ok(screen.getByText('plain'));
  });

  test('a message sent with context shows the chip it carried', () => {
    renderWithStore(<TranscriptItemView item={WITH_CONTEXT} sessionId="a" />);
    assert.ok(screen.getByRole('button', { name: /agent-session\.ts:60-73/ }));
  });

  test('clicking the chip asks the host to reveal the first selected line', async () => {
    renderWithStore(<TranscriptItemView item={WITH_CONTEXT} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /agent-session\.ts:60-73/ }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'reveal-file', path: 'src/host/agent-session.ts', startLine: 60,
    });
  });

  test('a file-reference chip reveals the file with no line', async () => {
    const fileOnly: TranscriptItem = {
      id: 'u3', ts: 3, role: 'user', text: 'look',
      context: { path: 'src/a.ts', languageId: 'typescript' },
    };
    renderWithStore(<TranscriptItemView item={fileOnly} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /a\.ts/ }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'reveal-file', path: 'src/a.ts', startLine: undefined,
    });
  });
});
```

- [ ] **Step 6: Run both suites to verify they fail**

Run: `yarn test:unit && yarn test:dom`
Expected: FAIL — `editorContext` is not on `ClientState`, and neither new component module exists.

- [ ] **Step 7: Extend the reducer**

In `src/webview/reducer.ts`, add to `ClientState`:

```ts
  /**
   * Client-wide, not per session: the active editor is global IDE state and
   * every composer shows the same file.
   */
  editorContext: EditorContext | null;
```

add `editorContext: null` to `initialState`, add `EditorContext` to the type import from `'../protocol/messages'`, and add a case to `reduce`, after `sessions-changed`:

```ts
    case 'editor-context':
      return { ...state, editorContext: msg.ctx };
```

- [ ] **Step 8: Write the chip module**

Create `src/webview/components/editor-context-chip.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { EditorContext } from '../../protocol/messages';

/**
 * What the user reads: the file's basename, the first range's line span, and
 * a count of any further ranges. The full path lives in `title` rather than
 * the label — a pane can be 150px wide, and the basename is what identifies
 * the file.
 */
export function chipLabel(ctx: EditorContext): string {
  const ranges = ctx.selection?.ranges ?? [];
  if (ranges.length === 0) { return basename(ctx); }
  const [first] = ranges;
  const span = first.startLine === first.endLine
    ? `${first.startLine}`
    : `${first.startLine}-${first.endLine}`;
  const extra = ranges.length > 1 ? ` +${ranges.length - 1}` : '';
  return `${basename(ctx)}:${span}${extra}`;
}

export function contextTitle(ctx: EditorContext): string {
  return ctx.selection?.truncated ? `${ctx.path} (truncated)` : ctx.path;
}

function basename(ctx: EditorContext): string {
  return ctx.path.split('/').pop() ?? ctx.path;
}

/**
 * Two spans, not one string: the basename truncates and the line span never
 * does. `:60-73 +2` is the part that differs between two messages about the
 * same file, so it is the part that must survive a narrow pane.
 */
export function EditorContextLabel({ ctx, className }: {
  ctx: EditorContext;
  className?: string;
}) {
  const ranges = ctx.selection?.ranges ?? [];
  const [first] = ranges;
  const span = first
    ? `:${first.startLine === first.endLine ? first.startLine : `${first.startLine}-${first.endLine}`}`
      + (ranges.length > 1 ? ` +${ranges.length - 1}` : '')
    : '';

  return (
    <span className={cn('flex min-w-0 items-baseline', className)}>
      <span className="truncate">{basename(ctx)}</span>
      {span && <span className="shrink-0">{span}</span>}
    </span>
  );
}

/**
 * The transcript's record of what a message carried. A link, not a Button:
 * it sits inline above a message body, and a Button variant's padding and
 * background would break that line's flow. It is still a real `<button>` —
 * keyboard reachable, with the focus ring the theme provides.
 */
export function EditorContextChip({ ctx, onClick }: {
  ctx: EditorContext;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={contextTitle(ctx)}
      aria-label={`Open ${chipLabel(ctx)}`}
      className={cn(
        'flex max-w-full items-baseline text-xs text-muted-foreground',
        'underline decoration-dotted underline-offset-2',
        'hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
      )}
    >
      <EditorContextLabel ctx={ctx} />
    </button>
  );
}
```

- [ ] **Step 9: Write the composer control**

Create `src/webview/components/editor-context-toggle.tsx`:

```tsx
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EditorContextLabel, chipLabel, contextTitle } from './editor-context-chip';
import { useStore } from '../store';
import type { PaneState } from '../reducer';

/**
 * Attach-or-not for the next message, and a preview of what would be
 * attached.
 *
 * Renders nothing when there is no editor: a disabled control in a 300px
 * sidebar is a dead affordance, and the absence is unambiguous because the
 * control only ever exists when there is something to attach.
 *
 * The label is revealed by a container query rather than a viewport one —
 * a pane can be half the sidebar, so the viewport says nothing useful about
 * how much room this control actually has. The accessible name carries the
 * file either way, so collapsing to the icon costs nothing to a screen
 * reader.
 */
export function EditorContextToggle({ pane }: { pane: PaneState }) {
  const { state, post } = useStore();
  const ctx = state.editorContext;
  if (!ctx) { return null; }

  const on = pane.summary.includeEditorContext;

  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={on}
      // No colon before the path: a colon in this label must be earned by a
      // line span, or it reads as punctuation the file name does not have.
      // The span is appended here rather than carried in an sr-only child —
      // aria-label overrides element contents, so such a child is never read.
      aria-label={`${on ? 'Attaching' : 'Not attaching'} editor context ${ctx.path}${lineSpan(ctx)}`}
      title={`${on ? 'Attaching' : 'Not attaching'} ${contextTitle(ctx)}`}
      onClick={() => post({ t: 'set-include-context', id: pane.summary.id, on: !on })}
      className={cn('min-w-0 max-w-56', !on && 'text-muted-foreground')}
    >
      <Paperclip aria-hidden="true" />
      <EditorContextLabel ctx={ctx} className="hidden @[17rem]:flex" />
    </Button>
  );
}
```

- [ ] **Step 10: Mount it in the composer**

The composer is built from `InputGroup` / `InputGroupTextarea` / `InputGroupAddon`, and its settings row is an `InputGroupAddon align="block-end"` that already carries `flex-wrap` (read the comment above it — it exists precisely because effort and permission-mode cannot share one row at ~300px). The control joins that row.

In `src/webview/components/composer.tsx`, make the root a query container — every responsive decision inside the composer keys off the pane's own width, not the window's:

```tsx
    <div className="@container p-2">
```

Mount the control as the **first** child of the `InputGroupAddon align="block-end"` block, before the effort `Select`:

```tsx
        <InputGroupAddon align="block-end" className="flex-wrap">
          <EditorContextToggle pane={pane} />
```

with the import:

```ts
import { EditorContextToggle } from './editor-context-toggle';
```

First position, not last: Send and Stop are pinned to the right edge with `ml-auto`, and inserting anything after them breaks that. It also puts the attachment nearest the message it belongs to.

**Why a container query rather than `useIsNarrow`.** `src/webview/components/use-is-narrow.ts` exists and its doc comment is explicit that it has exactly one call site — `App`, against the panel root — measuring the *panel*, deliberately, so that `SessionPicker` and `PaneGroup` can never disagree. This control needs the width of *one pane*, which is a different number whenever the panel is split. Adding a second `ResizeObserver` would reintroduce exactly the disagreement that hook was written to remove. The composer already solves its own crowding in CSS (`flex-wrap` on the addon), so a container query continues the local pattern instead of contradicting the global one.

- [ ] **Step 11: Render the chip in the transcript**

Every item is now wrapped in `TranscriptItemShell`, which owns the role label and timestamp. The chip goes *inside* the shell, above the message body, so it reads as part of the message rather than as a second header.

In `src/webview/components/transcript-item.tsx`, replace the `user` case (around lines 14-21):

```tsx
    case 'user':
      return <UserItem item={item} />;
```

and add the component below `TranscriptItemView` in the same file:

```tsx
function UserItem({ item }: { item: Extract<TranscriptItem, { role: 'user' }> }) {
  const { post } = useStore();
  const ctx = item.context;

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
      <div className="rounded bg-muted px-2 py-1 wrap-break-word whitespace-pre-wrap">
        {item.text}
      </div>
    </TranscriptItemShell>
  );
}
```

The body's classes are copied verbatim from the case being replaced — `wrap-break-word` matters in a 150px pane. If they have drifted again by the time this runs, take the ones in the file, not the ones here.

with the imports:

```ts
import { useStore } from '../store';
import { EditorContextChip } from './editor-context-chip';
```

A separate component rather than inline JSX because `TranscriptItemView` is a switch that returns early — a hook may not be called inside one branch of it. The chip is built from `item.context`, the stored value, never from the live `state.editorContext`, so history keeps showing what was actually sent.

- [ ] **Step 12: Run the tests to verify they pass**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS.

Run: `yarn check-types && yarn lint`
Expected: no errors.

- [ ] **Step 13: Run the design detector**

Required by `CLAUDE.md` after any change under `src/webview/components/`:

```bash
node C:/Users/Marco/.claude/skills/impeccable/scripts/detect.mjs --json \
  src/webview/components/editor-context-chip.tsx \
  src/webview/components/editor-context-toggle.tsx \
  src/webview/components/composer.tsx \
  src/webview/components/transcript-item.tsx
```

Exit 0 is clean. Exit 2 means findings — fix them, then re-run. A non-zero exit is a failing check, not a suggestion.

- [ ] **Step 14: Build**

Run: `yarn compile && yarn build:css`
Expected: both bundles emit with no errors.

- [ ] **Step 15: Verify by hand in the extension host**

Run: `yarn dev` (or press F5), then in the host window:

1. Open a source file, select a few lines, open the panel. The control reads `📎 agent-session.ts:60-73` and is filled.
2. **Click into the composer and type.** The label must not change or disappear. This is the focus-theft case and only reproduces here.
3. Send. The user message shows the chip above the text. Click the chip — the file opens at the first selected line.
4. Add a second cursor, select a second block. The label gains ` +1`.
5. **Split the panel into two panes.** The label collapses to the icon alone; hovering it still names the file. Widen the sidebar until the label returns.
6. Click the control so it goes unfilled. Send. The new message has no chip.
7. Reload the window (`Developer: Reload Window`). The control is still unfilled for that session.
8. Close every editor tab. The control disappears; the composer row keeps its other controls in place with no gap.
9. Switch VS Code between a light and a dark theme, then a high-contrast one. Filled and unfilled stay distinguishable in all three, and the focus ring is visible when tabbing to the control.

- [ ] **Step 16: Commit**

```bash
git add src/webview src/test/dom src/test/fixtures/protocol.ts src/test/unit/webview-reducer.test.ts src/test/unit/editor-context-chip.test.ts
git commit -m "feat: toggle and show the editor context in the panel"
```

---

## Task 7: Design review before merge

**Files:** none — this task produces a critique snapshot, not code.

- [ ] **Step 1: Run the critique**

Required by `CLAUDE.md` before merging a UI branch:

```
/impeccable critique src/webview
```

- [ ] **Step 2: Compare against the last snapshot**

Read the newest file in `.impeccable/critique/` and compare with the previous one. The score is expected to go up, never down. If it dropped, fix what the critique names and re-run before merging.

- [ ] **Step 3: Commit the snapshot**

```bash
git add .impeccable/critique
git commit -m "docs: critique snapshot after editor context"
```

---

## Self-Review Notes

Spec coverage, section by section:

| Spec section | Task |
|---|---|
| Capture policy (scheme, ranges, 1-based lines, relative path, 8000-char budget) | T1, and the 0-based conversion in T3 Step 5 |
| Data model (`EditorContext`) | T1 Step 1 |
| Protocol changes (item field, state field, three messages) | T4 Steps 1-2 |
| Ownership (host authoritative) | T5 Step 3 — the router reads `this.editor.current()`; the webview never echoes context back |
| `EditorContextTracker` (focus theft, clear on close) | T3 |
| Send flow (`AgentRun.send`, `AgentSession.send`, router resolution) | T2 Step 4, T4 Step 5, T5 Step 3 |
| `formatEditorContext` | T2 Steps 1-3 |
| Webview (toggle, empty state, transcript chip, reveal) | T6 |
| Testing (six listed suites) | T1, T2, T3, T4, T5, T6 |
| Design gates (detector, critique) | T6 Step 13, T7 |

Three things the spec left implicit that this plan pins down, all flagged inline where they land:

- The `ready` handler seeds `editor-context` (T5 Step 3), otherwise a freshly loaded panel shows nothing until the user touches an editor.
- A relative chip path resolves against the first workspace folder on reveal (T5 Step 6), which is imperfect in a multi-root workspace.
- **The spec's empty state was overruled by the `shape` pass.** The spec says a disabled control reading `no editor`; the shaped design removes the control entirely when there is no editor, because a dead affordance in a 300px sidebar costs a slot and says nothing. The consequence, accepted deliberately: with no file open there is no way to pre-set the toggle for the next message. Update the spec's Webview section to match before merging, so the two documents do not disagree.
