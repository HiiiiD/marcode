# TUI Awareness, Slice 1: Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a session's context share in the TUI status line and open a context dialog (window line, slice breakdown, memory files) from `/context`, `Ctrl+T`, or a click on the share.

**Architecture:** Pure formatting moves into `src/client-core/` (`format-tokens.ts`, `context-format.ts`) so the webview and the TUI share it. The status line's text and click range come from one pure function in `src/tui/view/status-line.ts`. The dialog follows `model-dialog.tsx`, is opened through the existing `PickerKind` plumbing (extended with `'context'`), and reads `contextBySession`, which the reducer already fills from `context-breakdown`. No protocol or host changes.

**Tech Stack:** TypeScript, OpenTUI React, Bun test (`yarn test:tui`), mocha (`yarn test:unit`).

**Spec:** `docs/superpowers/specs/2026-10-02-tui-awareness-design.md` (Slice 1 sections). Slice 2 (usage strip, relocation cards) gets its own plan.

## Global Constraints

- Every share is a percentage. The only token count anywhere is the dialog's window line `usedTokens of windowTokens tokens`, shown only when the provider reported both. The webview's "Token usage" section is deliberately not ported.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM; the TUI never imports `src/webview/`.
- The webview keeps compiling and behaving the same: it re-imports `DANGER_PERCENT` and `formatTokens` from their new homes.
- Every session-addressed message carries a `SessionId` (`request-context { id }`).
- Filenames are kebab-case. Comments only for non-obvious why.
- TUI tests never hand a renderer or renderable to an assertion; no fixed sleeps (use the harness's `press`/`fromHost`, which settle themselves). `src/test/unit/tui-*.test.ts` is mocha, `src/test/tui/*.test.tsx` is `bun test`.
- Run the guarded scripts: `yarn test:unit`, `yarn test:tui`. Gate before every commit that touches shared code: `yarn lint`, `yarn check-types`, `yarn check-types:tui`.
- `Ctrl+T` is the chord. OpenTUI's textarea binds `a b d e f k o p s u w` with Ctrl, and the app binds `b n c p e r w j x`; `t` is free in both.
- A foreign session (`summary.owner` set) is read-only in the TUI: no context chord or click for it, same rule as the pickers.

## Review Focus

- `contextPercent` undefined: no `ctx` segment and no click target, never `ctx NaN%` or `ctx 0%`.
- `request-context` answered `ok: false`: the reason shows, `r` retries, and no breakdown field is read.
- A breakdown without `usedTokens`/`windowTokens`: no window line at all, never a lone token number.
- Odd percentages from a provider (sum not 100, above 100, negative, fractional, all zero): clamped and rounded, bar width stays exactly the configured width, a nonzero slice never vanishes.
- Very long memory path and a narrow terminal: the basename survives, the status line drops the hint first, then `ctx`, then ellipsizes.
- The session disappearing while the dialog is open (hidden or deleted): the dialog renders nothing and closes rather than crashing or spinning on `Loading…`.

## File Structure

- Create `src/client-core/format-tokens.ts`: `formatTokens` (moved verbatim from the webview).
- Create `src/client-core/context-format.ts`: `DANGER_PERCENT`, `clampPercent`, `contextModel`, `stackedBar`, `fitPath`, `headerLabel`.
- Modify `src/webview/format.ts` and `src/webview/components/context-dialog.tsx`: import from the new modules.
- Create `src/tui/view/status-line.ts`: `PICKER_HINT`, `statusLayout`, `hitsContext`.
- Modify `src/tui/ui/status-line.tsx`: render the layout, red `ctx` span, click handler.
- Modify `src/tui/keymap.ts`: `open-context` on `Ctrl+T`.
- Modify `src/tui/view/pickers.ts`: `PickerKind` gains `'context'`; `parsePickerCommand` accepts `/context`.
- Modify `src/tui/ui/use-app-keys.ts` and `src/tui/ui/app.tsx`: route the action, mount the dialog, pass the click handler.
- Create `src/tui/ui/context-dialog.tsx`: the dialog.
- Tests: `src/test/unit/tui-context-format.test.ts`, `src/test/unit/tui-status-layout.test.ts`, extend `src/test/unit/tui-keymap.test.ts` and `src/test/unit/tui-pickers.test.ts`, `src/test/tui/context-dialog.test.tsx`, extend `src/test/tui/status-line.test.tsx`, `src/test/tui/context-open.test.tsx`.
- Docs: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`.

---

### Task 1: Move shared formatting into client-core

**Files:**
- Create: `src/client-core/format-tokens.ts`, `src/client-core/context-format.ts`
- Modify: `src/webview/format.ts`, `src/webview/components/context-dialog.tsx`
- Test: `src/test/unit/tui-context-format.test.ts`

**Interfaces:**
- Produces (used by Tasks 2 and 4):
  ```ts
  export function formatTokens(n: number): string                      // client-core/format-tokens.ts
  export const DANGER_PERCENT = 80                                      // client-core/context-format.ts
  export function clampPercent(percent: number): number
  export type SliceKey = 'system' | 'memory' | 'conversation' | 'free'
  export interface ContextModel {
    slices: { key: SliceKey; label: string; percent: number }[]
    memoryFiles: { path: string; percent: string }[]
    window?: string
  }
  export function contextModel(b: ContextBreakdown): ContextModel
  export function stackedBar(slices: { key: SliceKey; percent: number }[], width: number): { key: SliceKey; cells: number }[]
  export function fitPath(path: string, width: number): string
  export function headerLabel(percent: number | undefined): { text: string; danger: boolean }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/tui-context-format.test.ts`:

```ts
import * as assert from 'node:assert';
import {
  clampPercent, contextModel, DANGER_PERCENT, fitPath, headerLabel, stackedBar,
} from '../../client-core/context-format';
import { formatTokens } from '../../client-core/format-tokens';
import { breakdown } from '../fixtures/protocol';

const sum = (cells: { cells: number }[]) => cells.reduce((n, c) => n + c.cells, 0);

suite('context-format: model', () => {
  test('slices come in fixed order and are clamped and rounded', () => {
    const m = contextModel(breakdown({ systemPercent: 12.4, memoryPercent: -3, conversationPercent: 140, freePercent: 57 }));
    assert.deepStrictEqual(m.slices.map((s) => [s.key, s.percent]), [
      ['system', 12], ['memory', 0], ['conversation', 100], ['free', 57],
    ]);
  });
  test('a memory file under 1% reads <1%, never 0%', () => {
    const m = contextModel(breakdown({ memoryFiles: [{ path: '/a/CLAUDE.md', percent: 0 }, { path: '/b/X.md', percent: 3 }] }));
    assert.deepStrictEqual(m.memoryFiles.map((f) => f.percent), ['<1%', '3%']);
  });
  test('the window line needs both token fields', () => {
    assert.strictEqual(contextModel(breakdown({ usedTokens: 43000, windowTokens: 258000 })).window, '43K of 258K tokens');
    assert.strictEqual(contextModel(breakdown({ usedTokens: 43000 })).window, undefined);
    assert.strictEqual(contextModel(breakdown({ windowTokens: 258000 })).window, undefined);
    assert.strictEqual(contextModel(breakdown()).window, undefined);
  });
});

suite('context-format: stacked bar', () => {
  const four = (s: number, m: number, c: number, f: number) => [
    { key: 'system' as const, percent: s }, { key: 'memory' as const, percent: m },
    { key: 'conversation' as const, percent: c }, { key: 'free' as const, percent: f },
  ];
  test('cells always add up to the width', () => {
    for (const w of [10, 33, 40]) {
      assert.strictEqual(sum(stackedBar(four(12, 4, 27, 57), w)), w);
      assert.strictEqual(sum(stackedBar(four(33, 33, 33, 1), w)), w);
    }
  });
  test('a nonzero slice never rounds away, and a zero slice gets no cell', () => {
    const cells = stackedBar(four(0, 0, 2, 98), 20);
    assert.strictEqual(cells.find((c) => c.key === 'conversation')!.cells >= 1, true);
    assert.strictEqual(cells.find((c) => c.key === 'system')!.cells, 0);
    assert.strictEqual(sum(cells), 20);
  });
  test('all zeros draw an empty bar of the same width', () => {
    const cells = stackedBar(four(0, 0, 0, 0), 20);
    assert.strictEqual(sum(cells), 0);
  });
});

suite('context-format: paths, header, tokens', () => {
  test('fitPath keeps the basename and trims the front', () => {
    assert.strictEqual(fitPath('/repo/CLAUDE.md', 40), '/repo/CLAUDE.md');
    assert.strictEqual(fitPath('/very/long/dir/name/CLAUDE.md', 14), '…name/CLAUDE.md');
    assert.strictEqual(fitPath('/x/y.md', 1), '…');
  });
  test('header is unavailable without a percent and dangerous at 80', () => {
    assert.deepStrictEqual(headerLabel(undefined), { text: 'unavailable', danger: false });
    assert.deepStrictEqual(headerLabel(DANGER_PERCENT - 1), { text: '79% used', danger: false });
    assert.deepStrictEqual(headerLabel(DANGER_PERCENT), { text: '80% used', danger: true });
  });
  test('clampPercent bounds and rounds', () => {
    assert.strictEqual(clampPercent(-5), 0);
    assert.strictEqual(clampPercent(100.6), 100);
    assert.strictEqual(clampPercent(41.5), 42);
  });
  test('formatTokens is the webview formatter, moved', () => {
    assert.strictEqual(formatTokens(999), '999');
    assert.strictEqual(formatTokens(258000), '258K');
  });
});
```

Note `fitPath('/very/long/dir/name/CLAUDE.md', 14)` is `…` plus the last 14 characters; adjust the literal if the character count differs, keeping the rule "ellipsis plus the trailing `width` characters" (the last 14 characters of that path are `name/CLAUDE.md`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "context-format"`
Expected: FAIL, cannot find module `client-core/context-format`.

- [ ] **Step 3: Implement**

Create `src/client-core/format-tokens.ts` (moved from `src/webview/format.ts` lines 7-18, verbatim):

```ts
const compactTokens = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return compactTokens.format(n);
}
```

Replace the tail of `src/webview/format.ts` so the file is:

```ts
/** Last path segment. The full path lives in a title; 300px has no room for it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export { formatTokens } from '../client-core/format-tokens';
```

Create `src/client-core/context-format.ts`:

```ts
import type { ContextBreakdown } from '../providers/types';
import { formatTokens } from './format-tokens';

/** Above this share of the window, colour alone stops carrying the signal. */
export const DANGER_PERCENT = 80;

export type SliceKey = 'system' | 'memory' | 'conversation' | 'free';

export interface ContextModel {
  slices: { key: SliceKey; label: string; percent: number }[];
  memoryFiles: { path: string; percent: string }[];
  window?: string;
}

/** A provider reports a percentage; nothing guarantees it is one. */
export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function contextModel(b: ContextBreakdown): ContextModel {
  const window = b.usedTokens !== undefined && b.windowTokens !== undefined
    ? `${formatTokens(b.usedTokens)} of ${formatTokens(b.windowTokens)} tokens`
    : undefined;
  return {
    slices: [
      { key: 'system', label: 'System prompt', percent: clampPercent(b.systemPercent) },
      { key: 'memory', label: 'Memory', percent: clampPercent(b.memoryPercent) },
      { key: 'conversation', label: 'Conversation', percent: clampPercent(b.conversationPercent) },
      { key: 'free', label: 'Free', percent: clampPercent(b.freePercent) },
    ],
    // A listed file rounding to 0 is present but tiny, never "nothing".
    memoryFiles: b.memoryFiles.map((f) => {
      const p = clampPercent(f.percent);
      return { path: f.path, percent: p === 0 ? '<1%' : `${p}%` };
    }),
    ...(window ? { window } : {}),
  };
}

/** Largest-remainder split of `width` cells; a nonzero slice keeps at least one cell. */
export function stackedBar(slices: { key: SliceKey; percent: number }[], width: number): { key: SliceKey; cells: number }[] {
  const total = slices.reduce((n, s) => n + s.percent, 0);
  if (total <= 0 || width <= 0) { return slices.map((s) => ({ key: s.key, cells: 0 })); }
  const raw = slices.map((s) => (s.percent / total) * width);
  const cells = raw.map(Math.floor);
  let left = width - cells.reduce((n, c) => n + c, 0);
  const byFraction = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (const { i } of byFraction) {
    if (left <= 0) { break; }
    cells[i] += 1;
    left -= 1;
  }
  slices.forEach((s, i) => {
    if (s.percent > 0 && cells[i] === 0) {
      const donor = cells.indexOf(Math.max(...cells));
      cells[donor] -= 1;
      cells[i] = 1;
    }
  });
  return slices.map((s, i) => ({ key: s.key, cells: cells[i] }));
}

/** The identifying end of a path is its tail, so the front gives way. */
export function fitPath(path: string, width: number): string {
  if (path.length <= width) { return path; }
  return width <= 1 ? '…' : `…${path.slice(-width)}`;
}

export function headerLabel(percent: number | undefined): { text: string; danger: boolean } {
  if (percent === undefined) { return { text: 'unavailable', danger: false }; }
  return { text: `${percent}% used`, danger: percent >= DANGER_PERCENT };
}
```

In `src/webview/components/context-dialog.tsx` replace the local `DANGER_PERCENT` declaration (and its doc comment, lines 10-11) and the local `clampPercent` with imports, keeping the webview's own `formatPercent`:

```ts
import { clampPercent, DANGER_PERCENT } from "../../client-core/context-format";
export { DANGER_PERCENT };
```

(`context-ring.tsx` imports `DANGER_PERCENT` from `./context-dialog`; the re-export keeps it working.) Delete the local `function clampPercent` block.

- [ ] **Step 4: Run to verify it passes and nothing regressed**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit` then `yarn test:dom` then `yarn check-types`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client-core src/webview/format.ts src/webview/components/context-dialog.tsx src/test/unit/tui-context-format.test.ts
git commit -m "feat: share context and token formatting through client-core"
```

---

### Task 2: Status-line context share

**Files:**
- Create: `src/tui/view/status-line.ts`
- Modify: `src/tui/ui/status-line.tsx`
- Test: `src/test/unit/tui-status-layout.test.ts`, `src/test/tui/status-line.test.tsx`

**Interfaces:**
- Consumes: `DANGER_PERCENT`, `clampPercent` from `client-core/context-format`.
- Produces:
  ```ts
  export const PICKER_HINT: string
  export interface StatusLayout { text: string; ctx?: { start: number; end: number; danger: boolean } }
  export function statusLayout(o: {
    provider: string; model?: string; effort?: string; permissionMode?: string;
    contextPercent?: number; owned: boolean; width: number;
  }): StatusLayout
  export function hitsContext(layout: StatusLayout, x: number): boolean
  ```
  and `StatusLine` gains an optional prop `onOpenContext?(): void`.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/tui-status-layout.test.ts`:

```ts
import * as assert from 'node:assert';
import { hitsContext, PICKER_HINT, statusLayout } from '../../tui/view/status-line';

const base = { provider: 'Fake', model: 'fake-large', effort: 'high', permissionMode: 'plan', owned: true };
const HEAD = 'Fake · fake-large · high · plan';

suite('tui status layout', () => {
  test('without a context percent there is no ctx segment', () => {
    const l = statusLayout({ ...base, width: 200 });
    assert.strictEqual(l.ctx, undefined);
    assert.strictEqual(l.text.includes('ctx'), false);
  });
  test('ctx follows the head and the hint follows ctx', () => {
    const l = statusLayout({ ...base, contextPercent: 42, width: 200 });
    assert.strictEqual(l.text, `${HEAD} · ctx 42%   ${PICKER_HINT}`);
    assert.deepStrictEqual(l.ctx, { start: HEAD.length + 3, end: HEAD.length + 3 + 'ctx 42%'.length, danger: false });
  });
  test('80 and above is danger', () => {
    assert.strictEqual(statusLayout({ ...base, contextPercent: 80, width: 200 }).ctx?.danger, true);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 79, width: 200 }).ctx?.danger, false);
  });
  test('the hint goes first, then ctx, then the head is ellipsized', () => {
    const noHint = `${HEAD} · ctx 42%`;
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: noHint.length }).text, noHint);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: HEAD.length }).text, HEAD);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: HEAD.length }).ctx, undefined);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: 12 }).text, 'Fake · fake…');
  });
  test('a foreign session gets no hint but keeps ctx', () => {
    const l = statusLayout({ ...base, contextPercent: 42, owned: false, width: 200 });
    assert.strictEqual(l.text, `${HEAD} · ctx 42%`);
  });
  test('out-of-range percents are clamped', () => {
    assert.strictEqual(statusLayout({ ...base, contextPercent: 250, width: 200 }).text.includes('ctx 100%'), true);
    assert.strictEqual(statusLayout({ ...base, contextPercent: -4, width: 200 }).text.includes('ctx 0%'), true);
  });
  test('hitsContext is true only inside the ctx segment', () => {
    const l = statusLayout({ ...base, contextPercent: 42, width: 200 });
    const s = l.ctx!.start;
    assert.strictEqual(hitsContext(l, s - 1), false);
    assert.strictEqual(hitsContext(l, s), true);
    assert.strictEqual(hitsContext(l, l.ctx!.end - 1), true);
    assert.strictEqual(hitsContext(l, l.ctx!.end), false);
    assert.strictEqual(hitsContext(statusLayout({ ...base, width: 200 }), 0), false);
  });
});
```

Append to `src/test/tui/status-line.test.tsx`:

```tsx
test('shows the context share when the session reports one', async () => {
  const s = summary('s1', { contextPercent: 42 });
  m = await mount(<StatusLine sessionId="s1" width={120} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
  expect(m.frame()).toContain('ctx 42%');
});

test('shows no ctx segment without a reading', async () => {
  m = await mount(<StatusLine sessionId="s1" width={120} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame().includes('ctx')).toBe(false);
});

test('a click on the share opens the context dialog, a click elsewhere does not', async () => {
  let opened = 0;
  const s = summary('s1', { contextPercent: 42 });
  m = await mount(<StatusLine sessionId="s1" width={120} onOpenContext={() => { opened++; }} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
  const rows = m.frame().split('\n');
  const y = rows.findIndex((r) => r.includes('ctx 42%'));
  const x = rows[y]!.indexOf('ctx 42%');
  await act(async () => { await m!.setup.mockMouse.click(0, y); });
  expect(opened).toBe(0);
  await act(async () => { await m!.setup.mockMouse.click(x + 1, y); });
  expect(opened).toBe(1);
});
```

Add `import { act } from 'react';` at the top of that test file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "status layout"` and `yarn test:tui src/test/tui/status-line.test.tsx`
Expected: FAIL, module `tui/view/status-line` missing; new TUI tests fail.

- [ ] **Step 3: Implement**

Create `src/tui/view/status-line.ts`:

```ts
import { clampPercent, DANGER_PERCENT } from '../../client-core/context-format';

export const PICKER_HINT = '^P model · ^E effort · ⇧Tab mode · ^T context';

export interface StatusLayout { text: string; ctx?: { start: number; end: number; danger: boolean } }

interface StatusInput {
  provider: string; model?: string; effort?: string; permissionMode?: string;
  contextPercent?: number; owned: boolean; width: number;
}

export function statusLayout(o: StatusInput): StatusLayout {
  const head = [o.provider, o.model, o.effort, o.permissionMode].filter((p): p is string => Boolean(p)).join(' · ');
  const shown = o.contextPercent === undefined ? undefined : clampPercent(o.contextPercent);
  const ctx = shown === undefined ? undefined : `ctx ${shown}%`;
  const withCtx = ctx ? `${head} · ${ctx}` : head;
  const candidates: { text: string; hasCtx: boolean }[] = [];
  if (o.owned) { candidates.push({ text: `${withCtx}   ${PICKER_HINT}`, hasCtx: ctx !== undefined }); }
  if (ctx) { candidates.push({ text: withCtx, hasCtx: true }); }
  candidates.push({ text: head, hasCtx: false });
  const fit = candidates.find((c) => c.text.length <= o.width);
  if (!fit) {
    return { text: `${head.slice(0, Math.max(0, o.width - 1))}…` };
  }
  if (!fit.hasCtx || !ctx || shown === undefined) { return { text: fit.text }; }
  const start = head.length + 3;
  return { text: fit.text, ctx: { start, end: start + ctx.length, danger: shown >= DANGER_PERCENT } };
}

export function hitsContext(layout: StatusLayout, x: number): boolean {
  return layout.ctx !== undefined && x >= layout.ctx.start && x < layout.ctx.end;
}
```

Replace `src/tui/ui/status-line.tsx` with:

```tsx
import type { SessionId } from '../../protocol/messages';
import { hitsContext, statusLayout } from '../view/status-line';
import { useTuiStore } from './store';

export function StatusLine({ sessionId, width, onOpenContext }: { sessionId: SessionId | null; width: number; onOpenContext?(): void }) {
  const { state } = useTuiStore();
  const summarizing = Object.entries(state.handoffPhase).find(([, phase]) => phase === 'summarizing')?.[0];
  if (summarizing) {
    const src = state.sessions.find((x) => x.id === summarizing);
    return <text fg="gray">{`Summarizing ${src ? src.name || src.title : summarizing}…`}</text>;
  }
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg="gray">no session — Ctrl+N new</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const layout = statusLayout({
    provider, model: s.model, effort: s.effort, permissionMode: s.permissionMode,
    contextPercent: s.contextPercent, owned: !s.owner, width,
  });
  const { ctx, text } = layout;
  const onMouseDown = onOpenContext
    ? (e: { x: number }) => { if (hitsContext(layout, e.x)) { onOpenContext(); } }
    : undefined;
  if (!ctx) { return <text fg="gray" onMouseDown={onMouseDown}>{text}</text>; }
  return (
    <text fg="gray" onMouseDown={onMouseDown}>
      {text.slice(0, ctx.start)}
      <span fg={ctx.danger ? 'red' : 'gray'}>{text.slice(ctx.start, ctx.end)}</span>
      {text.slice(ctx.end)}
    </text>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "status layout"`, `yarn test:tui`, `yarn check-types:tui`
Expected: PASS, including the three pre-existing status-line tests (the new hint still contains `^P model · ^E effort · ⇧Tab mode`; if the width-100 hint test now truncates, widen that test's mount to 120).

- [ ] **Step 5: Commit**

```bash
git add src/tui/view/status-line.ts src/tui/ui/status-line.tsx src/test/unit/tui-status-layout.test.ts src/test/tui/status-line.test.tsx
git commit -m "feat: show the context share in the TUI status line"
```

---

### Task 3: The dialog

**Files:**
- Create: `src/tui/ui/context-dialog.tsx`
- Test: `src/test/tui/context-dialog.test.tsx`

**Interfaces:**
- Consumes: `contextModel`, `stackedBar`, `fitPath`, `headerLabel`, `SliceKey` from `client-core/context-format`; `useTuiStore` (`state.contextBySession`, `post`); `Dialog` from `./termcn/components/ui/dialog`.
- Produces: `export function ContextDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void })`.

- [ ] **Step 1: Write the failing tests**

Create `src/test/tui/context-dialog.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { ContextDialog } from '../../tui/ui/context-dialog';
import { breakdown, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const requests = () => (m?.posted ?? []).filter((p) => p.t === 'request-context');
const open = async (percent: number | undefined = 42, onClose = () => {}) => {
  const s = summary('s1', percent === undefined ? {} : { contextPercent: percent });
  m = await mount(<ContextDialog sessionId="s1" onClose={onClose} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
};
const answer = (result: { ok: true; breakdown: ReturnType<typeof breakdown> } | { ok: false; reason: string }) =>
  m!.fromHost({ t: 'context-breakdown', id: 's1', result });

test('asks the host for the breakdown of its session once on open', async () => {
  await open();
  expect(requests().length).toBe(1);
  const r = requests()[0];
  expect(r?.t === 'request-context' && r.id).toBe('s1');
});

test('shows a loading line until the answer arrives', async () => {
  await open();
  expect(m!.frame()).toContain('Loading');
});

test('renders the header, slices and memory files from the breakdown', async () => {
  await open(42);
  await answer({ ok: true, breakdown: breakdown() });
  const f = m!.frame();
  expect(f).toContain('Context');
  expect(f).toContain('42% used');
  expect(f).toContain('System prompt');
  expect(f).toContain('12%');
  expect(f).toContain('Free');
  expect(f).toContain('57%');
  expect(f).toContain('/repo/CLAUDE.md');
  expect(f).toContain('3%');
});

test('quotes the window once when the provider reported both fields', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ usedTokens: 43000, windowTokens: 258000 }) });
  expect(m!.frame()).toContain('43K of 258K tokens');
});

test('no window line when the provider reported neither', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown() });
  expect(m!.frame().includes('tokens')).toBe(false);
});

test('says when no memory file was loaded', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ memoryFiles: [] }) });
  expect(m!.frame()).toContain('No memory files loaded');
});

test('an unavailable reading says so in the header', async () => {
  await open(undefined);
  await answer({ ok: true, breakdown: breakdown() });
  expect(m!.frame()).toContain('unavailable');
});

test('an error shows its reason and r asks again', async () => {
  await open();
  await answer({ ok: false, reason: 'provider offline' });
  expect(m!.frame()).toContain('provider offline');
  await m!.press('r');
  expect(requests().length).toBe(2);
});

test('r does nothing while a good breakdown is shown', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown() });
  await m!.press('r');
  expect(requests().length).toBe(1);
});

test('odd percentages are clamped without breaking the layout', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ systemPercent: 140, memoryPercent: -2, conversationPercent: 0, freePercent: 0 }) });
  expect(m!.frame()).toContain('100%');
  expect(m!.frame().includes('-2%')).toBe(false);
});

test('Esc closes', async () => {
  let closed = 0;
  await open(42, () => { closed++; });
  await m!.press('escape');
  await settleEscape();
  expect(closed).toBe(1);
});

test('a session that is gone closes the dialog instead of spinning', async () => {
  let closed = 0;
  await open(42, () => { closed++; });
  await m!.fromHost({ t: 'sessions-changed', sessions: [] });
  expect(closed).toBe(1);
  expect(m!.frame().includes('Loading')).toBe(false);
});
```

If `sessions-changed`'s payload differs from `{ sessions: [] }`, build it with the helper used in `src/test/tui/roster.test.tsx` for a hide/delete (grep `sessions-changed` in `src/test/tui`); the assertion stays the same.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui src/test/tui/context-dialog.test.tsx`
Expected: FAIL, cannot resolve `../../tui/ui/context-dialog`.

- [ ] **Step 3: Implement**

Create `src/tui/ui/context-dialog.tsx`:

```tsx
import { useKeyboard } from '@opentui/react';
import { useEffect } from 'react';
import { contextModel, fitPath, headerLabel, stackedBar, type SliceKey } from '../../client-core/context-format';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';

const BAR_WIDTH = 40;
const PERCENT_COL = 5;
const GLYPH: Record<SliceKey, string> = { system: '█', memory: '▓', conversation: '▒', free: '░' };
const COLOR: Record<SliceKey, string> = { system: 'cyan', memory: 'blue', conversation: 'white', free: 'gray' };

export function ContextDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void }) {
  const { state, post } = useTuiStore();
  const summary = state.byId[sessionId]?.summary ?? state.sessions.find((s) => s.id === sessionId);
  const result = state.contextBySession[sessionId];
  const present = summary !== undefined;

  useEffect(() => { post({ t: 'request-context', id: sessionId }); }, [sessionId, post]);
  useEffect(() => { if (!present) { onClose(); } }, [present, onClose]);

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    if (key.name === 'r' && result?.ok === false) { post({ t: 'request-context', id: sessionId }); }
  });

  if (!summary) { return null; }
  const header = headerLabel(summary.contextPercent);
  const model = result?.ok ? contextModel(result.breakdown) : undefined;
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Context">
        <text fg={header.danger ? 'red' : 'gray'}>{header.text}</text>
        {!result ? <text fg="gray">Loading…</text> : null}
        {result && !result.ok ? <text fg="gray">{`${result.reason}   r retry`}</text> : null}
        {model ? (
          <>
            <text>
              {stackedBar(model.slices, BAR_WIDTH).map((c) => (
                <span key={c.key} fg={COLOR[c.key]}>{GLYPH[c.key].repeat(c.cells)}</span>
              ))}
            </text>
            {model.window ? <text fg="gray">{model.window.padStart(BAR_WIDTH)}</text> : null}
            {model.slices.map((s) => (
              <box key={s.key} flexDirection="column">
                <text>{`${s.label.padEnd(BAR_WIDTH - PERCENT_COL)}${`${s.percent}%`.padStart(PERCENT_COL)}`}</text>
                {s.key === 'memory' && model.memoryFiles.length === 0 ? <text fg="gray">  No memory files loaded</text> : null}
                {s.key === 'memory' ? model.memoryFiles.map((f) => (
                  <text key={f.path} fg="gray">
                    {`  ${fitPath(f.path, BAR_WIDTH - PERCENT_COL - 2).padEnd(BAR_WIDTH - PERCENT_COL - 2)}${f.percent.padStart(PERCENT_COL)}`}
                  </text>
                )) : null}
              </box>
            ))}
          </>
        ) : null}
        <text fg="gray">Esc close</text>
      </Dialog>
    </box>
  );
}
```

If `post` is not referentially stable and the effect re-posts, make the first effect depend only on `[sessionId]` behind a `useRef` guard (`const asked = useRef(false)`), keeping the "posts exactly once" test green; if `onClose` is an inline arrow in `App`, the second effect is cheap and idempotent but guard it the same way if lint objects.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui src/test/tui/context-dialog.test.tsx` then `yarn lint` and `yarn check-types:tui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/ui/context-dialog.tsx src/test/tui/context-dialog.test.tsx
git commit -m "feat: TUI context dialog"
```

---

### Task 4: Open it from `/context`, `Ctrl+T` and the status-line click

**Files:**
- Modify: `src/tui/keymap.ts`, `src/tui/view/pickers.ts`, `src/tui/ui/use-app-keys.ts`, `src/tui/ui/app.tsx`
- Test: `src/test/unit/tui-keymap.test.ts`, `src/test/unit/tui-pickers.test.ts`, `src/test/tui/context-open.test.tsx`

**Interfaces:**
- Consumes: `ContextDialog` (Task 3), `StatusLine`'s `onOpenContext` (Task 2).
- Produces: `PickerKind = 'model' | 'mode' | 'effort' | 'context'`; keymap action `{ do: 'open-context' }`.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/tui-keymap.test.ts`, next to the `open-effort` assertion (line ~67), add:

```ts
    assert.deepStrictEqual(actionFor('composer', { name: 't', ctrl: true }, idle), { do: 'open-context' });
    assert.deepStrictEqual(actionFor('transcript', { name: 't', ctrl: true }, idle), { do: 'open-context' });
    assert.strictEqual(actionFor('composer', { name: 't' }, idle), undefined);
```

In `src/test/unit/tui-pickers.test.ts`, inside the slash-commands suite add:

```ts
  test('/context names its dialog', () => {
    assert.strictEqual(parsePickerCommand('/context'), 'context');
    assert.strictEqual(parsePickerCommand(' /context '), 'context');
    assert.strictEqual(parsePickerCommand('/context now'), undefined);
  });
```

Create `src/test/tui/context-open.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const requests = () => (m?.posted ?? []).filter((p) => p.t === 'request-context');
const boot = async (over: Parameters<typeof summary>[1] = {}) => {
  const s = summary('s1', { contextPercent: 42, ...over });
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
};

test('Ctrl+T opens the context dialog for the focused session', async () => {
  await boot();
  await m!.press('t', { ctrl: true });
  expect(m!.frame()).toContain('42% used');
  const r = requests()[0];
  expect(r?.t === 'request-context' && r.id).toBe('s1');
});

test('/context in the composer opens it', async () => {
  await boot();
  await m!.type('/context');
  await m!.press('return');
  expect(requests().length).toBe(1);
  expect(m!.posted.some((p) => p.t === 'send')).toBe(false);
});

test('clicking the share in the status line opens it', async () => {
  await boot();
  const rows = m!.frame().split('\n');
  const y = rows.findIndex((r) => r.includes('ctx 42%'));
  const x = rows[y]!.indexOf('ctx 42%');
  await act(async () => { await m!.setup.mockMouse.click(x + 1, y); });
  await m!.fromHost();
  expect(requests().length).toBe(1);
});

test('a foreign session cannot open it by chord or click', async () => {
  await boot({ owner: { host: 'vscode', pid: 1 } });
  await m!.press('t', { ctrl: true });
  const rows = m!.frame().split('\n');
  const y = rows.findIndex((r) => r.includes('ctx 42%'));
  const x = rows[y]!.indexOf('ctx 42%');
  await act(async () => { await m!.setup.mockMouse.click(x + 1, y); });
  await m!.fromHost();
  expect(requests().length).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "tui keymap|tui pickers"` and `yarn test:tui src/test/tui/context-open.test.tsx`
Expected: FAIL (`open-context` undefined, `/context` unparsed, nothing opens).

- [ ] **Step 3: Implement**

`src/tui/keymap.ts`: add `| { do: 'open-context' }` to the `Action` union (next to `open-mode`) and in `globalAction`'s ctrl switch add:

```ts
      case 't': return act('open-context');
```

`src/tui/view/pickers.ts`:

```ts
export type PickerKind = 'model' | 'mode' | 'effort' | 'context';

export function parsePickerCommand(text: string): PickerKind | undefined {
  const match = /^\/(model|mode|effort|context)$/.exec(text.trim());
  return match?.[1] as PickerKind | undefined;
}
```

`src/tui/ui/use-app-keys.ts`: add after the `open-mode` case:

```ts
      case 'open-context': if (s) { k.openPicker('context'); } return;
```

`src/tui/ui/app.tsx`: import `ContextDialog` from `./context-dialog`, render it beside the other pickers:

```tsx
      {picker === 'context' && focusedId ? <ContextDialog sessionId={focusedId} onClose={() => { setPicker(null); }} /> : null}
```

and pass the click door to the status line (foreign sessions get none):

```tsx
        <StatusLine
          sessionId={focusedId}
          width={width}
          onOpenContext={summary && !summary.owner ? () => { setPicker('context'); } : undefined}
        />
```

`onClose` as an inline arrow re-creates each render; if Task 3's `[present, onClose]` effect then fires `onClose` repeatedly while present is false, that is harmless (`setPicker(null)` is idempotent), so no change.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:tui && yarn lint && yarn check-types && yarn check-types:tui`
Expected: all PASS. If the `/context` test posts a `send`, the composer's `submit()` order is wrong: `parsePickerCommand` must run before `post({ t: 'send' })` (it already does for the other pickers).

- [ ] **Step 5: Commit**

```bash
git add src/tui src/test
git commit -m "feat: open the TUI context dialog from /context, Ctrl+T and the status line"
```

---

### Task 5: Docs, roadmap and the not-run-in-a-terminal note

**Files:**
- Modify: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`

- [ ] **Step 1: Update docs**

Run: `cd /e/Efebia/hiiiid-code && grep -n "Ctrl+P\|/model\|Ctrl+E" docs/tui.md`
In `docs/tui.md`, add `Ctrl+T` and `/context` wherever `Ctrl+P`/`/model` are listed (same row format), and one line saying the status line shows `ctx N%`, red at 80% and above, and is clickable. In the manual smoke checklist add: "Click the `ctx` share in Windows Terminal and one other terminal; `Ctrl+T` and `/context` are the fallback."

In `docs/superpowers/roadmap-tui.md`, under **Done** add a bullet: "**D1. Context** (`feat/tui-awareness-context`): `ctx N%` in the status line, context dialog via `/context`, `Ctrl+T` or a click. Spec `2026-10-02-tui-awareness-design.md`, plan `2026-10-02-tui-awareness-context.md`. Not verified in a real terminal: status-line mouse click." and in **Next**, item 1, drop the context dialog and the status-line share from the list, leaving usage strip and worktree/relocation cards (Slice 2).

- [ ] **Step 2: Final gate**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui && yarn test:unit && yarn test:dom && yarn test:tui && yarn run compile`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: TUI context dialog keys and roadmap"
```
