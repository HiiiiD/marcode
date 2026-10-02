# TUI Awareness, Slice 2: Usage Strip and Relocation Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show plan usage windows in the TUI roster header with a refresh key/click, and replace the one-line relocation notice with a card that answers the worktree move offer (move, stay, cancel a queued move) from the keyboard.

**Architecture:** Pure formatting in `src/client-core/usage-format.ts` (rows, countdown, width-fitted lines) and `src/tui/view/relocation-view.ts` (which item is addressable, which message a key posts). `UsageStrip` mounts at the bottom of the roster and reads `usageByProvider`, `usageDisplayNames`, `usageRefreshing`, which the reducer already fills. The relocation card is a new `TranscriptRow` kind rendered on the existing `Collapsible` frame; its keys are handled in `use-app-keys.ts` (one place, focused session only), so panes never contend. No protocol or host changes.

**Tech Stack:** TypeScript, OpenTUI React, Bun test (`yarn test:tui`), mocha (`yarn test:unit`).

**Spec:** `docs/superpowers/specs/2026-10-02-tui-awareness-design.md` (Slice 2 sections). Slice 1 (context) is merged to master (#243).

**One plan, not two.** Usage strip and relocation cards share no code, but together they are 6 small tasks and one PR was the approved shape. If review prefers two PRs, Tasks 1-3 and Tasks 4-6 split cleanly at the Task 3/4 boundary (Task 7 docs would then be edited twice).

## Deviations from the spec (decided while reading the code; flag in review)

- **Relocation states.** The wire has four: `pending | queued | moved | stayed`. The spec's "in flight" is `queued` (move answered mid-turn, held until idle); "declined" is `stayed`; "cancelled" sends the item back to `pending` (the host does that, no fifth state). Cancel is therefore only reachable from `queued`.
- **Usage "one row per provider".** 24 inner columns cannot hold two windows on a line. Each provider is a name line plus one line per window (`5h ██████░░░░ 62% 1h02m`). Window labels use a short table keyed on the shared `USAGE_WINDOW_ORDER` ids (`5h`, `7d`, ...); an unknown id falls back to the provider's own label.
- **Refresh start.** The webview dispatches `local-usage-refresh-start` inside its store's `post`. The TUI store gets an explicit `refreshUsage()` instead, which also refuses a second call while one is in flight.
- **Keys.** Plain letters are the composer's, so card keys are chords: `Ctrl+Y` move, `Ctrl+L` stay (and cancel a queued move), `Ctrl+G` refresh usage.

## Global Constraints

- Every share is a percentage. A usage window shows `usedPercent` only (clamped 0-100), never a token count.
- Plan usage is pulled (`refresh-usage`, `usage-windows`), never read off `rate_limit_event`. `resetsAt` is epoch **ms** on `UsageWindow` (the host already normalised it); do not rescale.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM; the TUI never imports `src/webview/`.
- Every session-addressed message carries a `SessionId` (`answer-relocation { id, itemId, move }`, `cancel-relocation { id, itemId }`). `refresh-usage` is the one account-level message and carries none.
- A foreign session (`summary.owner` set) is read-only: no relocation keys, no hints.
- Filenames kebab-case. Comments only for non-obvious why.
- TUI tests never hand a renderer or renderable to an assertion; no fixed sleeps (use the harness's `press`/`fromHost`, which settle themselves). `src/test/unit/tui-*.test.ts` is mocha, `src/test/tui/*.test.tsx` is `bun test`.
- Run the guarded scripts only: `yarn test:unit`, `yarn test:tui` (and `yarn test:dom` after Task 4, which touches `src/webview/format.ts`). Gate before every commit: `yarn lint`, `yarn check-types`, `yarn check-types:tui`.
- Bound Ctrl letters today: app `b n c p e r w j x t`; OpenTUI textarea `a b d e f k o p s u w`. This plan adds `g`, `y`, `l` (free in both). Task 3 pins the set with a test.

## Review Focus

- Narrow roster (24 inner columns) and short terminals: no strip line is ever wider than the width it was given (including widths below the percent's own width), the strip never pushes the session list to zero rows, a long provider name or label truncates instead of wrapping.
- A window whose `resetsAt` passed with no new broadcast, and odd percents (above 100, negative, fractional): the expired window is dropped on render and a provider with nothing left vanishes (no empty block); percents clamp and round.
- Refresh: a second `Ctrl+G` or click while `usageRefreshing` posts nothing; `usage-refresh-done` and a fresh `hydrate` both clear the marker; with no provider reporting the strip is absent and the key still just posts one pull.
- Two visible panes each with a pending offer: the keys address only the focused pane's newest pending or queued offer, the unfocused pane's card says to focus it, a foreign session gets no hint and no post, a double press posts once, and after a queued move is cancelled (host returns it to `pending`) the keys work again.
- Several relocation items in one transcript, and an odd `path` (empty, trailing separator, Windows backslashes): only the newest unsettled one is addressable; the folder name never renders blank.

## File Structure

- Create `src/client-core/usage-format.ts`: `resetCountdown`, `usageRows`, `windowLine`, `windowLineText`, `stripLines`, `BAR_CELLS`.
- Create `src/client-core/folder-name.ts`: `folderName` (moved from the webview); `src/webview/format.ts` re-exports it.
- Create `src/tui/view/relocation-view.ts`: `activeRelocation`, `relocationCard`, `relocationMessage`.
- Modify `src/tui/view/transcript-rows.ts`: a `relocation` row kind.
- Create `src/tui/ui/usage-strip.tsx`; modify `src/tui/ui/roster.tsx` to mount it.
- Create `src/tui/ui/transcript/relocation-card.tsx`; modify `row.tsx`, `transcript.tsx`, `pane.tsx` (pass `relocationKeys`).
- Modify `src/tui/ui/store.tsx` (`refreshUsage`), `src/tui/keymap.ts` (three actions), `src/tui/ui/use-app-keys.ts`, `src/tui/ui/app.tsx`.
- Tests: `src/test/unit/tui-usage-format.test.ts`, `src/test/unit/tui-relocation-view.test.ts`, extend `src/test/unit/tui-keymap.test.ts` and `src/test/unit/tui-view.test.ts`; `src/test/tui/usage-strip.test.tsx`, `src/test/tui/relocation-card.test.tsx`, `src/test/tui/relocation-keys.test.tsx`.
- Docs: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`.

---

### Task 1: Usage formatting (pure)

**Files:**
- Create: `src/client-core/usage-format.ts`
- Test: `src/test/unit/tui-usage-format.test.ts`

**Interfaces:**
- Consumes: `orderWindows` from `src/shared/usage-windows.ts`; `clampPercent` from `client-core/context-format`; `UsageWindow` from `providers/types`.
- Produces (used by Task 3):
  ```ts
  export const BAR_CELLS = 6
  export interface UsageWindowRow { id: string; label: string; percent: number; reset?: string }
  export interface UsageProviderRow { id: string; name: string; windows: UsageWindowRow[] }
  export function resetCountdown(resetsAt: number | undefined, now: number): string | undefined
  export function usageRows(by: Record<string, UsageWindow[] | undefined>, nameOf: (id: string) => string, now: number): UsageProviderRow[]
  export interface WindowLine { label: string; filled?: number; pct: string; reset?: string }
  export function windowLine(w: UsageWindowRow, width: number, labelWidth: number): WindowLine
  export function windowLineText(line: WindowLine): string          // what the component prints, so tests measure the real string
  export type StripLine = { kind: 'provider'; text: string } | { kind: 'window'; line: WindowLine }
  export function stripLines(rows: UsageProviderRow[], width: number, maxLines: number): StripLine[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/tui-usage-format.test.ts`:

```ts
import * as assert from 'node:assert';
import type { UsageWindow } from '../../providers/types';
import {
  BAR_CELLS, resetCountdown, stripLines, usageRows, windowLine, windowLineText, type UsageWindowRow,
} from '../../client-core/usage-format';

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const name = (id: string) => id.toUpperCase();
const win = (over: Partial<UsageWindow> = {}): UsageWindow => ({ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, ...over });

suite('usage-format: resetCountdown', () => {
  test('compact units, floored', () => {
    assert.strictEqual(resetCountdown(NOW + 30_000, NOW), '<1m');
    assert.strictEqual(resetCountdown(NOW + 45 * MIN, NOW), '45m');
    assert.strictEqual(resetCountdown(NOW + (2 * 60 + 14) * MIN, NOW), '2h14m');
    assert.strictEqual(resetCountdown(NOW + 120 * MIN, NOW), '2h00m');
    assert.strictEqual(resetCountdown(NOW + (3 * 24 + 4) * 60 * MIN, NOW), '3d4h');
  });
  test('unknown, past and exactly-now give nothing', () => {
    assert.strictEqual(resetCountdown(undefined, NOW), undefined);
    assert.strictEqual(resetCountdown(NOW - 1, NOW), undefined);
    assert.strictEqual(resetCountdown(NOW, NOW), undefined);
  });
});

suite('usage-format: usageRows', () => {
  test('providers with no windows or only expired ones produce no row', () => {
    const rows = usageRows({ a: [], b: undefined, c: [win({ resetsAt: NOW - 1 })], d: [win()] }, name, NOW);
    assert.deepStrictEqual(rows.map((r) => r.id), ['d']);
  });
  test('windows come in the shared order, with short labels and clamped percents', () => {
    const rows = usageRows({ p: [
      win({ id: 'seven-day', label: 'Week', usedPercent: 140.4 }),
      win({ id: 'five-hour', usedPercent: -3, resetsAt: NOW + 62 * MIN }),
      win({ id: 'mystery', label: 'Credits', usedPercent: 41.5 }),
    ] }, name, NOW);
    assert.deepStrictEqual(rows[0]!.windows, [
      { id: 'five-hour', label: '5h', percent: 0, reset: '1h02m' },
      { id: 'seven-day', label: '7d', percent: 100 },
      { id: 'mystery', label: 'Credits', percent: 42 },
    ]);
    assert.strictEqual(rows[0]!.name, 'P');
  });
  test('a window with no resetsAt never expires', () => {
    assert.strictEqual(usageRows({ p: [win({ resetsAt: undefined })] }, name, NOW).length, 1);
  });
});

suite('usage-format: windowLine', () => {
  const row: UsageWindowRow = { id: 'five-hour', label: '5h', percent: 62, reset: '1h02m' };
  test('everything fits at the roster width', () => {
    const l = windowLine(row, 24, 2);
    assert.strictEqual(windowLineText(l), '5h ████░░ 62% 1h02m');
    assert.strictEqual(l.filled, 4);
  });
  test('loss order: countdown, then label, then bar', () => {
    assert.strictEqual(windowLineText(windowLine(row, 14, 2)), '5h ████░░ 62%');
    const long: UsageWindowRow = { ...row, label: 'Credits' };
    assert.strictEqual(windowLineText(windowLine(long, 14, 7)), 'C… ████░░ 62%'.padEnd(13));
    assert.strictEqual(windowLineText(windowLine(long, 9, 7)), 'Credi… 62%');
    assert.strictEqual(windowLineText(windowLine(row, 3, 2)), '62%');
  });
  test('the printed line never exceeds the width, at any width', () => {
    for (const r of [row, { ...row, label: 'a very long window label', percent: 100 }, { ...row, percent: 0, reset: undefined }]) {
      for (let w = 0; w <= 60; w++) {
        assert.strictEqual(windowLineText(windowLine(r, w, Math.min(r.label.length, 8))).length <= w, true, `width ${w}`);
      }
    }
  });
  test('a nonzero percent always lights at least one cell, zero lights none', () => {
    assert.strictEqual(windowLine({ ...row, percent: 1 }, 40, 2).filled, 1);
    assert.strictEqual(windowLine({ ...row, percent: 0 }, 40, 2).filled, 0);
    assert.strictEqual(windowLine({ ...row, percent: 100 }, 40, 2).filled, BAR_CELLS);
  });
});

suite('usage-format: stripLines', () => {
  const rows = usageRows({
    a: [win(), win({ id: 'seven-day', label: 'Week', usedPercent: 18 })],
    b: [win({ usedPercent: 9 })],
  }, name, NOW);
  test('a name line per provider then its windows, label column aligned', () => {
    const lines = stripLines(rows, 24, 20);
    assert.deepStrictEqual(lines.map((l) => (l.kind === 'provider' ? l.text : windowLineText(l.line))),
      ['A', '5h ████░░ 62%', '7d █░░░░░ 18%', 'B', '5h ░░░░░░ 9%']);
  });
  test('maxLines cuts from the end and never exceeds the width', () => {
    assert.strictEqual(stripLines(rows, 24, 3).length, 3);
    assert.strictEqual(stripLines(rows, 24, 0).length, 0);
    const long = usageRows({ p: [win()] }, () => 'A provider with a very long display name', NOW);
    const first = stripLines(long, 10, 5)[0]!;
    assert.strictEqual(first.kind === 'provider' && first.text.length <= 10, true);
  });
  test('no rows, no lines', () => {
    assert.deepStrictEqual(stripLines([], 24, 5), []);
  });
});
```

Adjust the literal bars/spacing in the three expected-string assertions to the real output of the implementation below if a cell count differs by rounding, keeping these rules: filled = `max(1, round(percent / 100 * 6))` for percent > 0, `0` for 0; the countdown is dropped before the label is cut, and the label is cut (to a minimum of 2 columns, ending in `…`) before the bar is dropped; a name line is the provider name cut to width with `…`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "usage-format"`
Expected: FAIL, cannot find module `client-core/usage-format`.

- [ ] **Step 3: Implement**

Create `src/client-core/usage-format.ts`:

```ts
import type { UsageWindow } from '../providers/types';
import { orderWindows } from '../shared/usage-windows';
import { clampPercent } from './context-format';

export const BAR_CELLS = 6;
const MIN_LABEL = 2;

// 24 columns cannot hold the providers' own labels ("Session (5h)"); unknown ids keep theirs.
const SHORT_LABEL: Record<string, string> = {
  'five-hour': '5h', 'seven-day': '7d', 'seven-day-opus': '7d opus', 'seven-day-sonnet': '7d sonnet',
};

export interface UsageWindowRow { id: string; label: string; percent: number; reset?: string }
export interface UsageProviderRow { id: string; name: string; windows: UsageWindowRow[] }

export function resetCountdown(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || resetsAt <= now) { return undefined; }
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes < 1) { return '<1m'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h${String(minutes % 60).padStart(2, '0')}m`; }
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function usageRows(
  by: Record<string, UsageWindow[] | undefined>, nameOf: (id: string) => string, now: number,
): UsageProviderRow[] {
  const rows: UsageProviderRow[] = [];
  for (const [id, all] of Object.entries(by)) {
    // The host prunes on read but the client keeps its copy until the next broadcast, which may be hours away.
    const live = (all ?? []).filter((w) => w.resetsAt === undefined || w.resetsAt > now);
    if (live.length === 0) { continue; }
    rows.push({
      id,
      name: nameOf(id),
      windows: orderWindows(live).map((w) => {
        const reset = resetCountdown(w.resetsAt, now);
        return { id: w.id, label: SHORT_LABEL[w.id] ?? w.label, percent: clampPercent(w.usedPercent), ...(reset ? { reset } : {}) };
      }),
    });
  }
  return rows;
}

export interface WindowLine { label: string; filled?: number; pct: string; reset?: string }

const cut = (text: string, width: number) => (text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`);

export function windowLine(w: UsageWindowRow, width: number, labelWidth: number): WindowLine {
  const pct = `${w.percent}%`;
  const filled = w.percent === 0 ? 0 : Math.max(1, Math.round((w.percent / 100) * BAR_CELLS));
  const size = (label: number, bar: boolean, reset: boolean) =>
    (label > 0 ? label + 1 : 0) + (bar ? BAR_CELLS + 1 : 0) + pct.length + (reset && w.reset ? 1 + w.reset.length : 0);
  const make = (label: number, bar: boolean, reset: boolean): WindowLine => ({
    label: label > 0 ? cut(w.label, label) : '',
    ...(bar ? { filled } : {}),
    pct,
    ...(reset && w.reset ? { reset: w.reset } : {}),
  });
  const attempts: [number, boolean, boolean][] = [[labelWidth, true, true], [labelWidth, true, false]];
  for (let l = labelWidth - 1; l >= MIN_LABEL; l--) { attempts.push([l, true, false]); }
  for (let l = labelWidth; l >= MIN_LABEL; l--) { attempts.push([l, false, false]); }
  const fit = attempts.find(([l, b, r]) => size(l, b, r) <= width);
  if (fit) { return make(...fit); }
  return { label: '', pct: pct.slice(0, Math.max(0, width)) };
}

export function windowLineText(line: WindowLine): string {
  const bar = line.filled === undefined ? undefined : '█'.repeat(line.filled) + '░'.repeat(BAR_CELLS - line.filled);
  return [line.label || undefined, bar, line.pct, line.reset].filter((p): p is string => p !== undefined && p !== '').join(' ');
}

export type StripLine = { kind: 'provider'; text: string } | { kind: 'window'; line: WindowLine };

export function stripLines(rows: UsageProviderRow[], width: number, maxLines: number): StripLine[] {
  const lines: StripLine[] = [];
  for (const row of rows) {
    lines.push({ kind: 'provider', text: cut(row.name, Math.min(row.name.length, width)).trimEnd() });
    const labelWidth = Math.min(Math.max(...row.windows.map((w) => w.label.length)), Math.max(MIN_LABEL, width - BAR_CELLS - 6));
    for (const w of row.windows) { lines.push({ kind: 'window', line: windowLine(w, width, labelWidth) }); }
  }
  return lines.slice(0, Math.max(0, maxLines));
}
```

Notes for the implementer: `windowLine`'s result must satisfy the invariant test for every width, so if an expected literal above disagrees with a tie-break, fix the literal, never the invariant. `cut` pads (alignment) only when `labelWidth` is wider than the label; the provider-name call passes the name's own length so it never pads.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "usage-format" && yarn check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/tui-awareness-usage-relocation
git add src/client-core/usage-format.ts src/test/unit/tui-usage-format.test.ts
git commit -m "feat: usage window formatting for the TUI strip"
```

---

### Task 2: Store `refreshUsage` and the keymap actions

**Files:**
- Modify: `src/tui/ui/store.tsx`, `src/tui/keymap.ts`
- Test: `src/test/unit/tui-keymap.test.ts`, `src/test/tui/usage-strip.test.tsx` (store part, created here, extended in Task 3)

**Interfaces:**
- Produces (used by Tasks 3 and 6):
  ```ts
  // TuiStoreValue gains:
  refreshUsage(): void   // posts { t: 'refresh-usage' } and sets usageRefreshing; no-op while one is in flight
  // Action union gains:
  { do: 'refresh-usage' } | { do: 'relocation-move' } | { do: 'relocation-stay' }
  // keys (any zone, ctrl): g -> refresh-usage, y -> relocation-move, l -> relocation-stay
  ```

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/tui-keymap.test.ts` add (inside the existing global-keys suite; reuse its `idle` context):

```ts
    for (const zone of ['composer', 'transcript', 'roster'] as const) {
      assert.deepStrictEqual(actionFor(zone, { name: 'g', ctrl: true }, idle), { do: 'refresh-usage' });
      assert.deepStrictEqual(actionFor(zone, { name: 'y', ctrl: true }, idle), { do: 'relocation-move' });
      assert.deepStrictEqual(actionFor(zone, { name: 'l', ctrl: true }, idle), { do: 'relocation-stay' });
      assert.strictEqual(actionFor(zone, { name: 'g' }, idle), undefined);
    }
    // The approval prompt keeps plain y/n; the chord must not shadow it.
    assert.deepStrictEqual(actionFor('approval', { name: 'y' }, idle), { do: 'allow' });
```

and a collision pin as a new test in the same file:

```ts
  test('the Ctrl letters the app binds are exactly the audited set', () => {
    const bound = [...'abcdefghijklmnopqrstuvwxyz'].filter((c) => {
      const a = actionFor('transcript', { name: c, ctrl: true }, { running: false });
      return a !== undefined && a.do !== 'item-next' && a.do !== 'item-prev';
    });
    // textarea owns a b d e f k o p s u w; adding to this list means re-auditing against it.
    assert.deepStrictEqual(bound, ['b', 'c', 'e', 'g', 'l', 'n', 'p', 'r', 't', 'w', 'y']);
  });
```

(`j` and `x` are composer-only chords, which is why this transcript-zone scan omits them. If the scan shows `p`/`e` differently, fix the literal to what the scan really prints, then confirm by eye that none of `g y l` is in the textarea set `a b d e f k o p s u w`.)

Create `src/test/tui/usage-strip.test.tsx` with the store part:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { useTuiStore } from '../../tui/ui/store';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const { state, refreshUsage } = useTuiStore();
  return <text onMouseDown={refreshUsage}>{state.usageRefreshing ? 'refreshing' : 'idle'}</text>;
}
const pulls = () => (m?.posted ?? []).filter((p) => p.t === 'refresh-usage').length;
const click = async () => { await act(async () => { await m!.setup.mockMouse.click(1, 0); }); await m!.fromHost(); };

test('refreshUsage posts once, marks refreshing, and ignores a second call until the round is done', async () => {
  m = await mount(<Probe />);
  await m.fromHost(hydrateMsg());
  await click();
  await click();
  expect(pulls()).toBe(1);
  expect(m.frame()).toContain('refreshing');
  await m.fromHost({ t: 'usage-refresh-done' });
  expect(m.frame()).toContain('idle');
  await click();
  expect(pulls()).toBe(2);
});

test('a hydrate clears a stuck refreshing marker', async () => {
  m = await mount(<Probe />);
  await m.fromHost(hydrateMsg());
  await click();
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('idle');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "tui keymap" && yarn test:tui src/test/tui/usage-strip.test.tsx`
Expected: FAIL (`refresh-usage` action undefined; `refreshUsage` is not a function).

- [ ] **Step 3: Implement**

`src/tui/keymap.ts`: add `| { do: 'refresh-usage' } | { do: 'relocation-move' } | { do: 'relocation-stay' }` to the `Action` union and, in `globalAction`'s ctrl switch, after `case 't'`:

```ts
      case 'g': return act('refresh-usage');
      case 'y': return act('relocation-move');
      case 'l': return act('relocation-stay');
```

`src/tui/ui/store.tsx`: add `refreshUsage(): void;` to `TuiStoreValue`, and in the provider (it already has `stateRef`):

```ts
  const refreshUsage = useCallback(() => {
    if (stateRef.current.usageRefreshing) { return; }
    // Nothing echoes the request, only its eventual usage-refresh-done, so the marker has to start here.
    stateRef.current = { ...stateRef.current, usageRefreshing: true };
    transport.post({ t: 'refresh-usage' });
    dispatch({ t: 'local-usage-refresh-start' });
  }, [transport]);
```

Add `refreshUsage` to the `useMemo` value and its dependency list. (`stateRef.current` is reassigned each render from `state`, so the optimistic write only covers the gap between two synchronous calls; that gap is exactly what the double-click test pins.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:tui src/test/tui/usage-strip.test.tsx && yarn check-types:tui`
Expected: PASS. If the keymap collision test fails only on its literal, correct the literal as described in Step 1.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/tui/keymap.ts src/tui/ui/store.tsx src/test
git commit -m "feat: TUI store refreshUsage and usage and relocation chords"
```

---

### Task 3: The usage strip in the roster

**Files:**
- Create: `src/tui/ui/usage-strip.tsx`
- Modify: `src/tui/ui/roster.tsx`, `src/tui/ui/use-app-keys.ts`
- Test: `src/test/tui/usage-strip.test.tsx` (extend)

**Interfaces:**
- Consumes: `usageRows`, `stripLines`, `windowLineText` (Task 1); `refreshUsage` (Task 2); `useTick`, `SPINNER` from `./use-ticker`.
- Produces: `export function UsageStrip({ width, maxLines }: { width: number; maxLines: number }): JSX.Element | null`; Roster mounts it under the session list; `Ctrl+G` calls `refreshUsage`.

- [ ] **Step 1: Write the failing tests**

Extend `src/test/tui/usage-strip.test.tsx` (add imports `import { Roster } from '../../tui/ui/roster'; import { UsageStrip } from '../../tui/ui/usage-strip'; import { App } from '../../tui/ui/app'; import { snapshot, summary, windows } from '../fixtures/protocol';`):

```tsx
const strip = () => <UsageStrip width={24} maxLines={8} />;
const usage = (over: Record<string, ReturnType<typeof windows>> = { claude: windows() }) => hydrateMsg({ usage: over });

test('hidden entirely while nothing reports', async () => {
  m = await mount(strip());
  await m.fromHost(usage({}));
  expect(m.frame().trim()).toBe('');
});

test('a reporting provider shows its name, windows as percentages and a countdown', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  const f = m.frame();
  expect(f).toContain('5h');
  expect(f).toContain('62%');
  expect(f).toContain('7d');
  expect(f).toContain('18%');
  expect(f).toMatch(/\d+m|\dh\d\dm/);
  expect(f.includes('tokens')).toBe(false);
});

test('a provider whose windows all expired shows nothing', async () => {
  m = await mount(strip());
  await m.fromHost(usage({ claude: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1000 }] }));
  expect(m.frame().trim()).toBe('');
});

test('the display name from the host wins over the catalog name', async () => {
  m = await mount(strip());
  await m.fromHost(hydrateMsg({ usage: { claude: windows() }, usageDisplayNames: { claude: 'Claude Max' } }));
  expect(m.frame()).toContain('Claude Max');
});

test('a usage-windows push updates a row in place', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  await m.fromHost({ t: 'usage-windows', providerId: 'claude', windows: [{ id: 'five-hour', label: 'x', usedPercent: 91 }] });
  expect(m.frame()).toContain('91%');
  expect(m.frame().includes('62%')).toBe(false);
});

test('clicking the strip pulls once and shows the marker until the round is done', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  await act(async () => { await m!.setup.mockMouse.click(2, 1); });
  await m.fromHost();
  expect(pulls()).toBe(1);
  expect(m.frame()).toContain('refreshing');
  await act(async () => { await m!.setup.mockMouse.click(2, 1); });
  await m.fromHost();
  expect(pulls()).toBe(1);
  await m.fromHost({ t: 'usage-refresh-done' });
  expect(m.frame().includes('refreshing')).toBe(false);
});

test('maxLines keeps the strip from eating the list: a tiny budget cuts windows, never wraps', async () => {
  m = await mount(<UsageStrip width={24} maxLines={2} />);
  await m.fromHost(usage());
  expect(m.frame()).toContain('5h');
  expect(m.frame().includes('7d')).toBe(false);
});

test('inside the roster the strip sits under the sessions and fits 26 columns', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} onHandoff={() => {}} />, { width: 26, height: 20 });
  await m.fromHost(hydrateMsg({ usage: { claude: windows() }, usageDisplayNames: { claude: 'An extremely long provider display name' } }));
  const rows = m.frame().split('\n');
  expect(rows.every((r) => r.length <= 26)).toBe(true);
  expect(rows.some((r) => r.includes('62%'))).toBe(true);
  expect(m.frame()).toContain('sessions');
});

test('Ctrl+G pulls once whatever zone is focused, and not again while refreshing', async () => {
  const s = summary('s1');
  m = await mount(<App launchCwd="/repo" forceNew={false} loginCommands={{}} onQuit={() => {}} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)], usage: { claude: windows() } }));
  await m.press('g', { ctrl: true });
  await m.press('g', { ctrl: true });
  expect(pulls()).toBe(1);
});
```

Where the roster test needs the provider id `claude` to exist in `catalog()`, `usageDisplayNames` is supplied in the same hydrate, so no catalog fixture change is needed.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui src/test/tui/usage-strip.test.tsx`
Expected: FAIL, cannot resolve `tui/ui/usage-strip`.

- [ ] **Step 3: Implement**

Create `src/tui/ui/usage-strip.tsx`:

```tsx
import { stripLines, usageRows, windowLineText } from '../../client-core/usage-format';
import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';
import { SPINNER, useTick } from './use-ticker';

export function UsageStrip({ width, maxLines }: { width: number; maxLines: number }) {
  const { state, refreshUsage } = useTuiStore();
  const theme = useTheme();
  const now = Date.now();
  const rows = usageRows(
    state.usageByProvider,
    (id) => state.usageDisplayNames[id] ?? state.catalog.find((p) => p.id === id)?.displayName ?? id,
    now,
  );
  // The countdown is read from the clock at render time; the shared ticker is what makes it re-render while visible.
  const tick = useTick(rows.length > 0);
  if (rows.length === 0) { return null; }
  const muted = theme.colors.mutedForeground;
  const header = state.usageRefreshing ? `${SPINNER[tick % SPINNER.length]} refreshing` : 'usage  ^G refresh';
  return (
    <box flexDirection="column" flexShrink={0} border={['top']} borderStyle="single" borderColor={theme.colors.border} onMouseDown={refreshUsage}>
      <text fg={muted} wrapMode="none">{header.slice(0, width)}</text>
      {stripLines(rows, width, maxLines).map((l, i) => (l.kind === 'provider'
        ? <text key={i} wrapMode="none">{l.text}</text>
        : <text key={i} fg={muted} wrapMode="none">{windowLineText(l.line)}</text>))}
    </box>
  );
}
```

`src/tui/ui/roster.tsx`: import `useTerminalDimensions` from `@opentui/react` and `UsageStrip`; inside `Roster` add `const { height } = useTerminalDimensions();` and render, directly after the `</scrollbox>`:

```tsx
      <UsageStrip width={ROSTER_W - 2} maxLines={Math.max(2, Math.floor(height / 3))} />
```

(The scrollbox is `flexGrow`, the strip `flexShrink={0}`, so the cap is what keeps the list alive on a short terminal.)

`src/tui/ui/use-app-keys.ts`: destructure `refreshUsage` from `useTuiStore()` and add, beside `refresh-catalog`:

```ts
      case 'refresh-usage': refreshUsage(); return;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui && yarn test:unit && yarn lint && yarn check-types:tui`
Expected: PASS, including every pre-existing roster test (`usage` is `{}` there, so the strip is absent). If the 26-column assertion fails on the roster's own border, count only the strip rows (those containing `%`).

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/tui src/test
git commit -m "feat: TUI usage strip in the roster with Ctrl+G and click refresh"
```

---

### Task 4: Relocation view model and the transcript row

**Files:**
- Create: `src/client-core/folder-name.ts`, `src/tui/view/relocation-view.ts`
- Modify: `src/webview/format.ts`, `src/tui/view/transcript-rows.ts`
- Test: `src/test/unit/tui-relocation-view.test.ts`, `src/test/unit/tui-view.test.ts`

**Interfaces:**
- Consumes: `relocation` fixture from `src/test/fixtures/protocol.ts`.
- Produces (used by Tasks 5 and 6):
  ```ts
  // client-core/folder-name.ts
  export function folderName(cwd: string): string        // moved verbatim from webview/format.ts
  // tui/view/relocation-view.ts
  export type RelocationItem = Extract<TranscriptItem, { role: 'relocation' }>
  export interface RelocationCard { id: string; name: string; path: string; state: RelocationItem['state'] }
  export function activeRelocation(items: TranscriptItem[]): RelocationItem | undefined   // newest pending or queued
  export function relocationCard(item: RelocationItem): RelocationCard
  export function relocationMessage(sessionId: SessionId, item: RelocationItem, key: 'move' | 'stay'): WebviewToHost | undefined
  // transcript-rows.ts
  | { kind: 'relocation'; id: string; card: RelocationCard; active: boolean }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/tui-relocation-view.test.ts`:

```ts
import * as assert from 'node:assert';
import { activeRelocation, relocationCard, relocationMessage } from '../../tui/view/relocation-view';
import { folderName } from '../../client-core/folder-name';
import { relocation } from '../fixtures/protocol';

suite('relocation-view: activeRelocation', () => {
  test('the newest pending or queued item is addressable, settled ones never are', () => {
    const items = [
      relocation({ id: 'r1', state: 'pending' }),
      relocation({ id: 'r2', state: 'moved' }),
      relocation({ id: 'r3', state: 'queued' }),
      relocation({ id: 'r4', state: 'stayed' }),
    ];
    assert.strictEqual(activeRelocation(items)?.id, 'r3');
    assert.strictEqual(activeRelocation([relocation({ state: 'moved' }), relocation({ id: 'x', state: 'stayed' })]), undefined);
    assert.strictEqual(activeRelocation([]), undefined);
  });
  test('an older pending offer loses to a newer one', () => {
    assert.strictEqual(activeRelocation([relocation({ id: 'a' }), relocation({ id: 'b' })])?.id, 'b');
  });
});

suite('relocation-view: relocationMessage', () => {
  test('pending: move and stay answer the offer', () => {
    assert.deepStrictEqual(relocationMessage('s1', relocation({ id: 'r1' }), 'move'), { t: 'answer-relocation', id: 's1', itemId: 'r1', move: true });
    assert.deepStrictEqual(relocationMessage('s1', relocation({ id: 'r1' }), 'stay'), { t: 'answer-relocation', id: 's1', itemId: 'r1', move: false });
  });
  test('queued: stay cancels, move does nothing', () => {
    const q = relocation({ id: 'r1', state: 'queued' });
    assert.deepStrictEqual(relocationMessage('s1', q, 'stay'), { t: 'cancel-relocation', id: 's1', itemId: 'r1' });
    assert.strictEqual(relocationMessage('s1', q, 'move'), undefined);
  });
  test('settled items post nothing', () => {
    for (const state of ['moved', 'stayed'] as const) {
      assert.strictEqual(relocationMessage('s1', relocation({ state }), 'move'), undefined);
      assert.strictEqual(relocationMessage('s1', relocation({ state }), 'stay'), undefined);
    }
  });
});

suite('relocation-view: card name', () => {
  test('the folder name survives odd paths and never goes blank', () => {
    assert.strictEqual(relocationCard(relocation({ path: '/repo/trees/feat-x' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: '/repo/trees/feat-x/' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: 'C:\\repo\\trees\\feat-x' })).name, 'feat-x');
    assert.strictEqual(relocationCard(relocation({ path: '' })).name, 'worktree');
    assert.strictEqual(relocationCard(relocation({ path: '/' })).name, '/');
  });
  test('folderName is the webview helper, moved', () => {
    assert.strictEqual(folderName('/a/b'), 'b');
  });
});
```

In `src/test/unit/tui-view.test.ts` add (import `relocation` from the fixtures) a case in the `transcriptRows` suite:

```ts
  test('a relocation becomes a card row; only the newest unsettled offer is active', () => {
    const rows = transcriptRows([
      relocation({ id: 'r1', state: 'pending' }),
      relocation({ id: 'r2', state: 'moved' }),
      relocation({ id: 'r3', state: 'pending' }),
    ], false);
    assert.deepStrictEqual(rows.map((r) => (r.kind === 'relocation' ? [r.id, r.card.state, r.active] : null)), [
      ['r1', 'pending', false], ['r2', 'moved', false], ['r3', 'pending', true],
    ]);
  });
```

If a pre-existing test in that file asserts the old one-line `Worktree move offered` notice, replace that assertion with the card-row shape above; do not keep both.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "relocation|tui view|transcriptRows"`
Expected: FAIL, modules missing / row kind unknown.

- [ ] **Step 3: Implement**

Create `src/client-core/folder-name.ts` (verbatim body from `src/webview/format.ts`):

```ts
/** Last path segment. The full path lives in a title; a narrow column has no room for it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
```

In `src/webview/format.ts` delete the local `folderName` and add `export { folderName } from '../client-core/folder-name';` (the file already re-exports `formatTokens` the same way).

Create `src/tui/view/relocation-view.ts`:

```ts
import { folderName } from '../../client-core/folder-name';
import type { SessionId, TranscriptItem, WebviewToHost } from '../../protocol/messages';

export type RelocationItem = Extract<TranscriptItem, { role: 'relocation' }>;
export interface RelocationCard { id: string; name: string; path: string; state: RelocationItem['state'] }

/** Keys address one offer at a time: the newest still-open one. An older open offer is shown but not answerable. */
export function activeRelocation(items: TranscriptItem[]): RelocationItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.role === 'relocation' && (it.state === 'pending' || it.state === 'queued')) { return it; }
  }
  return undefined;
}

export function relocationCard(item: RelocationItem): RelocationCard {
  return { id: item.id, name: item.path === '' ? 'worktree' : folderName(item.path), path: item.path, state: item.state };
}

export function relocationMessage(sessionId: SessionId, item: RelocationItem, key: 'move' | 'stay'): WebviewToHost | undefined {
  if (item.state === 'pending') { return { t: 'answer-relocation', id: sessionId, itemId: item.id, move: key === 'move' }; }
  // A queued move was already answered "move"; the only thing left to say is "never mind".
  if (item.state === 'queued' && key === 'stay') { return { t: 'cancel-relocation', id: sessionId, itemId: item.id }; }
  return undefined;
}
```

`src/tui/view/transcript-rows.ts`: import `activeRelocation, relocationCard, type RelocationCard`; add the union member `| { kind: 'relocation'; id: string; card: RelocationCard; active: boolean }`; compute `const activeId = activeRelocation(items)?.id;` before the loop; replace the `case 'relocation'` body with:

```ts
        rows.push({ kind: 'relocation', id: item.id, card: relocationCard(item), active: item.id === activeId });
        break;
```

`row.tsx` will not compile its exhaustive `switch` until Task 5; add a temporary `case 'relocation': return <text fg="gray">{row.card.name}</text>;` there so this commit type-checks, and replace it in Task 5.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn test:tui && yarn lint && yarn check-types && yarn check-types:tui`
Expected: PASS (`test:dom` covers the webview's `folderName` re-export).

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/client-core/folder-name.ts src/webview/format.ts src/tui src/test
git commit -m "feat: TUI relocation view model and transcript card row"
```

---

### Task 5: The relocation card

**Files:**
- Create: `src/tui/ui/transcript/relocation-card.tsx`
- Modify: `src/tui/ui/transcript/row.tsx`, `src/tui/ui/transcript/transcript.tsx`, `src/tui/ui/pane.tsx`
- Test: `src/test/tui/relocation-card.test.tsx`

**Interfaces:**
- Consumes: `RelocationCard` (Task 4), `Collapsible`, `useTheme`.
- Produces: `export type RelocationKeys = 'live' | 'idle' | 'none'`; `RelocationCardView({ card, active, keys, selected })`; `Transcript` and `RowView` gain `relocationKeys: RelocationKeys` (`Transcript` defaults it to `'none'`; `Pane` passes `owner ? 'none' : focused ? 'live' : 'idle'`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/tui/relocation-card.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { Transcript } from '../../tui/ui/transcript/transcript';
import type { RelocationKeys } from '../../tui/ui/transcript/relocation-card';
import { relocation, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const show = async (items: TranscriptItem[], keys: RelocationKeys = 'live') => {
  m = await mount(<Transcript sessionId="s1" focused relocationKeys={keys} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1')], snapshots: [snapshot('s1', { items })] }));
};

test('a pending offer names the folder, says history stays, and shows the live keys', async () => {
  await show([relocation({ path: '/repo/trees/feat-x' })]);
  const f = m!.frame();
  expect(f).toContain('feat-x');
  expect(f).toContain('Move this session there?');
  expect(f).toContain('^Y move');
  expect(f).toContain('^L stay');
});

test('an unfocused pane tells the reader where to answer instead of showing keys', async () => {
  await show([relocation()], 'idle');
  expect(m!.frame()).toContain('focus this pane to answer');
  expect(m!.frame().includes('^Y')).toBe(false);
});

test('a foreign session shows the offer with no hint at all', async () => {
  await show([relocation()], 'none');
  expect(m!.frame()).toContain('Move this session there?');
  expect(m!.frame().includes('^Y')).toBe(false);
  expect(m!.frame().includes('focus this pane')).toBe(false);
});

test('a queued move says it is waiting and offers the cancel key', async () => {
  await show([relocation({ state: 'queued', path: '/repo/trees/feat-x' })]);
  expect(m!.frame()).toContain('Interrupting the turn to move to feat-x');
  expect(m!.frame()).toContain('^L cancel');
  expect(m!.frame().includes('^Y')).toBe(false);
});

test('settled offers are one muted line with no keys', async () => {
  await show([relocation({ id: 'a', state: 'moved', path: '/repo/trees/feat-x' }), relocation({ id: 'b', state: 'stayed' })]);
  const f = m!.frame();
  expect(f).toContain('Moved to feat-x');
  expect(f).toContain('Stayed');
  expect(f.includes('^Y')).toBe(false);
  expect(f.includes('^L')).toBe(false);
});

test('an older unsettled offer is shown without keys while the newest carries them', async () => {
  await show([relocation({ id: 'old', path: '/repo/trees/old-one' }), relocation({ id: 'new', path: '/repo/trees/new-one' })]);
  const f = m!.frame();
  expect(f).toContain('old-one');
  expect(f).toContain('new-one');
  expect(f.split('^Y move').length - 1).toBe(1);
  expect(f).toContain('superseded');
});

test('a very long folder name stays inside the pane', async () => {
  await show([relocation({ path: `/repo/trees/${'x'.repeat(200)}` })]);
  expect(m!.frame().split('\n').every((r) => r.length <= 100)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui src/test/tui/relocation-card.test.tsx`
Expected: FAIL, cannot resolve `relocation-card`.

- [ ] **Step 3: Implement**

Create `src/tui/ui/transcript/relocation-card.tsx`:

```tsx
import { TextAttributes } from '@opentui/core';
import type { RelocationCard } from '../../view/relocation-view';
import { useTheme } from '../termcn/hooks/use-theme';
import { Collapsible } from './collapsible';

export type RelocationKeys = 'live' | 'idle' | 'none';

function hint(card: RelocationCard, active: boolean, keys: RelocationKeys): string | undefined {
  if (card.state === 'moved' || card.state === 'stayed') { return undefined; }
  if (!active) { return 'superseded by a newer offer'; }
  if (keys === 'none') { return undefined; }
  if (keys === 'idle') { return 'focus this pane to answer'; }
  return card.state === 'queued' ? '^L cancel' : '^Y move  ^L stay';
}

export function RelocationCardView(props: { card: RelocationCard; active: boolean; keys: RelocationKeys; selected: boolean }) {
  const theme = useTheme();
  const { card } = props;
  const muted = theme.colors.mutedForeground;
  const settled = card.state === 'moved' || card.state === 'stayed';
  const title = card.state === 'moved' ? `Moved to ${card.name}` : card.state === 'stayed' ? 'Stayed'
    : card.state === 'queued' ? `Interrupting the turn to move to ${card.name}` : 'New worktree';
  const keyHint = hint(card, props.active, props.keys);
  return (
    <Collapsible
      open={!settled}
      selected={props.selected}
      header={(
        <>
          <text fg={settled ? muted : theme.colors.warning} flexShrink={0}>⎇</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text fg={settled ? muted : undefined} attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{title}</text>
          </box>
          {card.state === 'pending' ? <box flexShrink={100} minWidth={0} height={1} overflow="hidden"><text fg={muted} wrapMode="none">{card.name}</text></box> : null}
        </>
      )}
    >
      {card.state === 'pending' ? <text fg={muted} wrapMode="word">Move this session there? Its history stays here.</text> : null}
      {keyHint ? <text fg={muted} wrapMode="none">{keyHint}</text> : null}
    </Collapsible>
  );
}
```

`row.tsx`: import `RelocationCardView, type RelocationKeys`; add `relocationKeys: RelocationKeys` to `RowView`'s props; replace the temporary Task 4 case with:

```tsx
    case 'relocation':
      return <RelocationCardView card={row.card} active={row.active} keys={props.relocationKeys} selected={props.selected} />;
```

`transcript.tsx`: add the prop `relocationKeys = 'none'` (type `RelocationKeys`) to `Transcript` and pass `relocationKeys={relocationKeys}` to `RowView`. `pane.tsx`: pass to `Transcript`:

```tsx
      <Transcript
        sessionId={id}
        focused={focused && liveZone === 'transcript'}
        relocationKeys={summary?.owner ? 'none' : focused ? 'live' : 'idle'}
        onFork={(itemId) => { onFork(id, itemId); }}
      />
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui && yarn lint && yarn check-types:tui`
Expected: PASS. If the "long folder name" test fails on the header, the pending header's trailing name box must be the shrinking one (`flexShrink={100}`), as in `tool-card.tsx`.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/tui src/test
git commit -m "feat: TUI relocation card"
```

---

### Task 6: Answer a relocation from the focused pane

**Files:**
- Modify: `src/tui/ui/use-app-keys.ts`, `src/tui/ui/app.tsx`
- Test: `src/test/tui/relocation-keys.test.tsx`

**Interfaces:**
- Consumes: `activeRelocation`, `relocationMessage` (Task 4); actions `relocation-move`/`relocation-stay` (Task 2).
- Produces: `AppKeys` gains `relocation: RelocationItem | undefined` (the focused, owned session's addressable offer, computed in `App`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/tui/relocation-keys.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { layoutOf, relocation, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const answers = () => (m?.posted ?? []).filter((p) => p.t === 'answer-relocation' || p.t === 'cancel-relocation');

const boot = async (items: TranscriptItem[], over: Parameters<typeof summary>[1] = {}) => {
  const s = summary('s1', over);
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', { ...s, items })] }));
};

test('Ctrl+Y answers move=true for the pending offer in the focused session', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('y', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 's1', itemId: 'r1', move: true }]);
});

test('Ctrl+L answers move=false', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('l', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 's1', itemId: 'r1', move: false }]);
});

test('a double press posts once', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('y', { ctrl: true });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(1);
});

test('queued: Ctrl+L cancels, Ctrl+Y does nothing, and a return to pending re-arms the keys', async () => {
  await boot([relocation({ id: 'r1', state: 'queued' })]);
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
  await m!.press('l', { ctrl: true });
  expect(answers()).toEqual([{ t: 'cancel-relocation', id: 's1', itemId: 'r1' }]);
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: relocation({ id: 'r1', state: 'pending' }) } });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(2);
  expect(answers()[1]).toEqual({ t: 'answer-relocation', id: 's1', itemId: 'r1', move: true });
});

test('no open offer, or a settled one, posts nothing', async () => {
  await boot([relocation({ id: 'r1', state: 'moved' })]);
  await m!.press('y', { ctrl: true });
  await m!.press('l', { ctrl: true });
  expect(answers().length).toBe(0);
});

test('a foreign session cannot be answered from here', async () => {
  await boot([relocation({ id: 'r1' })], { owner: { host: 'vscode', pid: 9 } });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
});

test('with two visible panes only the focused one is addressed, and its card is the one with keys', async () => {
  const a = summary('a');
  const b = summary('b');
  m = await mount(<App {...props} />, { width: 140, height: 40 });
  await m.fromHost(hydrateMsg({
    sessions: [a, b],
    layout: layoutOf(['a', 'b'], 'horizontal'),
    focusedSessionId: 'a',
    snapshots: [
      snapshot('a', { ...a, items: [relocation({ id: 'ra', path: '/repo/trees/for-a' })] }),
      snapshot('b', { ...b, items: [relocation({ id: 'rb', path: '/repo/trees/for-b' })] }),
    ],
  }));
  expect(m.frame().split('^Y move').length - 1).toBe(1);
  expect(m.frame()).toContain('focus this pane to answer');
  await m.press('y', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 'a', itemId: 'ra', move: true }]);
});

test('the keys are inert while a dialog owns the keyboard', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('p', { ctrl: true });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
});
```

If `hydrateMsg` does not accept `focusedSessionId`, find how `src/test/tui/pane-*.test.tsx` focuses a pane in a two-pane layout (grep `focus-pane` / `local-focus` in `src/test/tui`) and use that; the assertions stay. If the patch message shape differs from `session-patch { id, patch }`, copy the shape from `src/test/tui/transcript.test.tsx`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui src/test/tui/relocation-keys.test.tsx`
Expected: FAIL (nothing posts).

- [ ] **Step 3: Implement**

`src/tui/ui/use-app-keys.ts`: import `relocationMessage, type RelocationItem` from `../view/relocation-view`; add `relocation: RelocationItem | undefined;` to `AppKeys`; add `const answered = useRef<string | undefined>(undefined);` next to `armed`; and in the `switch`:

```ts
      case 'relocation-move':
      case 'relocation-stay': {
        const item = k.relocation;
        if (!s || !item) { return; }
        const msg = relocationMessage(s.id, item, action.do === 'relocation-move' ? 'move' : 'stay');
        // The patch that settles the item has to round-trip; keyed on state so a cancel that returns it to pending re-arms.
        const key = `${item.id}:${item.state}:${msg?.t}`;
        if (!msg || answered.current === key) { return; }
        answered.current = key;
        post(msg);
        return;
      }
```

(`msg?.t` in the key keeps `Ctrl+L` on a fresh `pending` distinct from the earlier `answer-relocation` on the same state, while a repeat of the same answer is still dropped. In the queued-cancel-pending-move test the keys are `r1:pending:answer-relocation` then `r1:queued:cancel-relocation` then `r1:pending:answer-relocation` again; since only the most recent key is stored, the third differs from the second and posts.)

`src/tui/ui/app.tsx`: import `activeRelocation` and pass to `useAppKeys`:

```ts
    relocation: summary && !summary.owner ? activeRelocation(pane?.items ?? []) : undefined,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui && yarn test:unit && yarn lint && yarn check-types && yarn check-types:tui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/tui src/test
git commit -m "feat: answer a TUI worktree relocation from the focused pane"
```

---

### Task 7: Docs, roadmap, final gate

**Files:**
- Modify: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`

- [ ] **Step 1: Update docs**

Run: `cd /e/Efebia/hiiiid-code && grep -n "Ctrl+T\|/context\|Ctrl+R" docs/tui.md`

In `docs/tui.md`, beside the `Ctrl+T` / `/context` rows (same row format) add `Ctrl+G` (refresh plan usage), `Ctrl+Y` (move to the offered worktree) and `Ctrl+L` (stay, or cancel a queued move). Add two short paragraphs: the roster's usage strip (percentages per window, reset countdown, hidden when nothing reports, click or `Ctrl+G` refreshes, marker until done), and the relocation card (states, keys, only the newest open offer in the focused pane is answerable, foreign sessions read-only). Add to the manual smoke checklist: "Open a worktree offer in a real Claude session: answer it with `Ctrl+Y`/`Ctrl+L` from a split with two panes; click the usage strip in Windows Terminal."

In `docs/superpowers/roadmap-tui.md`, under **Done** add: "**D2. Usage strip and relocation cards** (`feat/tui-awareness-usage-relocation`): usage windows in the roster header (`Ctrl+G` or click to refresh); relocation cards answered with `Ctrl+Y`/`Ctrl+L`. Plan `2026-10-02-tui-awareness-usage-relocation.md`. Not verified in a real terminal: strip click, chord delivery under a multiplexer." Remove the D2 line from **Next** and renumber (E becomes 1).

- [ ] **Step 2: Final gate**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui && yarn test:unit && yarn test:dom && yarn test:tui && yarn run compile`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add docs
git commit -m "docs: TUI usage strip, relocation cards and roadmap"
```
