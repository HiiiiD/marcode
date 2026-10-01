# TUI termcn adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Marcode TUI termcn visuals (theme, dialog frame, confirm, chips, tool and message rows) without changing any behaviour.

**Architecture:** termcn items are installed with the shadcn CLI into `src/tui/ui/termcn/`, which has its own `components.json` + `package.json` + `tsconfig.json`. Our code imports them by relative path; only generated files use the `@termcn/*` alias. Our zone keymap stays the single key handler: where an installed component would double-handle keys or run timers unconditionally, a small recorded patch (`PATCHES.md`) fixes it.

**Tech Stack:** OpenTUI (`@opentui/react` 0.5.13) on Bun, shadcn CLI (`shadcn@latest`, v4.x), termcn registry (`https://termcn.dev/r/{name}.json`), `bun test`, mocha.

**Spec:** `docs/superpowers/specs/2026-10-01-tui-termcn-adoption-design.md`

## Global Constraints

- Work only on branch `feat/tui-termcn` (never push, never merge, no worktrees). Check with `cd /e/Efebia/hiiiid-code && git branch --show-current` before every commit.
- Commit prefixes `feat:`, `fix:`, `test:`, `docs:`, `chore:`. **No `Co-Authored-By` and no Claude/Anthropic trailer.** Verify the message with `git log -1 --format=%B` after committing.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM; `src/protocol/messages.ts` stays types-only. This plan touches none of `client-core` or `protocol`.
- Never run `yarn build:tui:bin`. Never create scratch or experiment folders in the repo; temp files go in the OS temp dir (`$TEMP`) and are deleted right after use.
- Install components with the CLI only: `npx shadcn@latest add @termcn/opentui/<name> --yes --cwd src/tui/ui/termcn`. Never hand-copy. The only hand edits to generated files are the patches named in this plan, each recorded in `src/tui/ui/termcn/PATCHES.md`.
- Tests: never hand a renderer or renderable to an assertion (frame strings, counts and booleans only; `scripts/check-tui-asserts.mjs` enforces it). Never mock the store or hand-build `ClientState`; feed genuine `HostToWebview` messages through `src/test/tui/harness.tsx`.
- Gates: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit`. `yarn test:unit` sometimes fails with `listen EACCES` in `SelfControlMcpServer` tests on this machine; re-run before treating it as real.
- Files with backslashes: write them with the Write or Edit tools, never shell heredocs.
- Pin every shell command with its own `cd /e/Efebia/hiiiid-code &&`; the cwd reverts between calls.
- Code comments: only non-obvious "why". File over ~300 lines: split.
- Filenames are kebab-case.

## Review Focus

1. **Light terminal legibility.** Theme tokens must be named terminal colours (`gray`, `cyan`, ...), never hex or `white`, for every token an installed component reads. Pinned by Task 2's theme test.
2. **Double-handled keys.** One `y` must post exactly one `delete-session`; Enter in the new-session dialog must create exactly once. Pinned by Tasks 3 and 4.
3. **Short and narrow terminals.** The new-session dialog at 12 rows must still show provider rows; the chip band must wrap rather than overflow with many long names. Pinned by Tasks 4 and 5.
4. **Timer leaks.** A finished tool row must not start any interval (termcn's stock `ToolCall` runs a 12 fps spinner forever on every instance). Pinned by Task 7.
5. **Foreign, long and dim rows in the roster.** Long titles must not overflow the 26-column roster; foreign rows stay dim and refuse delete. Pinned by Task 6.

---

### Task 1: CLI scaffold and theme core install

**Files:**
- Create: `src/tui/ui/termcn/components.json`, `src/tui/ui/termcn/package.json`, `src/tui/ui/termcn/tsconfig.json`
- Modify: `src/tui/ui/tsconfig.json`, `eslint.config.mjs` (only if lint fails on generated files)
- Create (by CLI): `src/tui/ui/termcn/{components/ui/types.ts, lib/terminal-themes/default.ts, hooks/use-theme.ts, providers/theme-provider.tsx}`

**Interfaces:**
- Produces: `ThemeProvider`, `createTheme`, `Theme` (from `providers/theme-provider.tsx`); `useTheme()` (from `hooks/use-theme.ts`). Later tasks import them by relative path from `src/tui/ui/*.tsx`, e.g. `./termcn/providers/theme-provider`.

Why these files exist (probed in the OS temp dir): the CLI reads only the `components.json` in its cwd, treats a cwd without `package.json` as an uninitialised project and prompts interactively, and prompts for a component library unless `style` is set.

- [ ] **Step 1: Confirm the branch and a clean tree**

Run: `cd /e/Efebia/hiiiid-code && git branch --show-current && git status --short`
Expected: `feat/tui-termcn` and no output from status.

- [ ] **Step 2: Create the CLI config files**

`src/tui/ui/termcn/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "", "baseColor": "neutral", "cssVariables": false },
  "aliases": {
    "components": "@termcn/components",
    "ui": "@termcn/components/ui",
    "lib": "@termcn/lib",
    "utils": "@termcn/lib/utils",
    "hooks": "@termcn/hooks"
  },
  "registries": { "@termcn": "https://termcn.dev/r/{name}.json" }
}
```

`src/tui/ui/termcn/package.json` (marks the CLI project root; not a yarn workspace, so yarn ignores it):

```json
{ "name": "marcode-tui-termcn", "private": true, "version": "0.0.0" }
```

`src/tui/ui/termcn/tsconfig.json` (the CLI and Bun resolve aliases from here for generated files):

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "baseUrl": ".", "paths": { "@termcn/*": ["./*"] } }
}
```

- [ ] **Step 3: Map the alias for the type checker**

In `src/tui/ui/tsconfig.json`, add `paths` inside `compilerOptions` (it extends the root config whose `baseUrl` is the repo root; overriding `paths` drops the root's `@/*`, which no TUI code uses; confirm with `grep -rn "from '@/" src/tui src/client-core` printing nothing):

```json
    "paths": { "@termcn/*": ["src/tui/ui/termcn/*"] },
```

- [ ] **Step 4: Dry-run the install and read the file list**

Run: `cd /e/Efebia/hiiiid-code && timeout 120 npx --yes shadcn@latest add @termcn/opentui/theme-provider --dry-run --yes --cwd src/tui/ui/termcn </dev/null`
Expected: a file list that includes `types.ts`, `default.ts` (theme), `use-theme.ts` and `theme-provider.tsx`, and the dependency `@opentui/react`. **Every path must be under `src/tui/ui/termcn/`.** If any path lands elsewhere (the temp probes saw `components/ui` and `lib/terminal-themes` land next to the cwd rather than under alias paths), fix the `aliases` block in `components.json` and re-run the dry-run until all paths are inside `termcn/`. Do not continue until they are.

- [ ] **Step 5: Install for real**

Run: `cd /e/Efebia/hiiiid-code && timeout 180 npx --yes shadcn@latest add @termcn/opentui/theme-provider --yes --cwd src/tui/ui/termcn </dev/null && git status --short`
Expected: only new files under `src/tui/ui/termcn/` plus the edits from Steps 2-3. `package.json` and `yarn.lock` at the repo root must NOT appear modified; if the CLI touched them, `git checkout -- package.json yarn.lock` (`@opentui/react` is already a dependency).

- [ ] **Step 6: Check the generated imports resolve and the gates stay green**

Run: `cd /e/Efebia/hiiiid-code && yarn check-types:tui && yarn lint`
Expected: both pass. If `yarn lint` flags generated files, add to `eslint.config.mjs` an override block for `src/tui/ui/termcn/**` turning off only the failing rules, with the existing comment style ("vendored from the termcn registry, kept diffable against upstream"). Run `yarn check-types` too (root config excludes `src/tui/ui`, so it should be unaffected).

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/termcn src/tui/ui/tsconfig.json eslint.config.mjs && git commit -m "chore: install termcn theme core through the shadcn CLI" && git log -1 --format=%B
```

---

### Task 2: Marcode theme and provider wiring

**Files:**
- Create: `src/tui/ui/tui-theme.tsx`, `src/test/tui/tui-theme.test.tsx`
- Modify: `src/tui/ui/main.tsx`, `src/test/tui/harness.tsx`, `src/test/tui/e2e-harness.tsx`

**Interfaces:**
- Consumes: `createTheme`, `ThemeProvider`, `Theme` from `./termcn/providers/theme-provider` (Task 1).
- Produces: `tuiTheme: Theme` and `TuiThemeProvider({ children })`, imported by `main.tsx` and both harnesses.

Our TUI colours are terminal names (`gray`, `cyan`, `yellow`, `red`, `green`) or the terminal default (no `fg`), so they stay legible on light terminals. Components read tokens such as `theme.colors.primary`; every one must resolve to a named colour.

- [ ] **Step 1: Write the failing test**

`src/test/tui/tui-theme.test.tsx`:

```tsx
import { expect, test } from 'bun:test';
import { tuiTheme } from '../../tui/ui/tui-theme';

const NAMED = new Set(['gray', 'cyan', 'yellow', 'red', 'green', 'magenta', 'blue']);
// Tokens read by the installed components (confirm, dialog, tag, tool-call, chat-message).
const USED = ['primary', 'accent', 'success', 'warning', 'error', 'info', 'muted', 'mutedForeground', 'border'] as const;

test('every token an installed component reads is a named terminal colour', () => {
  const bad = USED.filter((k) => !NAMED.has(tuiTheme.colors[k]));
  expect(bad).toEqual([]);
});

test('the theme is named for Marcode', () => {
  expect(tuiTheme.name).toBe('marcode');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tui-theme.test.tsx`
Expected: FAIL, cannot find module `tui-theme`.

- [ ] **Step 3: Implement the theme and provider**

`src/tui/ui/tui-theme.tsx`:

```tsx
import type { ReactNode } from 'react';
import { defaultTheme } from './termcn/lib/terminal-themes/default';
import { createTheme, ThemeProvider } from './termcn/providers/theme-provider';

export const tuiTheme = createTheme({
  name: 'marcode',
  colors: {
    ...defaultTheme.colors,
    primary: 'cyan', accent: 'cyan', info: 'cyan',
    success: 'green', warning: 'yellow', error: 'red',
    muted: 'gray', mutedForeground: 'gray', border: 'gray',
  },
});

export function TuiThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={tuiTheme}>{children}</ThemeProvider>;
}
```

The file therefore has a `.tsx` extension: name it `src/tui/ui/tui-theme.tsx` (the Files list and later imports use `./tui-theme`, which resolves either way). The `defaultTheme` export and `ThemeProvider`'s file path come from Task 1's install; if the CLI used different file names, match what it generated.

- [ ] **Step 4: Run the test and see it pass**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/tui-theme.test.tsx && yarn check-types:tui`
Expected: PASS.

- [ ] **Step 5: Wrap the app and both harnesses**

In `src/tui/ui/main.tsx`, import `TuiThemeProvider` and wrap the existing `<TuiStoreProvider ...>` element with it (find it with `grep -n TuiStoreProvider src/tui/ui/main.tsx`). In `src/test/tui/harness.tsx` wrap the `<TuiStoreProvider>` in `mount` the same way, and do the same around line 46 of `src/test/tui/e2e-harness.tsx`, so tests render exactly what production renders.

- [ ] **Step 6: Whole TUI suite still green**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui`
Expected: the same pass count as before this task plus the two new tests.

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/tui-theme.tsx src/tui/ui/main.tsx src/test/tui && git commit -m "feat: marcode theme for the vendored termcn components" && git log -1 --format=%B
```

---

### Task 3: Delete confirm on termcn `confirm`

**Files:**
- Modify: `src/tui/ui/delete-confirm.tsx`, `src/test/tui/app-keys.test.tsx:154-182`
- Create (by CLI): `src/tui/ui/termcn/components/ui/confirm.tsx`

**Interfaces:**
- Consumes: `Confirm({ message, onConfirm, onCancel, confirmLabel, cancelLabel, defaultValue, variant })` (stock; default selection is "No", so a stray Enter cancels). `DeleteConfirm({ id, title, onDone })` keeps its signature, so `app.tsx` is unchanged.
- Produces: nothing new for later tasks.

Stock `Confirm` handles y, n, Enter and left/right, but **not Escape**, so `DeleteConfirm` keeps one `useKeyboard` for Escape only. `Confirm` is mounted only while deleting, so it needs no `active` patch.

- [ ] **Step 1: Install**

Run: `cd /e/Efebia/hiiiid-code && timeout 180 npx --yes shadcn@latest add @termcn/opentui/confirm --yes --cwd src/tui/ui/termcn </dev/null && git status --short`
Expected: `confirm.tsx` added under `termcn/components/ui/`; nothing outside `termcn/`.

- [ ] **Step 2: Update the tests first (they define the new frame)**

In `app-keys.test.tsx`, replace the frame assertion `toContain('Delete "two"? y/n')` with two assertions:

```tsx
  expect(m.frame()).toContain('Delete "two"?');
  expect(m.frame()).toContain('Delete');
```

(the message line and the "Delete" label). Add an exact-once check after `await m.press('y')`:

```tsx
  expect(m.posted.filter((p) => p.t === 'delete-session').length).toBe(1);
```

Add a test that Enter on the default selection cancels:

```tsx
test('delete confirm: Enter on the default choice cancels', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(rosterApp());
  await m.press('tab');
  await m.press('tab');
  await m.press('d', { shift: true });
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'delete-session')).toBe(false);
  expect(m.frame().includes('Delete "one"')).toBe(false);
});
```

- [ ] **Step 3: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/app-keys.test.tsx`
Expected: the changed delete tests FAIL (old component still renders `Delete "two"? y/n` on one line, and the Enter test finds the prompt still open).

- [ ] **Step 4: Implement**

`src/tui/ui/delete-confirm.tsx`:

```tsx
import { useKeyboard } from '@opentui/react';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';
import { Confirm } from './termcn/components/ui/confirm';

export function DeleteConfirm({ id, title, onDone }: { id: SessionId; title: string; onDone(): void }) {
  const { post } = useTuiStore();
  useKeyboard((key) => { if (key.name === 'escape') { onDone(); } });
  return (
    <Confirm
      variant="danger"
      message={`Delete "${title}"?`}
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onConfirm={() => { post({ t: 'delete-session', id }); onDone(); }}
      onCancel={onDone}
    />
  );
}
```

- [ ] **Step 5: Run the file, then the whole suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/app-keys.test.tsx && yarn test:tui`
Expected: PASS. Any other failure here is a real regression: fix the code, not the test.

- [ ] **Step 6: Gates and commit**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui`

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/delete-confirm.tsx src/tui/ui/termcn src/test/tui/app-keys.test.tsx && git commit -m "feat: delete confirm on the termcn confirm component" && git log -1 --format=%B
```

---

### Task 4: New-session dialog on the termcn `dialog` frame

**Files:**
- Modify: `src/tui/ui/new-session-dialog.tsx`, `src/test/tui/new-session-dialog.test.tsx`
- Create: `src/tui/ui/termcn/PATCHES.md`
- Create (by CLI): `src/tui/ui/termcn/components/ui/dialog.tsx` (then patched)

**Interfaces:**
- Consumes: stock `Dialog({ title, children, variant, isOpen, ... })`.
- Produces: patched `Dialog` with `interactive?: boolean` (default `true`). When `false` it registers no key action and renders no OK/Cancel row: frame, title and children only. `NewSessionDialog` props are unchanged.

Stock `Dialog` binds Enter to Cancel and Tab/arrows to its buttons, which would fight our pick-a-row flow (Enter creates). We want only its frame.

- [ ] **Step 1: Install**

Run: `cd /e/Efebia/hiiiid-code && timeout 180 npx --yes shadcn@latest add @termcn/opentui/dialog --yes --cwd src/tui/ui/termcn </dev/null`
Expected: `dialog.tsx` added under `termcn/components/ui/`.

- [ ] **Step 2: Write the failing tests**

In `new-session-dialog.test.tsx` add (existing tests stay as they are; they already assert `New session`, `Fake Small`, create counts):

```tsx
test('Enter creates exactly once; the frame has no OK/Cancel buttons', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg({ catalog: oneModel() }));
  expect(m.frame().includes(' OK ')).toBe(false);
  await m.press('return');
  expect(creates().length).toBe(1);
});

test('a 12-row terminal still shows the provider rows', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />, { width: 80, height: 12 });
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('New session');
  expect(m.frame()).toContain('Fake');
});

test('the dialog is drawn with the termcn rounded frame', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('╭');
});
```

- [ ] **Step 3: Run and see the frame test fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/new-session-dialog.test.tsx`
Expected: only `the dialog is drawn with the termcn rounded frame` FAILS (today's frame is `double`, drawn with `╔`); the other new tests already pass and stay as guards through the swap.

- [ ] **Step 4: Patch `dialog.tsx` (the recorded edit)**

In `termcn/components/ui/dialog.tsx`:
1. Add to `DialogProps`: `interactive?: boolean;`
2. Add to the destructured props: `interactive = true,`
3. First line inside the `useKeyboard` callback becomes `if (!isOpen || !interactive) { return; }` (replacing the `if (!isOpen)` check).
4. Wrap the button row `<box flexDirection="row" gap={2} justifyContent="flex-end" marginTop={1}>...</box>` in `{interactive ? (...) : null}`.

Create `src/tui/ui/termcn/PATCHES.md`:

```markdown
# Local edits to installed termcn files

Reapply after `shadcn add ... --overwrite`.

| File | Edit | Why |
|---|---|---|
| `components/ui/dialog.tsx` | `interactive?: boolean` (default true): when false, no key handling and no OK/Cancel row | Enter would cancel; we only want the frame |
```

- [ ] **Step 5: Implement the dialog**

In `new-session-dialog.tsx`, replace the outer `<box ... border borderStyle="double" title="New session">` with:

```tsx
    <Dialog isOpen interactive={false} title="New session">
      {providers.length === 0 ? <text fg="gray">No provider available.</text> : null}
      {step === 'provider'
        ? providers.map((p, i) => <text key={p.id} attributes={i === pi ? 1 : 0}>{`${i === pi ? '›' : ' '} ${p.displayName}`}</text>)
        : models.map((mo, i) => <text key={mo.id} attributes={i === mi ? 1 : 0}>{`${i === mi ? '›' : ' '} ${mo.displayName}`}</text>)}
      <text fg="gray">{`${props.cwd} — Enter create, Esc cancel`}</text>
    </Dialog>
```

with `import { Dialog } from './termcn/components/ui/dialog';`. The `useKeyboard` logic is unchanged. Keep `flexShrink={0}` by wrapping in `<box flexShrink={0}>` if the 12-row test shows the frame being squeezed.

- [ ] **Step 6: Run the file and the suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/new-session-dialog.test.tsx && yarn test:tui`
Expected: PASS. If the 12-row test fails because the title's `marginBottom` pushes rows out, remove the title gap by passing no `title` and rendering our own one-line heading inside the children; record that decision in `PATCHES.md` only if `dialog.tsx` is edited again.

- [ ] **Step 7: Gates and commit**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui`

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/new-session-dialog.tsx src/tui/ui/termcn src/test/tui/new-session-dialog.test.tsx && git commit -m "feat: new-session dialog on the termcn dialog frame" && git log -1 --format=%B
```

---

### Task 5: Attachment chips on termcn `tag`

**Files:**
- Modify: `src/tui/ui/attachment-chips.tsx`, `src/test/tui/attachments.test.tsx`
- Create (by CLI): `src/tui/ui/termcn/components/ui/tag.tsx`

**Interfaces:**
- Consumes: `Tag({ children, color, variant })` (presentational, no keys, no timers). `AttachmentChips({ attachments, rejected })` keeps its signature.

`Tag` is a rounded bordered box, three rows tall. Chips go in one wrapping row so N chips cost one band rather than N bands.

- [ ] **Step 1: Install**

Run: `cd /e/Efebia/hiiiid-code && timeout 180 npx --yes shadcn@latest add @termcn/opentui/tag --yes --cwd src/tui/ui/termcn </dev/null`

- [ ] **Step 2: Write the failing tests**

In `attachments.test.tsx`, find the existing chip assertion (`grep -n "shot.png\|KB" src/test/tui/attachments.test.tsx`) and keep it as a `toContain('shot.png')`-style check on the name and the size text only (`2 KB`). Add:

```tsx
test('many long chips wrap into the frame instead of overflowing', async () => {
  await open();
  const names = Array.from({ length: 6 }, (_, i) => `a-rather-long-attachment-name-${i}.png`);
  await m!.fromHost({
    t: 'session-attachments', id: 's1',
    attachments: names.map((name, i) => ({ id: `a${i}`, path: `/x/${name}`, name, kind: 'image' as const, bytes: 2048 })),
  });
  for (const name of names) { expect(m!.frame()).toContain(name); }
});

test('chips are drawn in the termcn rounded border', async () => {
  await open();
  await m!.fromHost({ t: 'session-attachments', id: 's1', attachments: [attachment] });
  expect(m!.frame()).toContain('╭');
});
```

`session-attachments` is `{ t: 'session-attachments'; id: SessionId; attachments: Attachment[] }` in `src/protocol/messages.ts:843`, a genuine `HostToWebview` message, so no cast is needed.

- [ ] **Step 3: Run and see the frame test fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/attachments.test.tsx`
Expected: `chips are drawn in the termcn rounded border` FAILS (today's chips are plain `+ name (size)` text). The wrap test passes now and guards the new layout.

- [ ] **Step 4: Implement**

`src/tui/ui/attachment-chips.tsx`: keep `size()`, replace the attachments map with:

```tsx
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {attachments.map((a) => <Tag key={a.id} color="cyan">{`${a.name} (${size(a.bytes)})`}</Tag>)}
      </box>
```

import `Tag` from `./termcn/components/ui/tag`; keep the `rejected` lines unchanged. Do not pass `onRemove` (Ctrl+X removes the last chip; a × on every chip would claim a per-chip action that does not exist).

- [ ] **Step 5: Run the suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/attachments.test.tsx && yarn test:tui`
Expected: PASS; fix any frame assertion that depended on the old `+ name (size)` text by asserting the name and size separately.

- [ ] **Step 6: Gates and commit**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui`

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/attachment-chips.tsx src/tui/ui/termcn src/test/tui/attachments.test.tsx && git commit -m "feat: attachment chips on the termcn tag" && git log -1 --format=%B
```

---

### Task 6: Roster styling from theme tokens

**Files:**
- Modify: `src/tui/ui/roster.tsx`, `src/test/tui/roster.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` from `./termcn/hooks/use-theme` (Task 1). Behaviour, keys and `RosterProps` unchanged.

termcn has no list that fits the roster (its `list`/`select`/`menu` own the cursor and swallow keys). The roster adopts only the theme: the cursor row uses `theme.colors.primary`, dim rows `theme.colors.mutedForeground`, the pin star `theme.colors.warning`, the empty and filter lines `theme.colors.muted`.

- [ ] **Step 1: Write the failing tests**

In `roster.test.tsx` add (it uses the file's existing imports and `afterEach`):

```tsx
test('a very long title and a foreign row stay inside the 26-column roster', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />, { width: 60, height: 20 });
  await m.fromHost(hydrateMsg({
    sessions: [
      summary('a', { name: 'x'.repeat(80) }),
      summary('c', { name: 'shared', owner: { host: 'vscode', pid: 4812 } }),
    ],
    snapshots: [snapshot('a')],
  }));
  const rosterBorderRows = m.frame().split('\n').filter((l) => l.includes('│'));
  expect(rosterBorderRows.every((l) => l.trimEnd().length <= 26)).toBe(true);
  expect(m.frame()).toContain('sessions');
  expect(m.frame()).toContain('vscode·4812');
});
```

If `trimEnd().length <= 26` is too strict for how the border draws (the roster `width={26}` includes its border), print one frame locally, set the bound to the observed roster width, and keep the assertion on both the long and foreign rows.

- [ ] **Step 2: Run the file**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/roster.test.tsx`
Expected: PASS today (no behaviour change yet); this pins current behaviour before the restyle.

- [ ] **Step 3: Implement**

In `roster.tsx` add `const theme = useTheme();` and change only the colours:
- `<text fg="gray">{`/${filter}`}</text>` → `fg={theme.colors.muted}`
- the two empty-state lines → `fg={theme.colors.muted}`
- row `fg={row.dim ? 'gray' : undefined}` → `fg={row.dim ? theme.colors.mutedForeground : undefined}`
- split the star out of the row string into its own `<span>` is **not** done (it would change width handling); keep the single `<text>`.

Do not change keys, cursor tracking or `setRosterFiltering`.

- [ ] **Step 4: Run the suite**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui`
Expected: PASS unchanged (colours do not appear in `captureCharFrame`).

- [ ] **Step 5: Gates and commit**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui`

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/roster.tsx src/test/tui/roster.test.tsx && git commit -m "feat: roster colours from the termcn theme" && git log -1 --format=%B
```

---

### Task 7: Transcript rows on `chat-message` and `tool-call`

**Files:**
- Modify: `src/tui/ui/transcript/row.tsx`, `src/test/tui/transcript.test.tsx`
- Modify: `src/tui/ui/termcn/PATCHES.md`
- Create (by CLI): `src/tui/ui/termcn/components/ui/chat-message.tsx`, `tool-call.tsx`

**Interfaces:**
- Consumes: `ChatMessage({ sender, name, streaming, children })`, `ToolCall({ name, status, duration, collapsible })` with the patch below. `RowView({ row, selected, expanded })` keeps its signature, so `transcript.tsx` (scrollbox, cursor, expansion) is untouched.
- Produces: patched `ToolCall` whose spinner interval runs only while `status === 'running'`.

Findings that shape this task: stock `ToolCall` starts a 12 fps `setInterval` on every instance forever, and binds Enter/Space to its own collapse; `ChatMessage` adds a label row and `marginBottom={1}` (two extra rows per message). The tool header uses `ToolCall` with `collapsible={false}` (so its key handler is inert and our `▸/▾` and cursor stay in charge) and the timer patch.

- [ ] **Step 1: Install**

Run: `cd /e/Efebia/hiiiid-code && timeout 180 npx --yes shadcn@latest add @termcn/opentui/chat-message @termcn/opentui/tool-call --yes --cwd src/tui/ui/termcn </dev/null`

- [ ] **Step 2: Write the failing tests**

In `transcript.test.tsx` update the first test's user assertion from `'> fix the tests'` to `toContain('fix the tests')` and add `toContain('user')`/`toContain('assistant')` for the role labels. Add:

```tsx
test('a finished tool row starts no interval timers', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try {
    m = await mount(<Transcript sessionId="s1" focused />);
    const before = started;
    await m.fromHost(withItems([tool({ id: 't1', state: 'ok' })]));
    expect(started - before).toBe(0);
  } finally { globalThis.setInterval = real; }
});

test('a running tool row shows a running mark and a finished one a check', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1', state: 'running' }), tool({ id: 't2', state: 'ok' })], 'running'));
  expect(m.frame()).toContain('✓');
});
```

`tool()` in `src/test/fixtures/protocol.ts` takes `state: 'running' | 'ok' | 'error'`, as used above.

- [ ] **Step 3: Run and see them fail**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/transcript.test.tsx`
Expected: FAIL (`> fix the tests` gone from the assertion; no `✓`; the timer test passes only after the patch).

- [ ] **Step 4: Patch `tool-call.tsx` (the recorded edit)**

Replace the unconditional spinner effect

```tsx
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), Math.round(1000 / 12));
    return () => clearInterval(id);
  }, []);
```

with

```tsx
  useEffect(() => {
    if (status !== "running") {
      return;
    }
    const id = setInterval(() => setFrame((f) => f + 1), Math.round(1000 / 12));
    return () => clearInterval(id);
  }, [status]);
```

Append to `PATCHES.md`:

```markdown
| `components/ui/tool-call.tsx` | spinner interval only while `status === "running"` | stock code ticks 12 times a second on every instance forever |
```

- [ ] **Step 5: Implement the rows**

`src/tui/ui/transcript/row.tsx`: import `ChatMessage` and `ToolCall`. Changes by case, everything else untouched:
- `user`: `<ChatMessage sender="user" name={row.fromName}>` containing `<text attributes={bold} wrapMode="word">{row.text}</text>`.
- `assistant`: `<ChatMessage sender="assistant">` containing the existing `<markdown ... />` unchanged (do not pass `streaming` to `ChatMessage`; its dots animation would duplicate the markdown's own streaming and start a timer).
- `tool`: replace the single `<text>` with

```tsx
<box paddingLeft={row.depth * 2}>
  <text attributes={bold} fg="gray">{props.expanded ? '▾' : '▸'}</text>
  <ToolCall
    name={`${row.header.verb} ${row.header.primary}`}
    status={row.state === 'ok' ? 'success' : row.state}
    collapsible={false}
  />
</box>
```
- `permission`, `question`, `notice`: unchanged.

- [ ] **Step 6: Run the file, then the suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/transcript.test.tsx && yarn test:tui`
Expected: PASS. For each other failing assertion decide: a chrome change (a label row or glyph; update the assertion deliberately) or a behaviour change (cursor, expansion, paging, `load-more` anchoring; fix the code). The two-extra-rows-per-message cost may break scroll-position or paging tests; if a paging test fails because fewer rows fit, adjust its item counts, not the production anchoring logic.

- [ ] **Step 7: Visual density checkpoint**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/transcript.test.tsx -t "renders"` and print one frame of a 12-message transcript at 100x30 (a throwaway `console.log(m.frame())` inside a local, uncommitted edit of the test; revert it before committing). Report how many messages fit. If fewer than half of the previous count fit, stop and ask the user whether to drop `ChatMessage` for user rows (keeping `> ` prefix) before continuing.

- [ ] **Step 8: Gates and commit**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui && git status --short`
Expected: only intended files changed.

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/ui/transcript src/tui/ui/termcn src/test/tui/transcript.test.tsx && git commit -m "feat: transcript rows on termcn chat-message and tool-call" && git log -1 --format=%B
```

---

### Task 8: Docs and final gates

**Files:**
- Modify: `docs/tui.md`, `AGENTS.md` (add one table row for `src/tui/ui/termcn/`)

- [ ] **Step 1: Docs**

In `docs/tui.md` add a short "Vendored components" section: termcn items live in `src/tui/ui/termcn/`, installed with `npx shadcn@latest add @termcn/opentui/<name> --yes --cwd src/tui/ui/termcn`, local edits are listed in `termcn/PATCHES.md` and must be reapplied after `--overwrite`, theme tokens come from `src/tui/ui/tui-theme.ts`. Add to the smoke checklist: `- [ ] Light terminal theme: tool rows, role labels, chips and the delete confirm stay legible.` and `- [ ] The new-session dialog, delete confirm and chip band in a short (12-row) terminal.` In `AGENTS.md` add a path-table row: `src/tui/ui/termcn/` | termcn components installed by the shadcn CLI, patched only as `PATCHES.md` lists; `src/tui/ui/tui-theme.ts` maps our terminal colours into its theme.

- [ ] **Step 2: Run every gate**

Run, each pinned: `cd /e/Efebia/hiiiid-code && yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit` (re-run once on `listen EACCES`).
Expected: all pass; `yarn test:tui` reports at least 160 + the new tests.

- [ ] **Step 3: Confirm nothing stray**

Run: `cd /e/Efebia/hiiiid-code && git status --short && ls "$TEMP" | grep -i "tc-probe\|termcn" ; git diff --stat HEAD~7 -- package.json yarn.lock`
Expected: clean tree, no leftover temp probe folders, and no change to the root `package.json` or `yarn.lock`.

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add docs/tui.md AGENTS.md && git commit -m "docs: document the vendored termcn components" && git log -1 --format=%B
```
