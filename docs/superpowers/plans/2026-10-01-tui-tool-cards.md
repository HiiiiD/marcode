# TUI tool cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the human chose native execution, in this session) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render tool calls and subagents in the TUI transcript as bordered cards at parity with the VS Code webview's `ToolCard` and `SubagentCard`.

**Architecture:** Reuse the shared description layer (`src/client-core/tool-render.ts`) and move `subagent-window.ts` next to it. The transcript row model keeps one row per top-level tool item (the item travels in the row); a hand-written controlled `Collapsible` shell draws the border, header and body; `ToolCard` and `SubagentCard` compose it. One shared ticker drives spinners and elapsed time.

**Tech Stack:** OpenTUI (`@opentui/react` 0.5.13, `@opentui/core`) on Bun, `bun test`, mocha, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-01-tui-tool-cards-design.md` (read it first; it is the binding authority).

## Global Constraints

- Branch: **`feat/tui-termcn` only.** First command of every session and before every commit: `cd /e/Efebia/hiiiid-code && git branch --show-current` must print `feat/tui-termcn`; if not, stop and tell the user. No worktrees, no push, no merge. (A spawned session may start outside the repo or on another branch; `cd` first and assert.)
- Commit prefixes `feat:`, `fix:`, `test:`, `docs:`, `chore:`. **Never** add `Co-Authored-By` or any Claude/Anthropic trailer; check `git log -1 --format=%B` after each commit.
- Never run `yarn build:tui:bin`. Never create scratch or experiment folders in the repo; throwaway files go in `$TEMP` and are deleted right after use (a probe test outside the repo must import by absolute path, e.g. `E:/Efebia/hiiiid-code/src/...`, and `createElement` from `E:/Efebia/hiiiid-code/node_modules/react`).
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM; `src/protocol/messages.ts` is types-only and is not touched by this plan.
- Tests: never hand a renderer or renderable to an assertion (frame strings, counts, booleans, and strings built from `captureSpans` only; `scripts/check-tui-asserts.mjs` enforces it); never mock the store or hand-build `ClientState`; feed genuine `HostToWebview` messages through `src/test/tui/harness.tsx`. A component that takes plain props (like `ToolBlocks`) may be mounted directly with props via `mount(...)`.
- Gates (run before every commit that changes code): `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`; plus `yarn test:unit` and `yarn test:dom` in Tasks 1, 2 and 8. `yarn test:unit` sometimes fails with `listen EACCES` in `SelfControlMcpServer` tests; re-run before treating it as real. Baseline before this plan: `yarn test:tui` = 182 pass.
- Many repo files are CRLF. Edit them with the Edit tool (it keeps their endings). Do not rewrite a file with a Python/shell one-liner containing backslash escapes; the shell and tool layers corrupt them. Write files containing backslashes with Write or Edit.
- Pin every shell command with its own `cd /e/Efebia/hiiiid-code &&`; the working directory reverts between calls.
- Comments only for non-obvious "why". Keep files under ~300 lines; kebab-case filenames.
- Generated files in `src/tui/ui/termcn/` are installed by the shadcn CLI; do not install anything new in this plan. Task 8 only deletes one of them.
- OpenTUI facts already learned the hard way: `<box>` defaults to a **column**, so always set `flexDirection="row"` for a row; `inverse` is not a text prop (use `attributes={TextAttributes.INVERSE}`); `columnGap` exists on `Box`; a `<text>` takes `<span fg=...>` children.

## Review Focus

1. **Narrow terminal (50 columns):** a card header with a very long path and a `failed` pill must stay one line, with the pill and chevron still visible, not wrap or push the chevron off. Pinned in Task 6.
2. **Long path with no spaces or separators** (a 200-character token) must not blow out the card width. Pinned in Task 6.
3. **Subagent edge cases:** zero children, a background dispatch (`Running in background`, not `0 tools · 0s`), more than 10 children (window of the last 10 plus a `showing last 10 of N` line). Pinned in Task 7.
4. **Blocked subagent:** forces open, stays open across re-renders, and a user collapse sticks even while still blocked. Pinned in Task 7.
5. **Timers:** an idle transcript (all cards settled, subagents closed) starts no interval; many running cards share one interval; the interval is cleared when the last running card unmounts or settles. Pinned in Tasks 3 and 6.

---

### Task 1: Move `subagent-window` to client-core

**Files:**
- Move: `src/webview/components/subagent-window.ts` → `src/client-core/subagent-window.ts`
- Move: `src/test/unit/subagent-window.test.ts` (keep path) with its import updated
- Modify imports in: `src/fleet/subagent-list.tsx`, `src/webview/components/subagent-card.tsx`, `src/webview/components/subagent-transcript.tsx`, `src/test/unit/subagent-window.test.ts`; comment mention in `src/fleet/filter-subagents.ts` (path text only)

**Interfaces:**
- Produces (unchanged signatures, new path `src/client-core/subagent-window.ts`): `SUBAGENT_CHILD_WINDOW`, `windowChildren(children)`, `summarizeSubagent(item, now): SubagentSummary`, `formatElapsed(ms)`, `subagentStateLabel(item, blocked)`, `isBackgroundDispatch(item)`, `subagentLabel(item)`, `SubagentSummary`.

- [ ] **Step 1: Move the file and fix its relative import**

Run: `cd /e/Efebia/hiiiid-code && git mv src/webview/components/subagent-window.ts src/client-core/subagent-window.ts`
Then in the moved file change `from '../../protocol/messages'` to `from '../protocol/messages'`.

- [ ] **Step 2: Update importers**

- `src/fleet/subagent-list.tsx`: `'../webview/components/subagent-window'` → `'../client-core/subagent-window'`
- `src/webview/components/subagent-card.tsx` and `subagent-transcript.tsx`: `'./subagent-window'` → `'../../client-core/subagent-window'`
- `src/test/unit/subagent-window.test.ts`: `'../../webview/components/subagent-window'` → `'../../client-core/subagent-window'`
- `src/fleet/filter-subagents.ts`: update the comment text only.
Check nothing else imports it: `cd /e/Efebia/hiiiid-code && grep -rn "subagent-window" src`

- [ ] **Step 2b: Run the gates**

Run: `cd /e/Efebia/hiiiid-code && yarn check-types && yarn lint && yarn test:unit && yarn test:dom`
Expected: all pass (same counts as before; the moved test still runs).

- [ ] **Step 3: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A src && git commit -m "refactor: share subagent-window through client-core" && git log -1 --format=%B
```

---

### Task 2: One row per top-level tool item

**Files:**
- Modify: `src/tui/view/transcript-rows.ts`, `src/tui/ui/transcript/transcript.tsx`, `src/tui/ui/transcript/row.tsx`, `src/test/unit/tui-view.test.ts`

**Interfaces:**
- Produces: `TranscriptRow` tool variant becomes `{ kind: 'tool'; id: string; item: ToolItem; header: ToolHeader; state: 'running' | 'ok' | 'error' }` where `type ToolItem = Extract<TranscriptItem, { role: 'tool' }>`. The `depth` field is removed. Children are reachable as `row.item.children`.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/tui-view.test.ts` replace the test `'tool children are flattened at depth 1 after their parent'` (find it with `grep -n "flattened" src/test/unit/tui-view.test.ts`) with:

```ts
  test('a tool row carries its item and its children are not rows', () => {
    const child = tool({ id: 'c', toolId: 'tc' });
    const parent = tool({ id: 'p', children: [child] });
    const rows = transcriptRows([parent], false);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.ok(row.kind === 'tool');
    assert.strictEqual(row.kind === 'tool' && row.item.children?.length, 1);
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -aE "passing|failing|carries its item"`
Expected: FAIL (two rows are returned today).

- [ ] **Step 3: Implement**

In `transcript-rows.ts`: delete `toolRows`; add `type ToolItem = Extract<TranscriptItem, { role: 'tool' }>`; change the tool variant to the interface above; in the `case 'tool':` push
`{ kind: 'tool', id: item.id, item, header: describeTool(item.tool), state: item.state }`.
In `transcript.tsx`: remove the `itemById` memo and the sibling `<ToolBody .../>` render and its import (the card draws its own body in Task 6/7); keep cursor/open logic. In `row.tsx`: stop using `row.depth`, `row.header` for tool (temporary: render the existing one-line header from `row.header` and `row.state`; Task 6 replaces it). `RowView` tool case during this task renders `<text>{`${props.expanded ? '▾' : '▸'} ${row.header.verb} ${row.header.primary}`}</text>`.

- [ ] **Step 4: Run all gates and fix transcript tests**

Run: `cd /e/Efebia/hiiiid-code && yarn check-types:tui && yarn lint && yarn test:unit && yarn test:tui`
Expected: unit passes. In `test:tui`, tests that expand a tool and read its output body (`transcript.test.tsx`: 'a tool call is one header line until expanded', 'a very long output is clamped...', 'the cursor stays on the same row after a prepend') fail until the body is rendered again: **mark them with `test.skip` for this task only and list their names in the commit body**; Task 6 un-skips them. Everything else must pass.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A src && git commit -m "refactor: one transcript row per top-level tool item" && git log -1 --format=%B
```

---

### Task 3: Shared ticker

**Files:**
- Create: `src/tui/ui/use-ticker.ts`, `src/test/tui/use-ticker.test.tsx`

**Interfaces:**
- Produces: `useTick(active: boolean): number` (changes every 250 ms while `active`, constant otherwise) and `SPINNER: readonly string[]` (braille frames). One interval total for all active subscribers.

- [ ] **Step 1: Write the failing test**

`src/test/tui/use-ticker.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { mount, type Mounted } from './harness';
import { useTick, SPINNER } from '../../tui/ui/use-ticker';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe({ active }: { active: boolean }) {
  const n = useTick(active);
  return <text>{`tick:${n % SPINNER.length}`}</text>;
}

const countIntervals = async (ui: () => ReturnType<typeof Probe>) => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try { m = await mount(ui() as never); } finally { globalThis.setInterval = real; }
  return started;
};

test('inactive probes start no interval', async () => {
  expect(await countIntervals(() => <box><Probe active={false} /><Probe active={false} /></box> as never)).toBe(0);
});

test('many active probes share one interval', async () => {
  expect(await countIntervals(() => <box><Probe active /><Probe active /><Probe active /></box> as never)).toBe(1);
});

test('the tick advances while active', async () => {
  m = await mount(<Probe active />);
  const first = m.frame();
  await new Promise((r) => setTimeout(r, 600));
  await m.fromHost();
  expect(m.frame() === first).toBe(false);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/use-ticker.test.tsx 2>&1 | tail -6`
Expected: FAIL, cannot find module `use-ticker`.

- [ ] **Step 3: Implement**

`src/tui/ui/use-ticker.ts`:

```ts
import { useEffect, useState } from 'react';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const FRAME_MS = 250;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (timer === undefined) {
    timer = setInterval(() => { for (const s of subscribers) { s(); } }, FRAME_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
}

export function useTick(active: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) { return; }
    return subscribe(() => { setN((x) => x + 1); });
  }, [active]);
  return n;
}
```

If the test's casts (`as never`) are rejected by `check-types:tui`, type `ui` as `() => ReactNode` and drop the casts.

- [ ] **Step 4: Run, then the gates**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/use-ticker.test.tsx 2>&1 | tail -5 && yarn check-types:tui && yarn lint`
Expected: 3 pass, gates clean.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add src/tui/ui/use-ticker.ts src/test/tui/use-ticker.test.tsx && git commit -m "feat: shared ticker for TUI spinners and elapsed time" && git log -1 --format=%B
```

---

### Task 4: `Collapsible` shell

**Files:**
- Create: `src/tui/ui/transcript/collapsible.tsx`, `src/test/tui/collapsible.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` from `../termcn/hooks/use-theme`.
- Produces: `Collapsible({ open: boolean; selected: boolean; header: ReactNode; children?: ReactNode })`.

- [ ] **Step 1: Write the failing tests**

`src/test/tui/collapsible.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { Collapsible } from '../../tui/ui/transcript/collapsible';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const card = (open: boolean, selected = false) => (
  <Collapsible open={open} selected={selected} header={<text>HEADER</text>}>
    <text>BODY</text>
  </Collapsible>
);
const borderFg = () => {
  const span = m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes('┌'));
  return span === undefined ? '' : span.fg.toString();
};

test('closed shows the header and hides the body', async () => {
  m = await mount(card(false));
  expect(m.frame()).toContain('HEADER');
  expect(m.frame().includes('BODY')).toBe(false);
});

test('open shows the body under a divider inside the same border', async () => {
  m = await mount(card(true));
  expect(m.frame()).toContain('BODY');
  expect(m.frame().split('\n').filter((r) => r.includes('─')).length >= 3).toBe(true);
});

test('the border changes colour when selected', async () => {
  m = await mount(card(false, false));
  const idle = borderFg();
  m.destroy();
  m = await mount(card(false, true));
  expect(idle === '').toBe(false);
  expect(borderFg() === idle).toBe(false);
});

test('the card never grows past 100 columns on a wide terminal', async () => {
  m = await mount(card(false), { width: 200, height: 10 });
  const widest = Math.max(...m.frame().split('\n').map((r) => r.trimEnd().length));
  expect(widest <= 100).toBe(true);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/collapsible.test.tsx 2>&1 | tail -6`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

`src/tui/ui/transcript/collapsible.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';

const MAX_WIDTH = 100;

export function Collapsible(props: { open: boolean; selected: boolean; header: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  const border = theme.colors.border;
  return (
    <box
      flexDirection="column"
      maxWidth={MAX_WIDTH}
      border
      borderStyle="single"
      borderColor={props.selected ? theme.colors.primary : border}
    >
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>{props.header}</box>
      {props.open ? (
        <box flexDirection="column" border={['top']} borderStyle="single" borderColor={border} paddingLeft={1} paddingRight={1}>
          {props.children}
        </box>
      ) : null}
    </box>
  );
}
```

- [ ] **Step 4: Run, then gates**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/collapsible.test.tsx 2>&1 | tail -6 && yarn check-types:tui && yarn lint`
Expected: 4 pass. If the "closed card is 100 columns wide" assertion fails because the box stretches to the terminal, keep `maxWidth` and set `alignSelf="flex-start"` only if the stretch is the cause; the assertion bounds the width either way.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add src/tui/ui/transcript/collapsible.tsx src/test/tui/collapsible.test.tsx && git commit -m "feat: controlled collapsible card shell for the TUI" && git log -1 --format=%B
```

---

### Task 5: Tool glyphs and block renderer

**Files:**
- Create: `src/tui/ui/transcript/tool-glyphs.ts`, `src/test/tui/tool-blocks.test.tsx`
- Move: `src/tui/ui/transcript/tool-row.tsx` → `src/tui/ui/transcript/tool-blocks.tsx` (`git mv`), replacing `ToolBody` with `ToolBlocks`
- Modify: `src/tui/ui/transcript/row.tsx` only if it still imports `tool-row` (it should not after Task 2)

**Interfaces:**
- Consumes: `ToolBlock`, `clampLines` from `src/client-core/tool-render.ts`; `useTheme`.
- Produces: `TOOL_GLYPHS: Record<ToolGlyph, string>`; `ToolBlocks({ blocks }: { blocks: ToolBlock[] })`.

- [ ] **Step 1: Write the failing tests**

`src/test/tui/tool-blocks.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import type { ToolBlock } from '../../client-core/tool-render';
import { TOOL_GLYPHS } from '../../tui/ui/transcript/tool-glyphs';
import { ToolBlocks } from '../../tui/ui/transcript/tool-blocks';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const show = async (blocks: ToolBlock[]) => { m = await mount(<ToolBlocks blocks={blocks} />); return m.frame(); };

test('every ToolGlyph maps to exactly one character', () => {
  const glyphs = ['terminal', 'file-pen', 'file-plus', 'file-text', 'search', 'folder-search', 'globe', 'list-todo', 'bot', 'send', 'wrench', 'image'] as const;
  for (const g of glyphs) { expect([...TOOL_GLYPHS[g]].length).toBe(1); }
});

test('a command is drawn behind a $ gutter', async () => {
  expect(await show([{ kind: 'command', text: 'yarn test:unit' }])).toContain('$ yarn test:unit');
});

test('todos show done, in-progress and pending marks', async () => {
  const f = await show([{ kind: 'todos', items: [
    { status: 'completed', text: 'one' }, { status: 'in_progress', text: 'two' }, { status: 'pending', text: 'three' },
  ] }]);
  expect(f).toContain('✓ one');
  expect(f).toContain('◉ two');
  expect(f).toContain('○ three');
});

test('a completed todo is struck through', async () => {
  await show([{ kind: 'todos', items: [{ status: 'completed', text: 'done-item' }] }]);
  const span = m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes('done-item'));
  expect(span !== undefined && (span.attributes & 128) !== 0).toBe(true);
});

test('a field shows label and value, a note is plain text', async () => {
  const f = await show([{ kind: 'field', label: 'glob', value: '*.ts' }, { kind: 'note', text: 'not run yet' }]);
  expect(f).toContain('glob');
  expect(f).toContain('*.ts');
  expect(f).toContain('not run yet');
});

test('a long output is clamped with a hidden-lines divider', async () => {
  const text = Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\n');
  m = await mount(<ToolBlocks blocks={[{ kind: 'lines', text, tone: 'output' }]} />, { width: 100, height: 60 });
  expect(m.frame()).toContain('lines hidden');
});

test('diff lines keep their prefixes and an image is a placeholder', async () => {
  const f = await show([{ kind: 'diff', lines: ['-old', '+new'] }, { kind: 'image', dataUri: 'data:image/png;base64,AA' }]);
  expect(f).toContain('-old');
  expect(f).toContain('+new');
  expect(f).toContain('[image]');
});
```

If `TextAttributes.STRIKETHROUGH` is not `128` in the installed `@opentui/core`, replace the literal with `TextAttributes.STRIKETHROUGH` imported from `@opentui/core` (check `node_modules/@opentui/core/types.d.ts`).

- [ ] **Step 2: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tool-blocks.test.tsx 2>&1 | tail -6`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`tool-glyphs.ts`:

```ts
import type { ToolGlyph } from '../../../client-core/tool-render';

export const TOOL_GLYPHS: Record<ToolGlyph, string> = {
  'terminal': '$', 'file-pen': '✎', 'file-plus': '+', 'file-text': '≡', 'search': '⌕',
  'folder-search': '⌕', 'globe': '◍', 'list-todo': '☰', 'bot': '◆', 'send': '➤', 'wrench': '⚙', 'image': '▣',
};
```

`git mv src/tui/ui/transcript/tool-row.tsx src/tui/ui/transcript/tool-blocks.tsx`, then rewrite it as `ToolBlocks`. Keep the existing `clamped()` helper and the clamp numbers (12 head, 8 tail). Per block kind return `{ text, fg?, attributes? }[]` lines as `blockLines` does today, with these changes: `command` → `$ ${text}`; `todos` → `✓ `/`◉ `/`○ ` prefixes, completed `fg` muted with `TextAttributes.STRIKETHROUGH`, in-progress bold; `image` → `[image]`; muted colour comes from `useTheme().colors.mutedForeground`, diff `+` green and `-` red from `theme.colors.success`/`theme.colors.error`. Export `ToolBlocks({ blocks }: { blocks: ToolBlock[] })` rendering a column of `<text wrapMode="word">` lines. Remove `ToolBody`.

- [ ] **Step 4: Run, then gates**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tool-blocks.test.tsx 2>&1 | tail -6 && yarn check-types:tui && yarn lint`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A src && git commit -m "feat: tool glyphs and block renderer for the TUI cards" && git log -1 --format=%B
```

---

### Task 6: `ToolCard`

**Files:**
- Create: `src/tui/ui/transcript/tool-card.tsx`, `src/test/tui/tool-card.test.tsx`
- Modify: `src/tui/ui/transcript/row.tsx` (tool, non-subagent), `src/test/tui/transcript.test.tsx` (un-skip the tests skipped in Task 2; update assertions)

**Interfaces:**
- Consumes: `Collapsible` (Task 4), `ToolBlocks` and `TOOL_GLYPHS` (Task 5), `useTick`/`SPINNER` (Task 3), `describeTool`/`describeInput`/`describeOutput` (`client-core/tool-render`), `useTheme`.
- Produces: `ToolCard({ item: ToolItem; open: boolean; selected: boolean; headerOnly?: boolean })`.

- [ ] **Step 1: Write the failing tests**

`src/test/tui/tool-card.test.tsx` (use `tool()` from `src/test/fixtures/protocol.ts`, which takes `state: 'running' | 'ok' | 'error'`, `tool`, `output`):

```tsx
import { afterEach, expect, test } from 'bun:test';
import { ToolCard } from '../../tui/ui/transcript/tool-card';
import { tool } from '../fixtures/protocol';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const rowsOf = (f: string) => f.split(/\r?\n/);

test('an ok call shows glyph, verb and path with no status word', async () => {
  m = await mount(<ToolCard item={tool({ state: 'ok' })} open={false} selected={false} />);
  expect(m.frame()).toContain('$');
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).toContain('yarn test:unit');
  expect(m.frame().includes('failed')).toBe(false);
});

test('a failed call shows the failed pill and a red mark', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error' })} open={false} selected={false} />);
  expect(m.frame()).toContain('failed');
  expect(m.frame()).toContain('✗');
});

test('open shows the input, a Result label and the output', async () => {
  m = await mount(<ToolCard item={tool({ output: { kind: 'text', text: 'line one' } })} open selected={false} />);
  expect(m.frame()).toContain('Result');
  expect(m.frame()).toContain('line one');
});

test('an error shows an Error label, a running call shows Running…', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error', output: { kind: 'text', text: 'boom' } })} open selected={false} />);
  expect(m.frame()).toContain('Error');
  m.destroy();
  m = await mount(<ToolCard item={tool({ state: 'running', output: undefined })} open selected={false} />);
  expect(m.frame()).toContain('Running…');
});

test('headerOnly never shows a body or a chevron', async () => {
  m = await mount(<ToolCard item={tool({ output: { kind: 'text', text: 'hidden-body' } })} open selected={false} headerOnly />);
  expect(m.frame().includes('hidden-body')).toBe(false);
  expect(m.frame().includes('▸') || m.frame().includes('▾')).toBe(false);
});

test('a 200-character path keeps the header on one line with the chevron visible at 50 columns', async () => {
  const long = 'x'.repeat(200);
  m = await mount(<ToolCard item={tool({ state: 'error', tool: { kind: 'command', label: 'Bash', command: long } })} open={false} selected={false} />, { width: 50, height: 10 });
  const header = rowsOf(m.frame()).filter((r) => r.includes('Bash'));
  expect(header.length).toBe(1);
  expect(header[0]).toContain('failed');
  expect(header[0]).toContain('▸');
  expect(rowsOf(m.frame()).every((r) => r.trimEnd().length <= 50)).toBe(true);
});

test('a settled call starts no interval, a running one starts exactly one', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try {
    m = await mount(<ToolCard item={tool({ state: 'ok' })} open={false} selected={false} />);
    expect(started).toBe(0);
    m.destroy();
    m = await mount(<ToolCard item={tool({ state: 'running', output: undefined })} open={false} selected={false} />);
    expect(started).toBe(1);
  } finally { globalThis.setInterval = real; }
});

test('an MCP call shows a muted server chip', async () => {
  m = await mount(<ToolCard item={tool({ tool: { kind: 'mcp', label: 'search', server: 'github' } as never })} open={false} selected={false} />);
  expect(m.frame()).toContain('github');
});
```

Check `ToolCall`'s real `mcp` shape in `src/protocol/messages.ts` and replace the `as never` with the real fields.

- [ ] **Step 2: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tool-card.test.tsx 2>&1 | tail -8`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`tool-card.tsx`:

```tsx
import type { TranscriptItem } from '../../../protocol/messages';
import { describeInput, describeOutput, describeTool } from '../../../client-core/tool-render';
import { useTheme } from '../termcn/hooks/use-theme';
import { SPINNER, useTick } from '../use-ticker';
import { Collapsible } from './collapsible';
import { ToolBlocks } from './tool-blocks';
import { TOOL_GLYPHS } from './tool-glyphs';

export type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function ToolCard(props: { item: ToolItem; open: boolean; selected: boolean; headerOnly?: boolean }) {
  const { item } = props;
  const theme = useTheme();
  const header = describeTool(item.tool);
  const running = item.state === 'running';
  const failed = item.state === 'error';
  const tick = useTick(running);
  const server = item.tool.kind === 'mcp' ? item.tool.server : undefined;
  const glyph = running ? SPINNER[tick % SPINNER.length] : failed ? '✗' : TOOL_GLYPHS[header.glyph];
  const input = describeInput(item.tool);
  const output = describeOutput(item.tool.kind, item.output, item.state);
  const open = props.open && props.headerOnly !== true;
  return (
    <Collapsible
      open={open}
      selected={props.selected}
      header={(
        <>
          <text fg={failed ? theme.colors.error : theme.colors.mutedForeground}>{glyph}</text>
          {server ? <text fg={theme.colors.mutedForeground}>{`[${server}]`}</text> : null}
          <text attributes={props.selected ? 1 : 0} flexShrink={0}>{header.verb}</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text fg={theme.colors.mutedForeground} wrapMode="none">{header.primary}</text>
          </box>
          {failed ? <text fg={theme.colors.error} flexShrink={0}>failed</text> : null}
          {props.headerOnly ? null : <text fg={theme.colors.mutedForeground} flexShrink={0}>{props.open ? '▾' : '▸'}</text>}
        </>
      )}
    >
      <ToolBlocks blocks={input} />
      {output.length > 0 ? (
        <>
          <text fg={theme.colors.mutedForeground}>{failed ? 'Error' : 'Result'}</text>
          <ToolBlocks blocks={output} />
        </>
      ) : null}
      {running ? <text fg={theme.colors.mutedForeground}>Running…</text> : null}
    </Collapsible>
  );
}
```

If OpenTUI does not clip the `wrapMode="none"` text inside the `overflow="hidden"` box (the 50-column test shows it), fall back to slicing: compute the available width from `useTerminalDimensions()` and cut `header.primary` to `width - (verb + pill + chevron + borders)` with a trailing `…`; keep the test.

In `row.tsx` the tool case (non-subagent) becomes `<ToolCard item={row.item} open={props.expanded} selected={props.selected} />`, wrapped in a box with `marginBottom={0}`. Remove the temporary one-line header from Task 2.

- [ ] **Step 4: Un-skip and update the transcript tests; run everything**

In `transcript.test.tsx`, remove the `test.skip` markers set in Task 2, and update only assertions that depended on the old row text (`▸ Bash` style text). The behaviour assertions (`line two` appears after `j` + `Enter` and disappears after a second `Enter`; clamped long output shows `lines hidden`; the cursor stays on the same row after a prepend) must stay. If a paging test needs more page-ups because cards are 3 rows, raise the press counts, not the production logic.
Run: `cd /e/Efebia/hiiiid-code && yarn check-types:tui && yarn lint && yarn test:tui`
Expected: all pass (including the 182-test baseline plus new ones).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A src && git commit -m "feat: webview-style tool cards in the TUI transcript" && git log -1 --format=%B
```

---

### Task 7: `SubagentCard` and the expansion state

**Files:**
- Create: `src/tui/ui/transcript/subagent-card.tsx`, `src/test/tui/subagent-card.test.tsx`
- Modify: `src/tui/ui/transcript/row.tsx`, `src/tui/ui/transcript/transcript.tsx`, `src/test/tui/transcript.test.tsx`

**Interfaces:**
- Consumes: Task 6's `ToolCard`/`ToolItem`, Task 4's `Collapsible`, Task 3's `useTick`, and from `src/client-core/subagent-window.ts`: `summarizeSubagent`, `windowChildren`, `formatElapsed`, `isBackgroundDispatch`, `subagentLabel`.
- Produces: `SubagentCard({ item: ToolItem; open: boolean; userClosed: boolean; selected: boolean })`; the card's effective state is `open || (blocked && !userClosed)`. `RowView` gains a `closed: boolean` prop. `Transcript` keeps `open` and a `closed` set.

- [ ] **Step 1: Write the failing tests**

`src/test/tui/subagent-card.test.tsx` (fixtures: `tool()` and `permission()` from `src/test/fixtures/protocol.ts`; build a subagent with `tool({ tool: { kind: 'subagent', label: 'Task', agent: 'Explore' } as never, children: [...] })`, replacing `as never` with the real `subagent` shape from `src/protocol/messages.ts`):

```tsx
import { afterEach, expect, test } from 'bun:test';
import { SubagentCard } from '../../tui/ui/transcript/subagent-card';
import { permission, tool } from '../fixtures/protocol';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const kids = (n: number) => Array.from({ length: n }, (_, i) => tool({ id: `k${i}`, toolId: `tk${i}`, ts: 10 + i }));
const agent = (over: Record<string, unknown> = {}) =>
  tool({ id: 'sa', ts: 1, state: 'ok', tool: { kind: 'subagent', label: 'Task', agent: 'Explore' } as never, children: kids(3), ...over });

test('the collapsed header shows the label, the tool count and the elapsed time', async () => {
  m = await mount(<SubagentCard item={agent()} open={false} userClosed={false} selected={false} />);
  expect(m.frame()).toContain('Explore');
  expect(m.frame()).toContain('3 tools');
  expect(m.frame()).toMatch(/\d+s/);
});

test('a background dispatch says it runs in the background', async () => {
  m = await mount(<SubagentCard item={agent({ tool: { kind: 'subagent', label: 'Task', agent: 'Explore', background: true }, children: [] })} open={false} userClosed={false} selected={false} />);
  expect(m.frame()).toContain('Running in background');
  expect(m.frame().includes('0 tools')).toBe(false);
});

test('zero children shows 0 tools without crashing when opened', async () => {
  m = await mount(<SubagentCard item={agent({ children: [] })} open userClosed={false} selected={false} />);
  expect(m.frame()).toContain('0 tools');
});

test('open shows child cards, header only, and windows to the last 10 with a note', async () => {
  m = await mount(<SubagentCard item={agent({ children: kids(14) })} open userClosed={false} selected={false} />, { width: 100, height: 60 });
  expect(m.frame()).toContain('showing last 10 of 14');
  expect(m.frame().split('\n').filter((r) => r.includes('Bash')).length).toBe(10);
});

test('a blocked subagent forces itself open until the user closed it', async () => {
  const blocked = agent({ state: 'running', children: [...kids(1), permission({ id: 'pp', state: 'pending' })] });
  m = await mount(<SubagentCard item={blocked} open={false} userClosed={false} selected={false} />);
  expect(m.frame()).toContain('Needs you');
  expect(m.frame().includes('Bash')).toBe(true);
  m.destroy();
  m = await mount(<SubagentCard item={blocked} open={false} userClosed selected={false} />);
  expect(m.frame()).toContain('Needs you');
  expect(m.frame().split('\n').filter((r) => r.includes('Bash')).length).toBe(0);
});

test('a settled closed subagent starts no interval', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try { m = await mount(<SubagentCard item={agent()} open={false} userClosed={false} selected={false} />); } finally { globalThis.setInterval = real; }
  expect(started).toBe(0);
});
```

(`toMatch` is available in `bun:test`; if the TUI assert checker rejects it, use `expect(/\d+s/.test(m.frame())).toBe(true)`.)

Add to `transcript.test.tsx` (feed the subagent through `withItems`):

```tsx
test('Enter toggles a subagent and a user collapse sticks while it is still blocked', async () => {
  // build a running subagent with a pending permission child via withItems, mount <Transcript focused />,
  // assert the child tool header is visible (forced open), press j then return, assert it is hidden,
  // re-deliver the same items with fromHost(withItems(...)) and assert it stays hidden.
});
```

Fill that test in fully: it must use only `withItems`, `m.press('j')`, `m.press('return')`, `m.fromHost(...)` and frame assertions.

- [ ] **Step 2: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/subagent-card.test.tsx 2>&1 | tail -8`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`subagent-card.tsx`: a `Collapsible` whose header is, in order, the chevron (`▾` when expanded else `▸`), `subagentLabel(item)` (bold, shrink 0), a muted summary (`Running in background` when `isBackgroundDispatch(item)`, else `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} · ${formatElapsed(elapsedMs)}` plus ` · ${model}` when `item.tool.kind === 'subagent' && item.tool.model`), a flexible spacer, and `Needs you` (primary colour) when `summary.blocked`. `const summary = summarizeSubagent(item, now)` with `now = Date.now()` re-read each render; `useTick(item.state === 'running' && expanded)` re-renders it (a closed card shows a frozen elapsed, and a settled card's elapsed comes from its last child, so neither needs a timer). Body: when `children.length > shown.length` a muted `showing last ${shown.length} of ${children.length}` line; then for each windowed child: a `tool` child → `<ToolCard item={child} open={false} selected={false} headerOnly />`; a `permission` child → one `<text>` with a warning-coloured `? ` span and `${describeTool(child.tool).verb} ${describeTool(child.tool).primary} — ${child.state}`. `expanded = props.open || (summary.blocked && !props.userClosed)`.

`row.tsx`: `RowView` takes `closed: boolean`; the tool case renders `<SubagentCard .../>` when `row.item.tool.kind === 'subagent'`, else `<ToolCard .../>`.

`transcript.tsx`: add `const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())`. In the `toggle-item` branch, for a tool row compute `blocked = summarizeSubagent(row.item, 0).blocked` (only for subagent rows) and `effective = open.has(id) || (blocked && !closed.has(id))`; if `effective`: remove from `open`, and if `blocked` add to `closed`; else add to `open` and remove from `closed`. Pass `closed={closed.has(row.id)}` to `RowView`.

- [ ] **Step 4: Run, then the gates**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/subagent-card.test.tsx src/test/tui/transcript.test.tsx 2>&1 | tail -8 && yarn check-types:tui && yarn lint && yarn test:tui`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A src && git commit -m "feat: subagent cards in the TUI transcript" && git log -1 --format=%B
```

---

### Task 8: Cleanup, docs and final gates

**Files:**
- Delete: `src/tui/ui/termcn/components/ui/tool-call.tsx`
- Modify: `src/tui/ui/termcn/PATCHES.md`, `docs/tui.md`, `AGENTS.md`

- [ ] **Step 1: Remove the unused termcn item**

Run: `cd /e/Efebia/hiiiid-code && grep -rn "tool-call" src --include=*.ts --include=*.tsx | grep -v termcn/components/ui/tool-call.tsx`
Expected: no remaining importers. Then `git rm src/tui/ui/termcn/components/ui/tool-call.tsx` and delete every `tool-call.tsx` row from `PATCHES.md` (the timer, row-direction, name-colour and whitespace rows; for the whitespace row keep the other files it names and drop `tool-call.tsx` from its list).

- [ ] **Step 2: Docs**

`docs/tui.md`: add to the smoke checklist: `- [ ] A subagent run shows a card with a tool count and elapsed time, and a blocked one opens itself and shows "Needs you".`, `- [ ] A failed tool shows the "failed" pill; the card borders stay legible on a light terminal.` Note in the Keys table row for `j / k, Enter` (transcript) that it moves between cards. `AGENTS.md` path table: add rows for `src/tui/ui/transcript/` (`collapsible.tsx`, `tool-card.tsx`, `subagent-card.tsx`, `tool-blocks.tsx`: webview-parity cards built on `client-core/tool-render` and `client-core/subagent-window`) and `src/tui/ui/use-ticker.ts` (the one shared animation interval).

- [ ] **Step 3: Run every gate**

Run, each pinned: `cd /e/Efebia/hiiiid-code && yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit` (re-run once on `listen EACCES`), `yarn test:dom`.
Expected: all pass. `git status --short` is clean after the commit and `ls "$TEMP"` has no leftover probe files from this plan.

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && git add -A docs src AGENTS.md && git commit -m "docs: document the TUI tool and subagent cards" && git log -1 --format=%B
```

- [ ] **Step 5: Final report**

Print the commit list (`git log --oneline` since the spec commit `69b34a5`), the test counts, every deviation from this plan with the reason, and what you could not check (real-terminal appearance on dark and light themes, a real subagent run).
