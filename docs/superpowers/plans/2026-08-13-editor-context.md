# Editor Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages sent from the panel carry the file the user is looking at, and the lines they have selected, with a per-session toggle to suppress it.

**Architecture:** The extension host owns the context. A pure builder turns a plain editor snapshot into an `EditorContext`; a tracker holds the latest one and survives the webview stealing editor focus; the router attaches it on `send` when the session's toggle is on. Providers own formatting. The webview receives the context only to render a chip.

**Tech Stack:** TypeScript, esbuild, React 19, Tailwind v4, shadcn (Base UI), mocha (`--ui tdd`), `@vscode/test-cli`.

**Spec:** [docs/superpowers/specs/2026-08-13-editor-context-design.md](../specs/2026-08-13-editor-context-design.md)

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
| `src/webview/components/editor-context-chip.tsx` | `chipLabel()` + the chip component, shared by composer and transcript | create |
| `src/webview/components/composer.tsx` | The toggle button | modify |
| `src/webview/components/transcript-item.tsx` | Chip above a user message that carried context | modify |

---

## Task Order

Strictly serial. Every task depends on the one before it, and several tasks touch the same files.

```
T1 (type + builder) → T2 (formatter + provider seam) → T3 (tracker + adapter)
   → T4 (protocol + session + manager) → T5 (router + wiring) → T6 (webview + manual verify)
```

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
- Modify: `src/providers/claude/claude-provider.ts:163-169`
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

In `src/providers/types.ts`, change the `send` member of `AgentRun`:

```ts
export interface AgentRun {
  send(text: string, context?: EditorContext): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
```

The parameter is optional, so every existing caller and both existing providers still typecheck.

- [ ] **Step 5: Record sends in `FakeProvider`**

In `src/providers/fake/fake-provider.ts`, add the field next to `decisions`:

```ts
  /** Records every (text, context) pair passed to send, for assertions. */
  readonly sent: { text: string; context?: EditorContext }[] = [];
```

and change the returned `send` (currently lines 69-75) to:

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

In `src/providers/claude/claude-provider.ts`, replace the returned `send` (lines 163-169) with:

```ts
      send: (text: string, context?: EditorContext) => {
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

  return {
    onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable {
      const emit = (editor: vscode.TextEditor | undefined) => {
        cb(editor ? snapshot(editor) : null);
      };
      subs.push(vscode.window.onDidChangeActiveTextEditor(emit));
      subs.push(vscode.window.onDidChangeTextEditorSelection((e) => emit(e.textEditor)));
      // Seed from whatever is already open at activation, so the first
      // message of a session carries context without the user touching
      // anything.
      emit(vscode.window.activeTextEditor);
      return { dispose: () => { /* all subs released by dispose() below */ } };
    },

    onDidCloseDocument(cb: (fsPath: string) => void): Disposable {
      subs.push(vscode.workspace.onDidCloseTextDocument((doc) => cb(doc.uri.fsPath)));
      return { dispose: () => { /* all subs released by dispose() below */ } };
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
- Modify: `src/host/session-manager.ts:40-46,77-83`
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

Add the setter next to `setPermissionMode` (line 95):

```ts
  setIncludeEditorContext(on: boolean): void {
    this._state.includeEditorContext = on;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }
```

Add `EditorContext` to the existing `import type { ... } from '../providers/types';` list.

- [ ] **Step 6: Default the flag in `SessionManager`**

In `src/host/session-manager.ts`, in `create()` (line 78), add the field to the `SessionState` literal:

```ts
      title: 'Untitled', cwd, status: 'idle', permissionMode: 'default',
      includeEditorContext: true,
```

and in `init()` (line 43), default it for rows written before this feature — an `index.json` from an earlier build has no such field, and `undefined` would read as "off":

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
- Modify: `src/host/message-router.ts:32-124,144-148`
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

Add both tags to `KNOWN_MESSAGE_TAGS` (line 144) — the guard drops anything not listed, so forgetting this silently disables both messages:

```ts
const KNOWN_MESSAGE_TAGS = new Set<WebviewToHost['t']>([
  'ready', 'create-session', 'set-visible', 'set-layout', 'close-session',
  'delete-session', 'send', 'interrupt', 'set-effort', 'set-permission-mode',
  'permission-decision', 'load-more', 'set-include-context', 'reveal-file',
]);
```

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

## Task 6: The composer toggle and the transcript chip

**Files:**
- Modify: `src/webview/reducer.ts:13-27,41-58`
- Create: `src/webview/components/editor-context-chip.tsx`
- Modify: `src/webview/components/composer.tsx:27-38,56-68`
- Modify: `src/webview/components/transcript-item.tsx:12-17`
- Test: `src/test/unit/webview-reducer.test.ts`, `src/test/unit/editor-context-chip.test.ts`

**Interfaces:**
- Consumes: `editor-context` and `set-include-context` messages, `SessionSummary.includeEditorContext`, `TranscriptItem.context` (Task 4).
- Produces: `ClientState.editorContext`, `chipLabel(ctx: EditorContext): string`, `<EditorContextChip>`.

- [ ] **Step 1: Write the failing reducer test**

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

- [ ] **Step 2: Write the failing chip-label test**

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

- [ ] **Step 3: Run both tests to verify they fail**

Run: `yarn test:unit`
Expected: FAIL — `editorContext` is not on `ClientState`, and the chip module does not exist.

- [ ] **Step 4: Extend the reducer**

In `src/webview/reducer.ts`, add to `ClientState`:

```ts
  /**
   * Client-wide, not per session: the active editor is global IDE state and
   * every composer shows the same chip.
   */
  editorContext: EditorContext | null;
```

add `editorContext: null` to `initialState`, add `EditorContext` to the type import from `'../protocol/messages'`, and add a case to `reduce`, after `sessions-changed`:

```ts
    case 'editor-context':
      return { ...state, editorContext: msg.ctx };
```

- [ ] **Step 5: Write the chip component**

Create `src/webview/components/editor-context-chip.tsx`:

```tsx
import type { EditorContext } from '../../protocol/messages';

/**
 * What the user reads in the composer and above a sent message: the file's
 * basename, the first range's line span, and a count of any further ranges.
 * The full path lives in the title attribute rather than the label — a
 * sidebar pane is narrow, and the basename is what identifies the file.
 */
export function chipLabel(ctx: EditorContext): string {
  const name = ctx.path.split('/').pop() ?? ctx.path;
  const ranges = ctx.selection?.ranges ?? [];
  if (ranges.length === 0) { return name; }
  const [first] = ranges;
  const span = first.startLine === first.endLine
    ? `${first.startLine}`
    : `${first.startLine}-${first.endLine}`;
  const extra = ranges.length > 1 ? ` +${ranges.length - 1}` : '';
  return `${name}:${span}${extra}`;
}

export function EditorContextChip({
  ctx, onClick,
}: {
  ctx: EditorContext;
  onClick?: () => void;
}) {
  const label = chipLabel(ctx);
  const title = ctx.selection?.truncated ? `${ctx.path} (truncated)` : ctx.path;

  if (!onClick) {
    return (
      <span className="text-xs text-muted-foreground" title={title}>{label}</span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      {label}
    </button>
  );
}
```

The bare `<button>` here is deliberate and is the one exception to the shadcn rule in this plan: it is a text link inside a transcript line, not a control — a `Button` variant would impose padding and a background that break the line's flow. Everything interactive in the composer still uses `Button`.

- [ ] **Step 6: Add the composer toggle**

In `src/webview/components/composer.tsx`:

Change the store destructure (line 28) to take state as well:

```ts
  const { state, post } = useStore();
```

Add, next to the `running` binding:

```ts
  const ctx = state.editorContext;
  const attaching = pane.summary.includeEditorContext;
```

Add the toggle inside the controls row, immediately after the Send/Stop button (line 67):

```tsx
        <Button
          variant={attaching ? 'secondary' : 'outline'}
          size="sm"
          disabled={!ctx}
          aria-pressed={attaching}
          aria-label="Attach editor context"
          title={ctx ? `${attaching ? 'Attaching' : 'Not attaching'} ${ctx.path}` : 'No file open'}
          onClick={() => post({
            t: 'set-include-context', id: pane.summary.id, on: !attaching,
          })}
        >
          {attaching ? '◉' : '○'} {ctx ? chipLabel(ctx) : 'no editor'}
        </Button>
```

and import the label helper:

```ts
import { chipLabel } from './editor-context-chip';
```

- [ ] **Step 7: Render the chip in the transcript**

In `src/webview/components/transcript-item.tsx`, replace the `user` case (lines 12-17):

```tsx
    case 'user':
      return (
        <div className="my-2 rounded bg-muted px-2 py-1">
          {item.context && (
            <div className="mb-1">
              <EditorContextChip
                ctx={item.context}
                onClick={() => post({
                  t: 'reveal-file',
                  path: item.context!.path,
                  startLine: item.context!.selection?.ranges[0]?.startLine,
                })}
              />
            </div>
          )}
          <div className="whitespace-pre-wrap">{item.text}</div>
        </div>
      );
```

Add at the top of the component body (the file currently has no store access):

```tsx
  const { post } = useStore();
```

and the imports:

```ts
import { useStore } from '../store';
import { EditorContextChip } from './editor-context-chip';
```

Note the chip is built from `item.context` — the stored value — never from the live `state.editorContext`, so history keeps showing what was actually sent.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS.

Run: `yarn check-types && yarn lint`
Expected: no errors.

- [ ] **Step 9: Build**

Run: `yarn compile && yarn build:css`
Expected: both bundles emit with no errors.

- [ ] **Step 10: Verify by hand in the extension host**

Run: `yarn dev` (or press F5), then in the host window:

1. Open a source file and select a few lines. Open the panel. The composer button reads `◉ <file>:<start>-<end>`.
2. **Click into the composer and type.** The button label must not change to `no editor`. This is the focus-theft case and it only reproduces here.
3. Send. The user message shows the chip above the text. Click the chip — the file opens at the first selected line.
4. Add a second cursor and select a second block. The label gains ` +1`.
5. Click the toggle so it reads `○`. Send again. The new message has no chip.
6. Reload the window (`Developer: Reload Window`). The toggle is still `○` for that session.
7. Toggle back on, close every editor tab. The button goes disabled and reads `no editor`.

- [ ] **Step 11: Commit**

```bash
git add src/webview src/test/unit/webview-reducer.test.ts src/test/unit/editor-context-chip.test.ts
git commit -m "feat: toggle and show the editor context in the panel"
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
| Webview (toggle, disabled state, transcript chip, reveal) | T6 |
| Testing (six listed suites) | T1, T2, T3, T4, T5, T6 |

Two things the spec left implicit that this plan pins down, both flagged inline where they land: the `ready` handler seeds `editor-context` (T5 Step 3), otherwise a freshly loaded panel shows `no editor` until the user touches an editor; and a relative chip path resolves against the first workspace folder on reveal (T5 Step 6), which is imperfect in a multi-root workspace.
