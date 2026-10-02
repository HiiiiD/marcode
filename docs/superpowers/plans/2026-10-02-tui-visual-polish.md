# TUI visual polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Marcode TUI OpenCode-grade visuals: tinted left-bar panels, a terminal-derived color token set, native highlighted `<diff>` with split/unified by width, and highlighted markdown/code.

**Architecture:** A pure `deriveTokens()` turns the terminal's own palette (`renderer.getPalette()`) into RGB tints. A `TokensProvider` exposes them (and a `SyntaxStyle` built from them) beside the existing named-color termcn theme. Consumers (`Collapsible`, the message `Bar`, `ToolBlocks`) branch on `useTokens()`: tokens present gives the new look, `undefined` gives today's rendering unchanged.

**Tech Stack:** TypeScript, React 19 on `@opentui/react` 0.5.13 / `@opentui/core` 0.5.13, Bun (`bun test` for TUI), mocha + `tsx/cjs` (pure logic).

**Spec:** `docs/superpowers/specs/2026-10-02-tui-visual-polish-design.md`

## Global Constraints

- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM.
- Filenames are kebab-case.
- Named ANSI colors stay in `tui-theme.tsx` and termcn; RGB values come only from `deriveTokens`, never hardcoded hex in components.
- With no tokens the TUI renders exactly as before: every existing `src/test/tui` test must keep passing unmodified, except where a task says otherwise.
- TUI tests never hand a renderer or renderable to an assertion (`scripts/check-tui-asserts.mjs`).
- The webview must not change: `client-core/tool-render.ts` changes are additive (`unified?` on the diff block).
- Comments only for non-obvious "why". Files over ~300 lines get split.
- Commits: conventional prefixes, no Claude/Anthropic trailer.
- Shell: pin every command with its own `cd /e/Efebia/hiiiid-code &&` (cwd reverts mid-session).
- Gates before the final commit: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:unit`, `yarn test:tui`.

## Deviations from the spec (decided while planning)

- `diffView` and `filetype` live in `src/tui/ui/transcript/` next to their only consumer, not `util/`.
- `Collapsible` keeps its name and delegates to the new `Panel` when tokens exist, so `PermissionCard`/`SubagentCard`/`ToolCard` need no edits.
- Palette detection runs once in `main.tsx` before first render (`detectTokens`), so the provider is synchronous.
- Cards cap at 100 columns, so a 120-column split threshold could never fire. A card holding a native diff lifts its cap to 180 (`wide`).
- A diff over 120 lines, or whose hunk counts do not match, falls back to the existing clamped colored-line rendering.

## Review Focus

- Terminal returns `null`/non-hex colors for background or foreground: tokens are `undefined`, legacy render (Task 1, Task 4).
- Terminal never answers `getPalette`: boot must not hang; tokens `undefined` after a timeout (Task 4).
- Foreground ≈ background (or identical): no tints that vanish; tokens `undefined` (Task 1).
- Provider sends a unified diff whose hunk counts are wrong: must not reach `<diff>` and show a parse error; falls back to lines (Task 2, Task 6).
- A very large diff: must not render hundreds of tinted rows; falls back to the clamped lines with the "lines hidden" note (Task 6).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/tui/ui/tokens/color.ts` | create | hex parse/format, `mix`, `maxDelta`, `luminance` |
| `src/tui/ui/tokens/derive-tokens.ts` | create | `TuiTokens`, `deriveTokens(colors)` (pure, no opentui import) |
| `src/tui/ui/tokens/syntax-style.ts` | create | `buildSyntaxStyle(tokens)` |
| `src/tui/ui/tokens/tokens-provider.tsx` | create | `TokensProvider`, `useTokens`, `useSyntaxStyle` |
| `src/tui/ui/tokens/detect-tokens.ts` | create | `detectTokens(renderer, timeoutMs)` |
| `src/tui/ui/transcript/diff-view.ts` | create | `diffView(width)`, `hunksAreWellFormed`, constants (pure) |
| `src/tui/ui/transcript/filetype.ts` | create | `filetypeOf(path)` (pure) |
| `src/tui/ui/transcript/bar-border.ts` | create | shared left-bar `customBorderChars` |
| `src/tui/ui/transcript/panel.tsx` | create | tinted left-bar card frame |
| `src/tui/ui/transcript/diff-block.tsx` | create | measures its width, renders `<diff>` |
| `src/client-core/tool-render.ts` | modify | diff block gains `unified?` |
| `src/tui/ui/transcript/collapsible.tsx` | modify | delegate to `Panel` when tokens exist; `wide` prop |
| `src/tui/ui/transcript/row.tsx` | modify | `Bar` tint; `SyntaxStyle` from provider |
| `src/tui/ui/transcript/tool-blocks.tsx` | modify | native diff path with fallbacks |
| `src/tui/ui/transcript/tool-card.tsx` | modify | pass `wide` when a native diff is shown |
| `src/tui/ui/main.tsx` | modify | `detectTokens`, wrap in `TokensProvider` |
| `src/test/fixtures/terminal-colors.ts` | create | `DARK`/`LIGHT` palettes for tests |
| `src/test/unit/tui-derive-tokens.test.ts` | create | mocha |
| `src/test/unit/tui-diff-view.test.ts` | create | mocha (`diffView`, `hunksAreWellFormed`, `filetypeOf`) |
| `src/test/unit/tool-render.test.ts` | modify | expect `unified` |
| `src/test/tui/tokens.test.tsx` | create | provider, detect |
| `src/test/tui/panel.test.tsx` | create | tokened Collapsible/Bar |
| `src/test/tui/tool-blocks.test.tsx` | modify | native diff paths |
| `docs/tui.md`, `AGENTS.md` | modify | appearance note, path-table rows |

---

### Task 1: Color math and `deriveTokens`

**Files:**
- Create: `src/tui/ui/tokens/color.ts`, `src/tui/ui/tokens/derive-tokens.ts`, `src/test/fixtures/terminal-colors.ts`
- Test: `src/test/unit/tui-derive-tokens.test.ts`

**Interfaces:**
- Produces: `interface TerminalColorsLike { palette: (string | null)[]; defaultForeground: string | null; defaultBackground: string | null }` (structurally a subset of OpenTUI's `TerminalColors`); `interface TuiTokens` (below); `deriveTokens(c: TerminalColorsLike): TuiTokens | undefined`. Fixtures `DARK`, `LIGHT`: `TerminalColorsLike`.

- [ ] **Step 1: Write fixtures**

`src/test/fixtures/terminal-colors.ts`:

```ts
import type { TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';

const ANSI = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

export const DARK: TerminalColorsLike = { palette: ANSI, defaultForeground: '#d4d4d4', defaultBackground: '#1e1e1e' };
export const LIGHT: TerminalColorsLike = { palette: ANSI, defaultForeground: '#333333', defaultBackground: '#ffffff' };
```

- [ ] **Step 2: Write the failing tests**

`src/test/unit/tui-derive-tokens.test.ts`:

```ts
import * as assert from 'node:assert';
import { maxDelta, parseHex } from '../../tui/ui/tokens/color';
import { deriveTokens, type TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';
import { DARK, LIGHT } from '../fixtures/terminal-colors';

const rgb = (hex: string) => parseHex(hex)!;

suite('tui tokens: deriveTokens', () => {
  test('dark terminal: surfaces step toward the foreground and stay ordered', () => {
    const t = deriveTokens(DARK)!;
    const bg = rgb('#1e1e1e');
    assert.ok(maxDelta(rgb(t.panel), bg) >= 8);
    assert.ok(maxDelta(rgb(t.element), bg) > maxDelta(rgb(t.panel), bg));
    assert.ok(maxDelta(rgb(t.menu), bg) > maxDelta(rgb(t.element), bg));
    assert.ok(rgb(t.panel)[0] > bg[0]);
  });

  test('light terminal: surfaces step toward the (darker) foreground', () => {
    const t = deriveTokens(LIGHT)!;
    assert.ok(rgb(t.panel)[0] < 255);
    assert.ok(maxDelta(rgb(t.panel), rgb('#ffffff')) >= 8);
  });

  test('diff tints are visibly distinct from the panel on both polarities', () => {
    for (const colors of [DARK, LIGHT]) {
      const t = deriveTokens(colors)!;
      assert.ok(maxDelta(rgb(t.diff.addedBg), rgb(t.diff.contextBg)) >= 8);
      assert.ok(maxDelta(rgb(t.diff.removedBg), rgb(t.diff.contextBg)) >= 8);
      assert.notStrictEqual(t.diff.addedBg, t.diff.removedBg);
    }
  });

  test('missing palette slots fall back to standard ANSI values instead of throwing', () => {
    const t = deriveTokens({ ...DARK, palette: [] });
    assert.ok(t !== undefined);
    assert.match(t.syntax.keyword, /^#[0-9a-f]{6}$/);
  });

  test('null or non-hex default colors yield undefined', () => {
    assert.strictEqual(deriveTokens({ ...DARK, defaultBackground: null }), undefined);
    assert.strictEqual(deriveTokens({ ...DARK, defaultForeground: 'rgb:zz/zz/zz' }), undefined);
  });

  test('foreground too close to background yields undefined', () => {
    const same: TerminalColorsLike = { ...DARK, defaultForeground: '#202020', defaultBackground: '#1e1e1e' };
    assert.strictEqual(deriveTokens(same), undefined);
    assert.strictEqual(deriveTokens({ ...DARK, defaultForeground: '#1e1e1e' }), undefined);
  });

  test('every token is a #rrggbb string', () => {
    const t = deriveTokens(DARK)!;
    const all = [t.panel, t.menu, t.element, t.text, t.textMuted, ...Object.values(t.diff), ...Object.values(t.syntax), ...Object.values(t.markdown)];
    assert.deepStrictEqual(all.filter((v) => !/^#[0-9a-f]{6}$/.test(v)), []);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -20`
Expected: FAIL, cannot find module `tokens/color`.

- [ ] **Step 4: Implement `color.ts`**

```ts
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string | null | undefined): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) { return undefined; }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = (c: Rgb): string =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const maxDelta = (a: Rgb, b: Rgb): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export const luminance = (c: Rgb): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
```

- [ ] **Step 5: Implement `derive-tokens.ts`**

```ts
import { luminance, maxDelta, mix, parseHex, toHex, type Rgb } from './color';

export interface TerminalColorsLike {
  palette: (string | null)[];
  defaultForeground: string | null;
  defaultBackground: string | null;
}

export interface TuiTokens {
  panel: string; element: string; menu: string;
  text: string; textMuted: string;
  diff: {
    addedBg: string; removedBg: string; contextBg: string;
    addedLineNumberBg: string; removedLineNumberBg: string;
    lineNumber: string; addedSign: string; removedSign: string;
  };
  syntax: {
    comment: string; keyword: string; string: string; number: string; function: string;
    type: string; operator: string; variable: string; punctuation: string;
  };
  markdown: { heading: string; link: string; code: string; quote: string; strong: string };
}

const XTERM = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
// Below this fg/bg gap no tint is readable; above it, MIN_STEP keeps each surface visibly off the background.
const MIN_CONTRAST = 96;
const MIN_STEP = 8;

export function deriveTokens(c: TerminalColorsLike): TuiTokens | undefined {
  const bg = parseHex(c.defaultBackground);
  const fg = parseHex(c.defaultForeground);
  if (!bg || !fg) { return undefined; }
  const gap = maxDelta(bg, fg);
  if (gap < MIN_CONTRAST) { return undefined; }

  const light = luminance(bg) > 0.5;
  const ansi = (i: number): Rgb => parseHex(c.palette[i]) ?? parseHex(XTERM[i])!;
  // Bright variants read well on dark terminals; on light ones the normal slot has the contrast.
  const hue = (normal: number): Rgb => ansi(light ? normal : normal + 8);
  const surface = (t: number): Rgb => mix(bg, fg, Math.max(t, MIN_STEP / gap));

  const panel = surface(0.06);
  const tint = (hueRgb: Rgb, base: Rgb, t: number): string => toHex(mix(base, hueRgb, t));
  const muted = mix(bg, fg, 0.55);

  return {
    panel: toHex(panel),
    element: toHex(surface(0.09)),
    menu: toHex(surface(0.12)),
    text: toHex(fg),
    textMuted: toHex(muted),
    diff: {
      contextBg: toHex(panel),
      addedBg: tint(ansi(2), panel, 0.2),
      removedBg: tint(ansi(1), panel, 0.2),
      addedLineNumberBg: tint(ansi(2), panel, 0.3),
      removedLineNumberBg: tint(ansi(1), panel, 0.3),
      lineNumber: toHex(muted),
      addedSign: toHex(hue(2)),
      removedSign: toHex(hue(1)),
    },
    syntax: {
      comment: toHex(muted),
      keyword: toHex(hue(5)),
      string: toHex(hue(2)),
      number: toHex(hue(3)),
      function: toHex(hue(4)),
      type: toHex(hue(6)),
      operator: toHex(hue(6)),
      variable: toHex(fg),
      punctuation: toHex(muted),
    },
    markdown: {
      heading: toHex(hue(4)),
      link: toHex(hue(6)),
      code: toHex(hue(2)),
      quote: toHex(muted),
      strong: toHex(fg),
    },
  };
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -20`
Expected: PASS (all suites, including the new `tui tokens` ones).

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/tokens src/test/fixtures/terminal-colors.ts src/test/unit/tui-derive-tokens.test.ts && git commit -m "feat: derive TUI color tokens from the terminal palette"
```

---

### Task 2: `diffView`, `hunksAreWellFormed`, `filetypeOf`

**Files:**
- Create: `src/tui/ui/transcript/diff-view.ts`, `src/tui/ui/transcript/filetype.ts`
- Test: `src/test/unit/tui-diff-view.test.ts`

**Interfaces:**
- Produces: `SPLIT_MIN_WIDTH = 120`, `MAX_NATIVE_DIFF_LINES = 120`, `diffView(width: number): 'split' | 'unified'`, `hunksAreWellFormed(diff: string): boolean`, `filetypeOf(path: string | undefined): string | undefined`.

- [ ] **Step 1: Write the failing tests**

`src/test/unit/tui-diff-view.test.ts`:

```ts
import * as assert from 'node:assert';
import { diffView, hunksAreWellFormed, SPLIT_MIN_WIDTH } from '../../tui/ui/transcript/diff-view';
import { filetypeOf } from '../../tui/ui/transcript/filetype';

suite('tui diff: view choice', () => {
  test('narrow and unmeasured panes are unified, wide ones are split', () => {
    assert.strictEqual(diffView(0), 'unified');
    assert.strictEqual(diffView(SPLIT_MIN_WIDTH - 1), 'unified');
    assert.strictEqual(diffView(SPLIT_MIN_WIDTH), 'split');
  });
});

suite('tui diff: hunksAreWellFormed', () => {
  test('a single hunk with matching counts is accepted, headers or not', () => {
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\n-old\n+new'), true);
    assert.strictEqual(hunksAreWellFormed('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n'), true);
  });

  test('two hunks and the no-newline marker are accepted', () => {
    const d = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10 @@\n-x\n+y\n\\ No newline at end of file';
    assert.strictEqual(hunksAreWellFormed(d), true);
  });

  test('a count mismatch is rejected', () => {
    assert.strictEqual(hunksAreWellFormed('@@ -1,3 +1,3 @@\n-old\n+new'), false);
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\n-old\n+new\n+extra'), false);
  });

  test('no hunk header, or a stray non-diff line inside a hunk, is rejected', () => {
    assert.strictEqual(hunksAreWellFormed('-old\n+new'), false);
    assert.strictEqual(hunksAreWellFormed('@@ -1 +1 @@\nxyz'), false);
    assert.strictEqual(hunksAreWellFormed(''), false);
  });
});

suite('tui diff: filetypeOf', () => {
  test('maps extensions the bundled parsers understand', () => {
    assert.strictEqual(filetypeOf('/a/b.ts'), 'typescript');
    assert.strictEqual(filetypeOf('C:\\a\\B.TSX'), 'typescript');
    assert.strictEqual(filetypeOf('x.mjs'), 'javascript');
    assert.strictEqual(filetypeOf('README.md'), 'markdown');
  });

  test('unknown, extensionless and missing paths are undefined', () => {
    assert.strictEqual(filetypeOf('Makefile'), undefined);
    assert.strictEqual(filetypeOf('a.rs'), undefined);
    assert.strictEqual(filetypeOf(undefined), undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15`
Expected: FAIL, cannot find module `transcript/diff-view`.

- [ ] **Step 3: Implement `diff-view.ts`**

```ts
export const SPLIT_MIN_WIDTH = 120;
export const MAX_NATIVE_DIFF_LINES = 120;

export const diffView = (width: number): 'split' | 'unified' => (width >= SPLIT_MIN_WIDTH ? 'split' : 'unified');

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** `<diff>` shows a parse error for a hunk whose counts lie, so only well-formed patches reach it. */
export function hunksAreWellFormed(diff: string): boolean {
  let oldLeft = 0;
  let newLeft = 0;
  let hunks = 0;
  for (const line of diff.split('\n')) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk) {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLeft = m[2] === undefined ? 1 : Number(m[2]);
        hunks += 1;
      }
      continue;
    }
    const c = line[0];
    if (c === '\\') { continue; }
    if (c === '-') { oldLeft -= 1; }
    else if (c === '+') { newLeft -= 1; }
    else if (c === ' ' || line === '') { oldLeft -= 1; newLeft -= 1; }
    else { return false; }
    if (oldLeft < 0 || newLeft < 0) { return false; }
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0;
}
```

Note: a trailing `''` after the final newline arrives while `oldLeft`/`newLeft` are both 0, so it takes the `!inHunk` branch and is ignored.

- [ ] **Step 4: Implement `filetype.ts`**

```ts
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', md: 'markdown', markdown: 'markdown',
};

export function filetypeOf(path: string | undefined): string | undefined {
  if (!path) { return undefined; }
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : BY_EXT[name.slice(dot + 1).toLowerCase()];
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/transcript/diff-view.ts src/tui/ui/transcript/filetype.ts src/test/unit/tui-diff-view.test.ts && git commit -m "feat: diff view choice, hunk validation and filetype lookup for the TUI"
```

---

### Task 3: `unified` on the diff block

**Files:**
- Modify: `src/client-core/tool-render.ts:46` and `:176-191` (`editBlocks`)
- Modify: `src/test/unit/tool-render.test.ts:~208` (the "unified diff is stripped" test)

**Interfaces:**
- Produces: `ToolBlock` diff variant `{ kind: 'diff'; lines: string[]; unified?: string }`. `unified` is set only when the file has a `unifiedDiff` containing a `@@` line and no `before`/`after` edits.

- [ ] **Step 1: Update/add tests**

In `src/test/unit/tool-render.test.ts`, change the expectation of `'a unified diff is stripped to its body lines'` to:

```ts
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a.ts' },
      { kind: 'diff', lines: ['-old', '+new'], unified: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new' },
    ]);
```

Add right after it:

```ts
  test('a unified diff without hunk headers, or mixed with before/after edits, carries no unified text', () => {
    const noHunk = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'modify', unifiedDiff: '-old\n+new' }],
    });
    assert.deepStrictEqual(noHunk[1], { kind: 'diff', lines: ['-old', '+new'] });
    const mixed = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'modify', edits: [{ before: 'a', after: 'b' }], unifiedDiff: '@@ -1 +1 @@\n-x\n+y' }],
    });
    assert.strictEqual((mixed[1] as { unified?: string }).unified, undefined);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -20`
Expected: FAIL on the first changed test (no `unified` key yet).

- [ ] **Step 3: Implement**

`tool-render.ts` line 46:

```ts
  | { kind: 'diff'; lines: string[]; unified?: string }
```

In `editBlocks`, replace the `if (lines.length > 0) { blocks.push({ kind: 'diff', lines }); }` line with:

```ts
  // Only a lone, hunk-bearing patch can be handed to a real diff renderer; mixed sources have no single patch.
  const unified = !file.edits?.length && file.unifiedDiff && /^@@/m.test(file.unifiedDiff) ? file.unifiedDiff : undefined;
  if (lines.length > 0) { blocks.push(unified === undefined ? { kind: 'diff', lines } : { kind: 'diff', lines, unified }); }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15 && yarn check-types 2>&1 | tail -5 && yarn test:dom 2>&1 | tail -8`
Expected: PASS (webview DOM tests unaffected).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/client-core/tool-render.ts src/test/unit/tool-render.test.ts && git commit -m "feat: carry the raw unified patch on diff tool blocks"
```

---

### Task 4: Tokens provider, syntax style, boot-time detection

**Files:**
- Create: `src/tui/ui/tokens/syntax-style.ts`, `src/tui/ui/tokens/tokens-provider.tsx`, `src/tui/ui/tokens/detect-tokens.ts`
- Modify: `src/tui/ui/main.tsx`
- Test: `src/test/tui/tokens.test.tsx`

**Interfaces:**
- Consumes: `deriveTokens`, `TuiTokens`, `TerminalColorsLike` (Task 1).
- Produces: `buildSyntaxStyle(tokens: TuiTokens | undefined): SyntaxStyle`; `<TokensProvider tokens={TuiTokens | undefined}>`; `useTokens(): TuiTokens | undefined`; `useSyntaxStyle(): SyntaxStyle`; `detectTokens(renderer: { getPalette(o?: { timeout?: number }): Promise<TerminalColorsLike> }, timeoutMs?: number): Promise<TuiTokens | undefined>`.

- [ ] **Step 1: Write the failing tests**

`src/test/tui/tokens.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { detectTokens } from '../../tui/ui/tokens/detect-tokens';
import { deriveTokens, type TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider, useSyntaxStyle, useTokens } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const tokens = useTokens();
  const style = useSyntaxStyle();
  return <text>{`${tokens ? 'tokens' : 'none'}:${typeof style}`}</text>;
}

test('without a provider there are no tokens, but a syntax style still exists', async () => {
  m = await mount(<Probe />);
  expect(m.frame()).toContain('none:object');
});

test('a provider exposes its tokens', async () => {
  m = await mount(<TokensProvider tokens={deriveTokens(DARK)}><Probe /></TokensProvider>);
  expect(m.frame()).toContain('tokens:object');
});

test('detectTokens derives tokens from the renderer palette', async () => {
  const t = await detectTokens({ getPalette: async () => DARK });
  expect(t?.panel === deriveTokens(DARK)?.panel).toBe(true);
});

test('detectTokens is undefined when the palette has no usable colors', async () => {
  const t = await detectTokens({ getPalette: async () => ({ ...DARK, defaultBackground: null }) });
  expect(t === undefined).toBe(true);
});

test('detectTokens is undefined when getPalette rejects', async () => {
  const t = await detectTokens({ getPalette: async () => { throw new Error('unsupported'); } });
  expect(t === undefined).toBe(true);
});

test('detectTokens gives up when the terminal never answers', async () => {
  const t0 = Date.now();
  const t = await detectTokens({ getPalette: () => new Promise<TerminalColorsLike>(() => undefined) }, 30);
  expect(t === undefined).toBe(true);
  expect(Date.now() - t0 < 500).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tokens.test.tsx 2>&1 | tail -15`
Expected: FAIL, cannot resolve `tokens/detect-tokens`.

- [ ] **Step 3: Implement `syntax-style.ts`**

```ts
import { SyntaxStyle } from '@opentui/core';
import type { TuiTokens } from './derive-tokens';

export function buildSyntaxStyle(t: TuiTokens | undefined): SyntaxStyle {
  if (!t) { return SyntaxStyle.create(); }
  const { syntax: s, markdown: md } = t;
  return SyntaxStyle.fromStyles({
    default: { fg: t.text },
    comment: { fg: s.comment, italic: true },
    keyword: { fg: s.keyword },
    string: { fg: s.string },
    number: { fg: s.number },
    function: { fg: s.function },
    'function.method': { fg: s.function },
    type: { fg: s.type },
    operator: { fg: s.operator },
    variable: { fg: s.variable },
    punctuation: { fg: s.punctuation },
    'markup.heading': { fg: md.heading, bold: true },
    'markup.strong': { fg: md.strong, bold: true },
    'markup.italic': { fg: t.text, italic: true },
    'markup.raw': { fg: md.code },
    'markup.link': { fg: md.link },
    'markup.link.url': { fg: md.link, underline: true },
    'markup.quote': { fg: md.quote, italic: true },
  });
}
```

- [ ] **Step 4: Implement `tokens-provider.tsx`**

```tsx
import type { SyntaxStyle } from '@opentui/core';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TuiTokens } from './derive-tokens';
import { buildSyntaxStyle } from './syntax-style';

interface TokensValue { tokens: TuiTokens | undefined; syntaxStyle: SyntaxStyle | undefined }

const Ctx = createContext<TokensValue>({ tokens: undefined, syntaxStyle: undefined });
let fallback: SyntaxStyle | undefined;

export function TokensProvider(props: { tokens: TuiTokens | undefined; children: ReactNode }) {
  const value = useMemo(
    () => ({ tokens: props.tokens, syntaxStyle: buildSyntaxStyle(props.tokens) }),
    [props.tokens],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export const useTokens = (): TuiTokens | undefined => useContext(Ctx).tokens;

export function useSyntaxStyle(): SyntaxStyle {
  const { syntaxStyle } = useContext(Ctx);
  // Native handle is allocated lazily so importing this module costs nothing.
  return syntaxStyle ?? (fallback ??= buildSyntaxStyle(undefined));
}
```

- [ ] **Step 5: Implement `detect-tokens.ts`**

```ts
import { deriveTokens, type TerminalColorsLike, type TuiTokens } from './derive-tokens';

export async function detectTokens(
  renderer: { getPalette(options?: { timeout?: number }): Promise<TerminalColorsLike> },
  timeoutMs = 400,
): Promise<TuiTokens | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, timeoutMs); });
  try {
    const colors = await Promise.race([renderer.getPalette({ timeout: timeoutMs }), never]);
    return colors ? deriveTokens(colors) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 6: Wire `main.tsx`**

Add imports:

```tsx
import { detectTokens } from './tokens/detect-tokens';
import { TokensProvider } from './tokens/tokens-provider';
```

After the `try { renderer = await createCliRenderer(...) } catch { ... }` block and before `const loginCommands`, add:

```tsx
  const tokens = await detectTokens(renderer);
```

Wrap the render tree: inside `<TuiThemeProvider>` put `<TokensProvider tokens={tokens}>` around `<TuiStoreProvider ...>...</TuiStoreProvider>` and close it before `</TuiThemeProvider>`.

- [ ] **Step 7: Run to verify pass**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tokens.test.tsx 2>&1 | tail -15 && yarn check-types:tui 2>&1 | tail -8`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/tokens src/tui/ui/main.tsx src/test/tui/tokens.test.tsx && git commit -m "feat: provide terminal-derived tokens and a syntax style to the TUI"
```

---

### Task 5: Tinted panels and message bars

**Files:**
- Create: `src/tui/ui/transcript/bar-border.ts`, `src/tui/ui/transcript/panel.tsx`
- Modify: `src/tui/ui/transcript/collapsible.tsx`, `src/tui/ui/transcript/row.tsx`
- Test: `src/test/tui/panel.test.tsx`

**Interfaces:**
- Consumes: `useTokens`, `useSyntaxStyle`, `TokensProvider` (Task 4); `deriveTokens`, `TuiTokens` (Task 1).
- Produces: `BAR_CHARS: BorderCharacters`; `Panel(props: { tokens: TuiTokens; open: boolean; selected: boolean; maxWidth: number; header: ReactNode; children?: ReactNode })`; `Collapsible` gains optional `wide?: boolean` (cap 180 instead of 100).

- [ ] **Step 1: Write the failing tests**

`src/test/tui/panel.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { Collapsible } from '../../tui/ui/transcript/collapsible';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const tokens = deriveTokens(DARK);
const card = (open: boolean, selected = false, wide = false) => (
  <TokensProvider tokens={tokens}>
    <Collapsible open={open} selected={selected} wide={wide} header={<text>HEADER</text>}>
      <text>BODY</text>
    </Collapsible>
  </TokensProvider>
);
const spans = () => m!.setup.captureSpans().lines.flatMap((l) => l.spans);
const bgOf = (needle: string) => spans().find((s) => s.text.includes(needle))?.bg.toString() ?? '';

test('a tokened card has a left bar and no box frame', async () => {
  m = await mount(card(false));
  const f = m.frame();
  expect(f).toContain('HEADER');
  expect(f).toContain('┃');
  expect(['┌', '┐', '└', '┘'].some((c) => f.includes(c))).toBe(false);
});

test('the header span carries a painted background', async () => {
  m = await mount(card(false));
  expect(bgOf('HEADER') === '').toBe(false);
});

test('selecting swaps the tint to the menu surface', async () => {
  m = await mount(card(false, false));
  const idle = bgOf('HEADER');
  m.destroy();
  m = await mount(card(false, true));
  expect(bgOf('HEADER') === idle).toBe(false);
});

test('open shows the body; closed hides it', async () => {
  m = await mount(card(true));
  expect(m.frame()).toContain('BODY');
  m.destroy();
  m = await mount(card(false));
  expect(m.frame().includes('BODY')).toBe(false);
});

test('width is capped at 100, or 180 when wide', async () => {
  // A long unbroken header fills the card, so the widest row is the card width (the tint has no right border to measure).
  const long = (wide: boolean) => (
    <TokensProvider tokens={tokens}>
      <Collapsible open={false} selected={false} wide={wide} header={<text>{'x'.repeat(200)}</text>} />
    </TokensProvider>
  );
  const widest = () => Math.max(...m!.frame().split('\n').map((r) => r.trimEnd().length));
  m = await mount(long(false), { width: 220, height: 10 });
  expect(widest() <= 100).toBe(true);
  m.destroy();
  m = await mount(long(true), { width: 220, height: 10 });
  const w = widest();
  expect(w > 100 && w <= 180).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/panel.test.tsx 2>&1 | tail -15`
Expected: FAIL (`wide` unknown / frame still shows `┌`).

- [ ] **Step 3: Implement `bar-border.ts`**

```ts
import type { BorderCharacters } from '@opentui/core';

// Every glyph but the vertical is empty so `border={['left']}` draws a bare heavy bar and no frame.
export const BAR_CHARS: BorderCharacters = {
  topLeft: '', topRight: '', bottomLeft: '', bottomRight: '', horizontal: ' ',
  vertical: '┃', topT: '', bottomT: '', leftT: '', rightT: '', cross: '',
};
```

- [ ] **Step 4: Implement `panel.tsx`**

```tsx
import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';
import type { TuiTokens } from '../tokens/derive-tokens';
import { BAR_CHARS } from './bar-border';

export function Panel(props: {
  tokens: TuiTokens; open: boolean; selected: boolean; maxWidth: number; header: ReactNode; children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      maxWidth={props.maxWidth}
      marginBottom={1}
      border={['left']}
      customBorderChars={BAR_CHARS}
      borderColor={props.selected ? theme.colors.primary : theme.colors.border}
      backgroundColor={props.selected ? props.tokens.menu : props.tokens.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" gap={1}>{props.header}</box>
      {props.open ? <box flexDirection="column" paddingTop={1}>{props.children}</box> : null}
    </box>
  );
}
```

- [ ] **Step 5: Modify `collapsible.tsx`**

Replace the file with:

```tsx
import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';
import { useTokens } from '../tokens/tokens-provider';
import { Panel } from './panel';

const MAX_WIDTH = 100;
// A native diff needs room to go side by side; prose and command output stay at the readable measure.
const WIDE_MAX_WIDTH = 180;

export function Collapsible(props: { open: boolean; selected: boolean; wide?: boolean; header: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  const tokens = useTokens();
  const maxWidth = props.wide ? WIDE_MAX_WIDTH : MAX_WIDTH;
  if (tokens) {
    return <Panel tokens={tokens} open={props.open} selected={props.selected} maxWidth={maxWidth} header={props.header}>{props.children}</Panel>;
  }
  const border = theme.colors.border;
  return (
    <box
      flexDirection="column"
      maxWidth={maxWidth}
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

- [ ] **Step 6: Modify `row.tsx`**

Replace the module-level `const syntaxStyle = SyntaxStyle.create();` and the `SyntaxStyle` import, and rework `Bar`:

```tsx
import type { ReactNode } from 'react';
import type { TranscriptRow } from '../../view/transcript-rows';
import { ChatMessage } from '../termcn/components/ui/chat-message';
import { useTheme } from '../termcn/hooks/use-theme';
import { useSyntaxStyle, useTokens } from '../tokens/tokens-provider';
import { BAR_CHARS } from './bar-border';
import { PermissionCard } from './permission-card';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';

// Readable measure on wide terminals; the bar groups a message with its body.
const MAX_WIDTH = 100;

function Bar({ color, tint, children }: { color: string; tint?: boolean; children: ReactNode }) {
  const tokens = useTokens();
  return (
    <box
      maxWidth={MAX_WIDTH}
      marginBottom={1}
      border={['left']}
      borderStyle="single"
      {...(tokens ? { customBorderChars: BAR_CHARS } : {})}
      borderColor={color}
      backgroundColor={tokens && tint ? tokens.panel : undefined}
      paddingLeft={1}
    >
      {children}
    </box>
  );
}
```

In `RowView`: add `const syntaxStyle = useSyntaxStyle();` after `const theme = useTheme();`, and change the user case to `<Bar color={theme.colors.primary} tint>`. The assistant case stays `<Bar color={theme.colors.success}>` (untinted prose).

- [ ] **Step 7: Run to verify pass, then the whole TUI suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/panel.test.tsx 2>&1 | tail -15 && yarn test:tui 2>&1 | tail -15`
Expected: PASS everywhere; the pre-existing `collapsible.test.tsx` still passes untouched (no provider means legacy frame).

- [ ] **Step 8: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/transcript src/test/tui/panel.test.tsx && git commit -m "feat: tinted left-bar panels and message bars in the TUI"
```

---

### Task 6: Native `<diff>` in tool blocks

**Files:**
- Create: `src/tui/ui/transcript/diff-block.tsx`
- Modify: `src/tui/ui/transcript/tool-blocks.tsx`, `src/tui/ui/transcript/tool-card.tsx`
- Test: `src/test/tui/tool-blocks.test.tsx` (add cases)

**Interfaces:**
- Consumes: `diffView`, `hunksAreWellFormed`, `MAX_NATIVE_DIFF_LINES` (Task 2); `filetypeOf` (Task 2); `ToolBlock` diff with `unified?` (Task 3); `useTokens`, `useSyntaxStyle` (Task 4); `Collapsible.wide` (Task 5).
- Produces: `DiffBlock(props: { unified: string; filetype: string | undefined; tokens: TuiTokens })`; exported helper `nativeDiff(block: ToolBlock, tokens: TuiTokens | undefined): string | undefined` returning the patch text only when the native path applies.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/tui/tool-blocks.test.tsx` (add imports at the top: `deriveTokens`, `TokensProvider`, `DARK`):

```tsx
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';

const PATCH = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;';
const lines = ['-const old = 1;', '+const next = 2;'];
const tokened = (blocks: ToolBlock[], size = { width: 100, height: 40 }) => mount(
  <TokensProvider tokens={deriveTokens(DARK)}><ToolBlocks blocks={blocks} /></TokensProvider>, size,
);
const bgOf = (needle: string) =>
  m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))?.bg.toString() ?? '';

test('with tokens a unified patch renders natively: both sides visible, added and removed rows tinted differently', async () => {
  m = await tokened([{ kind: 'path', path: '/a.ts' }, { kind: 'diff', lines, unified: PATCH }]);
  const f = m.frame();
  expect(f).toContain('const old');
  expect(f).toContain('const next');
  expect(bgOf('const old') === bgOf('const next')).toBe(false);
});

test('a wide pane shows the patch split, a narrow one unified', async () => {
  m = await tokened([{ kind: 'diff', lines, unified: PATCH }], { width: 160, height: 20 });
  const row = m.frame().split('\n').find((r) => r.includes('const old'));
  expect(row !== undefined && row.includes('const next')).toBe(true);
  m.destroy();
  m = await tokened([{ kind: 'diff', lines, unified: PATCH }], { width: 80, height: 20 });
  const narrow = m.frame().split('\n').find((r) => r.includes('const old'));
  expect(narrow !== undefined && narrow.includes('const next')).toBe(false);
});

test('a patch whose hunk counts lie falls back to the colored lines', async () => {
  m = await tokened([{ kind: 'diff', lines, unified: '@@ -1,5 +1,5 @@\n-const old = 1;\n+const next = 2;' }]);
  expect(m.frame()).toContain('-const old = 1;');
  expect(m.frame()).toContain('+const next = 2;');
});

test('a very large patch falls back to the clamped lines with the hidden-lines note', async () => {
  const body = Array.from({ length: 150 }, (_, i) => `-gone ${i}`).concat(Array.from({ length: 150 }, (_, i) => `+come ${i}`));
  const unified = `@@ -1,150 +1,150 @@\n${body.join('\n')}`;
  m = await tokened([{ kind: 'diff', lines: body, unified }], { width: 100, height: 60 });
  expect(m.frame()).toContain('lines hidden');
});

test('without tokens a patch still renders as prefixed lines', async () => {
  const f = await show([{ kind: 'diff', lines, unified: PATCH }]);
  expect(f).toContain('-const old = 1;');
  expect(f).toContain('+const next = 2;');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tool-blocks.test.tsx 2>&1 | tail -20`
Expected: FAIL (native cases show prefixed lines, no tint difference / no split).

- [ ] **Step 3: Implement `diff-block.tsx`**

```tsx
import type { BoxRenderable } from '@opentui/core';
import { useRef, useState } from 'react';
import type { TuiTokens } from '../tokens/derive-tokens';
import { useSyntaxStyle } from '../tokens/tokens-provider';
import { diffView } from './diff-view';

export function DiffBlock(props: { unified: string; filetype: string | undefined; tokens: TuiTokens }) {
  const { tokens: t } = props;
  const syntaxStyle = useSyntaxStyle();
  const box = useRef<BoxRenderable | null>(null);
  // Pane width, not terminal width: panes resize independently, and an equal value bails out of the re-render.
  const [width, setWidth] = useState(0);
  return (
    <box ref={box} width="100%" onSizeChange={() => { setWidth(box.current?.width ?? 0); }}>
      <diff
        diff={props.unified}
        view={diffView(width)}
        filetype={props.filetype}
        syntaxStyle={syntaxStyle}
        showLineNumbers
        width="100%"
        wrapMode="word"
        fg={t.text}
        addedBg={t.diff.addedBg}
        removedBg={t.diff.removedBg}
        contextBg={t.diff.contextBg}
        addedSignColor={t.diff.addedSign}
        removedSignColor={t.diff.removedSign}
        lineNumberFg={t.diff.lineNumber}
        lineNumberBg={t.diff.contextBg}
        addedLineNumberBg={t.diff.addedLineNumberBg}
        removedLineNumberBg={t.diff.removedLineNumberBg}
      />
    </box>
  );
}
```

- [ ] **Step 4: Modify `tool-blocks.tsx`**

Add imports:

```tsx
import type { TuiTokens } from '../tokens/derive-tokens';
import { useTokens } from '../tokens/tokens-provider';
import { DiffBlock } from './diff-block';
import { hunksAreWellFormed, MAX_NATIVE_DIFF_LINES } from './diff-view';
import { filetypeOf } from './filetype';
```

Add above `ToolBlocks`:

```tsx
export function nativeDiff(block: ToolBlock, tokens: TuiTokens | undefined): string | undefined {
  if (!tokens || block.kind !== 'diff' || block.unified === undefined) { return undefined; }
  if (block.lines.length > MAX_NATIVE_DIFF_LINES || !hunksAreWellFormed(block.unified)) { return undefined; }
  return block.unified;
}
```

Replace `ToolBlocks` with:

```tsx
export function ToolBlocks(props: { blocks: ToolBlock[] }) {
  const theme = useTheme();
  const tokens = useTokens();
  const colors = { muted: theme.colors.mutedForeground, ok: theme.colors.success, bad: theme.colors.error };
  // A diff block has no path of its own; it belongs to the path block just before it.
  let path: string | undefined;
  return (
    <box flexDirection="column">
      {props.blocks.map((block, i) => {
        if (block.kind === 'path') { path = block.path; }
        const patch = nativeDiff(block, tokens);
        if (patch !== undefined && tokens) { return <DiffBlock key={i} unified={patch} filetype={filetypeOf(path)} tokens={tokens} />; }
        return blockLines(block, colors).map((l, j) => (
          <text key={`${i}-${j}`} fg={l.fg} attributes={l.attributes} wrapMode="word">{l.text}</text>
        ));
      })}
    </box>
  );
}
```

- [ ] **Step 5: Modify `tool-card.tsx`**

Add imports `useTokens` and `nativeDiff`:

```tsx
import { useTokens } from '../tokens/tokens-provider';
import { nativeDiff, ToolBlocks } from './tool-blocks';
```

(replace the existing `import { ToolBlocks } from './tool-blocks';`). Inside `ToolCard`, after `const output = ...` add:

```tsx
  const tokens = useTokens();
  const inputBlocks = open ? describeInput(item.tool) : [];
  const wide = inputBlocks.some((b) => nativeDiff(b, tokens) !== undefined);
```

Pass `wide={wide}` to `<Collapsible ...>` and replace `{open ? <ToolBlocks blocks={describeInput(item.tool)} /> : null}` with `{open ? <ToolBlocks blocks={inputBlocks} /> : null}`.

- [ ] **Step 6: Run to verify pass, then the whole TUI suite and types**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tool-blocks.test.tsx 2>&1 | tail -20 && yarn test:tui 2>&1 | tail -15 && yarn check-types:tui 2>&1 | tail -8`
Expected: PASS. If the split/unified frame assertion fails because the renderer lays split out differently than "both sides on one row", inspect with `console.log(m.frame())` and adjust only the assertion's selector, not the behavior.

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/transcript src/test/tui/tool-blocks.test.tsx && git commit -m "feat: render tool diffs with the native OpenTUI diff renderable"
```

---

### Task 7: Docs, full gates, manual check

**Files:**
- Modify: `docs/tui.md`, `AGENTS.md` (path table)

- [ ] **Step 1: Document**

Add to `docs/tui.md` a section:

```md
## Appearance

Panels, diffs and code are tinted from your terminal's own colors: at start the TUI asks the
terminal for its background, foreground and ANSI palette (OSC) and derives the surfaces from them,
so light and dark terminals both work. If the terminal does not answer within 400 ms, or the colors
are unusable (foreground nearly equal to background), the TUI falls back to plain named colors
and bordered cards. Diffs render with line numbers and syntax highlighting; a card at least
120 columns wide shows them side by side. Diffs over 120 lines, or patches the renderer cannot parse,
show as clamped +/- lines.
```

Add rows to the `AGENTS.md` path table, after the `src/tui/ui/termcn/` row:

```md
| `src/tui/ui/tokens/` | `deriveTokens` (terminal palette to RGB surfaces, diff and syntax tints), `TokensProvider`, `detectTokens`; consumers fall back to named colors when tokens are `undefined` |
| `src/tui/ui/transcript/panel.tsx`, `diff-block.tsx`, `diff-view.ts` | Tinted left-bar card frame; native `<diff>` with width-chosen split/unified; hunk validation before a patch reaches the renderer |
```

- [ ] **Step 2: Run every gate**

Run: `cd /e/Efebia/hiiiid-code && yarn lint 2>&1 | tail -10 && yarn check-types 2>&1 | tail -5 && yarn check-types:tui 2>&1 | tail -5 && yarn test:unit 2>&1 | tail -8 && yarn test:dom 2>&1 | tail -8 && yarn test:tui 2>&1 | tail -8`
Expected: all exit 0. Fix anything red before committing; never skip a hook.

- [ ] **Step 3: Manual verification in a real terminal**

Run: `cd /e/Efebia/hiiiid-code && yarn build:tui && bun dist/tui/tui.js`
Check by eye, in one dark and one light terminal theme: user message tinted with a left bar; a tool card shows the tinted panel, the selected card uses the lighter surface; ask a session to edit a `.ts` file and expand the card for a highlighted diff with line numbers; resize the window across about 120 columns and confirm split to unified; run in a terminal that blocks OSC queries (or `TERM=dumb`) and confirm the old bordered look and a normal start (under half a second of delay).

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add docs/tui.md AGENTS.md && git commit -m "docs: TUI appearance and token layer"
```
