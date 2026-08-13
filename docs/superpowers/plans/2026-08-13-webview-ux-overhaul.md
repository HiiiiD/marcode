# Webview UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution mode: implementation-first, not TDD.** By the repo owner's decision, do **not** run the red-green cycle. For each task: write the implementation, then bring the tests in that task's `Test:` list to green — updating existing tests the change invalidates and adding the new ones the task specifies. The test code in each task's "Write the failing test" step is still the **specification of required behavior**; it says what must end up asserted, not what must be written first. A task is done when its implementation is in and `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom` are all green. Never delete a failing test to make a suite pass; if a test is genuinely obsolete, say so in the task's report and explain why.

**Goal:** Close every defect found in the 2026-08-13 design critique of `src/webview` — a 15/40 Nielsen score whose deficit is almost entirely presentation-layer — without changing the host's ownership of state.

**Architecture:** All work stays inside `src/webview/` plus three narrow host additions (a `set-model` message and its router/session/provider path). The extension host remains the sole owner of state; the webview stays a rendering client over `postMessage`. Two new vendored shadcn primitives (`input-group`, `tooltip`) and one new runtime dependency (`react-markdown`) enter the webview bundle. Every task is TDD: DOM tests under `src/test/dom/` for component behavior, unit tests under `src/test/unit/` for pure logic.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Base UI (`@base-ui/react`), lucide-react, react-markdown, esbuild, mocha (`--ui tdd`), @testing-library/react + user-event, jsdom.

**Spec:** [.impeccable/critique/2026-08-13T15-33-16Z__src-webview.md](../../../.impeccable/critique/2026-08-13T15-33-16Z__src-webview.md)

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts` imports `vscode`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions. Nothing rejects across `postMessage`.
- Transcript patches fan out only to visible sessions; `sessions-changed` and `session-status` are ungated.
- The webview loads **no remote resources**. CSP is `default-src 'none'`; scripts/styles restricted to `webview.cspSource` + per-load nonce; `localResourceRoots` pinned to `dist/`.
- **shadcn is mandatory.** No bare `<select>`, `<button>`, `<input>`, `<textarea>` in feature code. Vendor missing primitives into `src/webview/components/ui/`; do not hand-roll and do not add Radix.
- **Compose classNames with `cn` from `@/lib/utils`** — never template literals or concatenation.
- **Never hand-write `h-*` / `w-*` on a component that exposes a size variant.** Use the variant. Two existing bugs (`session-header.tsx:66`, `composer.tsx:89,109`) came from exactly this.
- Prefer short Tailwind token utilities (`bg-muted`, `border-border`). Arbitrary values only for derived computations (`min()`, `calc()`, `color-mix()`).
- Filenames kebab-case, including React components. Component identifiers PascalCase.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after every task. **No `Co-Authored-By` trailer.**
- `yarn lint`, `yarn check-types`, `yarn run compile` must all pass before every commit.
- Full test command set: `yarn test:unit`, `yarn test:dom`.
- Extension host target: VS Code `^1.125.0`, Node 22.

## Decisions Locked In

Resolved with the user before planning; do not relitigate during execution.

| Question | Decision |
|---|---|
| Is the resizable split the right primary IA at 300–500px? | **Keep splits.** Fix discoverability only. `pane-layout.ts`, `PaneGroup`, the persisted layout shape and their tests are preserved. |
| How do we render assistant markdown? | **`react-markdown`**, plugin-free, with an explicit component map so nothing can emit a remote resource. |
| Where does the delete affordance live? | **The roster dropdown row**, right-aligned. Not the pane header. |
| What guards deletion? | **Inline confirm**, in the row. Not a modal, not a bare undo toast. |

## Verified Facts the Plan Depends On

Each was confirmed in source during the critique; an executor who doubts one should re-verify rather than assume.

- `.data-\[size\=default\]\:h-8[data-size="default"]` (`dist/webview.css:1243`, specificity 0,2,0) beats `.h-7` (line 375, 0,1,0). The `h-7` on both `SelectTrigger`s in `composer.tsx` is dead; they render at 32px while `Send` renders at 28px.
- `twMerge('size-8', 'h-5 w-5')` returns **both** classes — `size-*` does not conflict-resolve against `h-*`/`w-*` in `tailwind-merge` 3.6. The 20px close button is decided by stylesheet order, not by `cn`.
- `create-session` already carries `model?` and `effort?` end to end: `messages.ts:75` → `message-router.ts:69` → `session-manager.ts:86-99` (`models.find((m) => m.id === model) ?? models[0]`). The webview simply never sends them. **UI-only gap.**
- `cwd: ''` is the correct idiom, not a bug: `message-router.ts:69` does `msg.cwd || this.defaultCwd`, and `extension.ts:24` sets `defaultCwd` from `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()`.
- `claude-provider.ts:245-256` builds SDK options lazily on first `send()`. `pendingMode` and `pendingEffort` are already mutable closure vars updated by `setPermissionMode`/`setEffort`; `model` is the only one still read straight off `opts`.
- `dropdown-menu.tsx` exports `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`, `DropdownMenuGroup`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`.
- `scripts/dev-host.ps1`'s env denylist is missing `VSCODE_ESM_ENTRYPOINT`, `VSCODE_CODE_CACHE_PATH`, `VSCODE_CRASH_REPORTER_PROCESS_TYPE`, `VSCODE_HANDLES_UNCAUGHT_ERRORS`, `VSCODE_L10N_BUNDLE_LOCATION` on VS Code 1.127.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/webview/components/ui/input-group.tsx` | Vendored shadcn/Base UI input group: bordered container + block-end addon row |
| `src/webview/components/session-create-menu.tsx` | The `+ New` popover: provider, model, effort choice → one `create-session` |
| `src/webview/components/session-row.tsx` | One roster row: visibility checkbox + delete submenu |
| `src/webview/components/status-badge.tsx` | Status → dot + text label + tone, shared by header and roster trigger |
| `src/webview/components/markdown.tsx` | `react-markdown` wrapper with the CSP-safe component map |
| `src/webview/components/transcript-item-shell.tsx` | Role gutter + label wrapper shared by every transcript item kind |
| `src/webview/status.ts` | Pure `SessionStatus` → `{ label, tone, needsUser }`; unit-testable without the DOM |
| `src/webview/format.ts` | `folderName(cwd)` and `formatTokens(n)`; shared by the header and the permission card |
| `src/test/dom/session-create-menu.test.tsx` | DOM tests for the creation flow |
| `src/test/dom/session-header.test.tsx` | DOM tests for status, cwd, usage, close |
| `src/test/dom/transcript-item.test.tsx` | DOM tests for role hierarchy and markdown |
| `src/test/unit/status.test.ts` | Unit tests for the status map |

**Modified:**

| Path | Change |
|---|---|
| `src/webview/index.css` | `@custom-variant dark`, `--background` fallback |
| `src/webview/components/composer.tsx` | Rebuilt on `InputGroup`; Send moves right; `size="sm"` on selects |
| `src/webview/components/session-picker.tsx` | One row per session; delete moves into `session-row.tsx`; trigger copy; orientation control |
| `src/webview/components/session-header.tsx` | `StatusBadge`, cwd, usage, `size="icon-xs"` close |
| `src/webview/components/transcript-item.tsx` | Uses `TranscriptItemShell` + `Markdown` |
| `src/webview/components/permission-card.tsx` | Filled emphasis, colored diff, session identity, denial reason preserved |
| `src/webview/components/tool-card.tsx` | lucide icons, `aria-expanded`, wrapped payload |
| `src/webview/components/pane-group.tsx` | Exposes `narrow` to the picker; active-pane ring |
| `src/protocol/messages.ts` | `set-model` message |
| `src/host/message-router.ts` | `set-model` case |
| `src/host/agent-session.ts` | `setModel` |
| `src/providers/types.ts` | `AgentRun.setModel` |
| `src/providers/fake/fake-provider.ts` | `setModel` |
| `src/providers/claude/claude-provider.ts` | `pendingModel` |
| `src/test/dom/session-picker.test.tsx` | Rewritten for the single-row roster |
| `src/test/dom/composer.test.tsx` | Extended for the input group and Send-during-run |
| `scripts/dev-host.ps1` | Regex-based env scrub |
| `package.json` | `react-markdown` dependency |

---

## Phase 1 — Foundation

Cheap, high-leverage correctness. Nothing here changes layout; everything here is currently wrong in a way that silently corrupts later work.

### Task 1: Wire `dark:` to the VS Code theme

All 17 `dark:` utilities in the bundle currently key off `prefers-color-scheme`, i.e. the OS, not the active VS Code theme. A user on a light OS with a dark theme gets the light branch everywhere.

**Files:**
- Modify: `src/webview/index.css:1-24`
- Test: `src/test/unit/theme-variant.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Every later task's `dark:` utility becomes theme-correct.

- [ ] **Step 1: Write the failing test**

The assertion is over built CSS, so it must build first. Create `src/test/unit/theme-variant.test.ts`:

```ts
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

suite('dark variant', () => {
  test('dark: utilities key off the VS Code body class, not prefers-color-scheme', () => {
    execFileSync('node', ['esbuild.js'], { cwd: root, stdio: 'pipe' });
    const css = readFileSync(path.join(root, 'dist/webview.css'), 'utf8');

    assert.ok(
      css.includes('vscode-dark'),
      'expected the built CSS to gate dark: utilities on body.vscode-dark',
    );
    assert.ok(
      !/@media[^{]*prefers-color-scheme\s*:\s*dark/.test(css),
      'expected no prefers-color-scheme media query — the OS theme is not the VS Code theme',
    );
  });

  test('every color token has a fallback', () => {
    const src = readFileSync(path.join(root, 'src/webview/index.css'), 'utf8');
    const block = src.slice(src.indexOf(':root'), src.indexOf('@theme'));
    const bare = [...block.matchAll(/^\s*(--[a-z-]+):\s*var\((--vscode-[a-z-]+)\);/gim)];
    assert.deepStrictEqual(
      bare.map((m) => m[1]),
      [],
      'every --vscode-* lookup needs a fallback: var(--vscode-x, var(--vscode-y))',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "dark variant"`
Expected: FAIL — first test fails on the missing `vscode-dark` string; second fails listing `--background` (and any other token with a single bare `var()`).

- [ ] **Step 3: Write minimal implementation**

In `src/webview/index.css`, immediately after the `@import`:

```css
@import "tailwindcss";

/* VS Code stamps vscode-light / vscode-dark / vscode-high-contrast on <body>.
   Tailwind v4's stock `dark:` is prefers-color-scheme, which tracks the OS and
   not the editor theme, so the two disagree for anyone whose OS and VS Code
   themes differ. Bind the variant to the class VS Code actually sets.
   High contrast is a dark-family theme in VS Code's own token defaults, so it
   takes the dark branch. */
@custom-variant dark (&:where(body.vscode-dark, body.vscode-dark *, body.vscode-high-contrast, body.vscode-high-contrast *));
```

And give `--background` the fallback its neighbours already have:

```css
  --background: var(--vscode-sideBar-background, var(--vscode-editor-background));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "dark variant"`
Expected: PASS, both tests.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/index.css src/test/unit/theme-variant.test.ts
git commit -m "fix: bind the dark variant to the VS Code theme class"
```

---

### Task 2: Stop hand-writing heights over size variants

Three controls hand-write `h-*` on components that expose a size variant. Two of the three lose the cascade fight, so the rendered size is not the authored size.

**Files:**
- Modify: `src/webview/components/composer.tsx:89,109`
- Modify: `src/webview/components/session-header.tsx:66`
- Modify: `src/webview/components/session-picker.tsx:67`
- Test: `src/test/dom/composer.test.tsx`

**Interfaces:**
- Consumes: `Button`'s `size` variants (`xs`, `sm`, `icon-xs`, `icon-sm`) and `SelectTrigger`'s `size?: 'sm' | 'default'`, both already defined.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `src/test/dom/composer.test.tsx`:

```tsx
test('the effort and mode selects use the sm size variant, not a hand-written height', () => {
  renderApp();
  hydrateOne();

  for (const label of ['Effort', 'Permission mode']) {
    const trigger = screen.getByLabelText(label);
    assert.strictEqual(
      trigger.getAttribute('data-size'), 'sm',
      `${label} must set size="sm"; a hand-written h-7 loses to data-[size=default]:h-8`,
    );
    assert.ok(
      !/\bh-\d/.test(trigger.className),
      `${label} must not hand-write a height over the size variant`,
    );
  }
});
```

And in `src/test/dom/session-picker.test.tsx`:

```tsx
test('icon buttons use icon size variants rather than hand-written boxes', () => {
  renderApp();
  hydrateAOpen();

  const toggle = screen.getByLabelText('Toggle split orientation');
  assert.ok(
    !/\b[hw]-\d/.test(toggle.className),
    'use size="icon-sm"; twMerge does not strip size-8 when h-7 w-7 is added',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — `data-size` is `"default"`, and `className` contains `h-7`.

- [ ] **Step 3: Write minimal implementation**

`composer.tsx` — both triggers:

```tsx
<SelectTrigger size="sm" className="w-24" aria-label="Effort">
```

```tsx
<SelectTrigger
  size="sm"
  className={cn(
    'w-28',
    bypassing && 'border-destructive text-destructive dark:border-destructive/50',
  )}
  aria-label="Permission mode"
>
```

`session-header.tsx` — the close button. `icon-xs` is 24px, which clears the minimum target size that `h-5 w-5` (20px) failed:

```tsx
<Button
  variant="ghost"
  size="icon-xs"
  aria-label={`Close session ${s.title}`}
  onClick={/* unchanged */}
  className="shrink-0"
>
```

`session-picker.tsx` — the orientation toggle:

```tsx
<Button variant="outline" size="icon-sm" aria-label="Toggle split orientation" className="shrink-0">
```

Note `session-header.tsx`'s `aria-label` gains the session title in the same edit — Task 12 asserts it, and changing it here avoids touching the line twice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. The existing `getByLabelText('Close session')` in any test must be updated to `Close session Session a`.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "fix: use size variants instead of hand-written heights on controls"
```

---

## Phase 2 — Composer and session creation

### Task 3: Vendor the `input-group` primitive

**Files:**
- Create: `src/webview/components/ui/input-group.tsx`
- Test: `src/test/dom/input-group.test.tsx` (create)

**Interfaces:**
- Produces: `InputGroup`, `InputGroupTextarea`, `InputGroupAddon`. `InputGroupAddon` takes `align?: 'block-start' | 'block-end' | 'inline-start' | 'inline-end'` (default `'block-end'`). Task 4 consumes all three.

- [ ] **Step 1: Write the failing test**

Create `src/test/dom/input-group.test.tsx`:

```tsx
import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';

suite('InputGroup', () => {
  test('renders a textarea and a block-end addon inside one group', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="Message" />
        <InputGroupAddon align="block-end"><span>addon</span></InputGroupAddon>
      </InputGroup>,
    );

    const textarea = screen.getByLabelText('Message');
    assert.strictEqual(textarea.tagName, 'TEXTAREA');

    const addon = screen.getByText('addon').closest('[data-slot="input-group-addon"]');
    assert.ok(addon, 'the addon must carry data-slot="input-group-addon"');
    assert.strictEqual(addon!.getAttribute('data-align'), 'block-end');
  });

  test('focus inside the group marks the group focused', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="Message" />
      </InputGroup>,
    );
    const group = screen.getByLabelText('Message').closest('[data-slot="input-group"]')!;
    assert.ok(
      group.className.includes('focus-within:'),
      'the group, not the textarea, owns the focus ring',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — `Cannot find module '@/components/ui/input-group'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/webview/components/ui/input-group.tsx`. This matches the vendored style of the existing primitives: `data-slot`, `cn`, tokens only, no Radix.

```tsx
"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "flex w-full flex-col rounded-lg border border-input bg-transparent transition-colors",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        "has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20",
        "dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="input-group-textarea"
      className={cn(
        "w-full resize-none bg-transparent px-2.5 py-2 text-sm outline-none",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "field-sizing-content max-h-40 min-h-16",
        className
      )}
      {...props}
    />
  )
}

function InputGroupAddon({
  className,
  align = "block-end",
  ...props
}: React.ComponentProps<"div"> & {
  align?: "block-start" | "block-end" | "inline-start" | "inline-end"
}) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex items-center gap-1.5 px-1.5 py-1",
        align === "block-end" && "order-last",
        align === "block-start" && "order-first",
        className
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupTextarea }
```

The bare `<textarea>` here is correct and is the one place it is allowed: this file *is* the vendored primitive layer, exactly like `ui/textarea.tsx`. Feature code still must not use a bare element.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:dom`
Expected: PASS, both tests.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components/ui/input-group.tsx src/test/dom/input-group.test.tsx
git commit -m "feat: vendor the input-group primitive"
```

---

### Task 4: Rebuild the composer on the input group

Send moves inside the box, to the right. Settings sit left. `Send` stays visible and disabled during a run instead of being swapped out for `Stop`.

**Files:**
- Modify: `src/webview/components/composer.tsx`
- Test: `src/test/dom/composer.test.tsx`

**Interfaces:**
- Consumes: `InputGroup`, `InputGroupTextarea`, `InputGroupAddon` from Task 3.
- Produces: nothing importable. `Composer`'s props are unchanged: `{ pane: PaneState; model: ModelInfo | undefined }`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/dom/composer.test.tsx`:

```tsx
test('Send sits inside the input group, after the settings', () => {
  renderApp();
  hydrateOne();

  const group = screen.getByLabelText('Message').closest('[data-slot="input-group"]');
  assert.ok(group, 'the textarea must live inside an InputGroup');

  const send = screen.getByRole('button', { name: 'Send' });
  assert.ok(group!.contains(send), 'Send must live inside the group, not in a row below it');

  const mode = screen.getByLabelText('Permission mode');
  assert.ok(
    mode.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    'settings come first, the action comes last',
  );
});

test('Send stays visible but disabled while the agent runs, with Stop beside it', () => {
  renderApp();
  hydrateOne();
  sendFromHost({ t: 'session-status', id: 'a', status: 'running' });

  const send = screen.getByRole('button', { name: 'Send' });
  assert.ok((send as HTMLButtonElement).disabled, 'Send is disabled, not removed, during a run');
  assert.strictEqual(
    send.getAttribute('title'),
    'The agent is working. Stop it to send another message.',
  );
  screen.getByRole('button', { name: 'Stop' });
});

test('Stop still posts interrupt', async () => {
  renderApp();
  hydrateOne();
  sendFromHost({ t: 'session-status', id: 'a', status: 'running' });

  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — no `input-group` ancestor, and `getByRole('button', { name: 'Send' })` throws during a run because Send is currently unmounted.

- [ ] **Step 3: Write minimal implementation**

Replace the returned JSX of `composer.tsx` (keep every existing comment about `hasStarted`, `MODE_ITEMS` and the disabled-bypass reason — they document decisions this task does not revisit):

```tsx
  return (
    <div className="p-2">
      <InputGroup>
        <InputGroupTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) { submit(); }
            }
          }}
          placeholder="Message the agent…"
          aria-label="Message"
        />
        <InputGroupAddon align="block-end">
          {model?.effort && (
            <Select
              items={model.effort.levels.map((level) => ({ value: level, label: level }))}
              value={pane.summary.effort ?? model.effort.default}
              onValueChange={(value) => post({
                t: 'set-effort', id: pane.summary.id, effort: value as EffortLevel,
              })}
            >
              <SelectTrigger size="sm" className="w-24 border-0" aria-label="Effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {model.effort.levels.map((level) => (
                  <SelectItem key={level} value={level}>{level}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            items={MODE_ITEMS}
            value={pane.summary.permissionMode}
            onValueChange={(value) => post({
              t: 'set-permission-mode', id: pane.summary.id, mode: value as PermissionMode,
            })}
          >
            <SelectTrigger
              size="sm"
              className={cn(
                'w-28 border-0',
                bypassing && 'border border-destructive text-destructive dark:border-destructive/50',
              )}
              aria-label="Permission mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_ITEMS.map((item) => {
                const disableBypass = item.value === 'bypass' && hasStarted;
                return (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={disableBypass}
                    title={disableBypass
                      ? 'Bypass can only be chosen before the first message is sent'
                      : undefined}
                  >
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          {running && (
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={() => post({ t: 'interrupt', id: pane.summary.id })}
            >
              Stop
            </Button>
          )}
          <Button
            size="xs"
            className={cn(!running && 'ml-auto')}
            onClick={submit}
            // Disabled-with-a-reason rather than unmounted: swapping Send out
            // for Stop makes the row jump and leaves a user who has typed the
            // next instruction with no explanation of where Send went.
            disabled={running || !text.trim()}
            title={running
              ? 'The agent is working. Stop it to send another message.'
              : undefined}
          >
            Send
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
```

Update the imports: drop `Textarea`, add `InputGroup`, `InputGroupAddon`, `InputGroupTextarea`. The `border-t border-border` wrapper is gone — the group now carries the border, so a second one would double it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. Existing composer tests that query `Send` by text still pass; any that assert Send is absent during a run must be updated to assert `disabled`.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components/composer.tsx src/test/dom/composer.test.tsx
git commit -m "feat: move Send into the composer input group"
```

---

### Task 5: Give `+ New` a real creation flow

`create-session` already carries `model` and `effort`; the UI drops both. `cwd: ''` is correct and stays.

**Files:**
- Create: `src/webview/components/session-create-menu.tsx`
- Create: `src/test/dom/session-create-menu.test.tsx`
- Modify: `src/webview/components/session-picker.tsx:79-86`

**Interfaces:**
- Consumes: `state.catalog: ProviderInfo[]` from the store.
- Produces: `export function SessionCreateMenu(): JSX.Element` — no props; reads the store itself, like `SessionPicker` does.

- [ ] **Step 1: Write the failing test**

Create `src/test/dom/session-create-menu.test.tsx`:

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';

function hydrate() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });
}

suite('SessionCreateMenu', () => {
  setup(() => resetHost());

  test('creating with the defaults sends the first model and its default effort', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-large',
      effort: 'medium',
    });
  });

  test('choosing a model without effort support omits effort', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Fake Small' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-small',
    });
  });

  test('the trigger is disabled until the catalog arrives', () => {
    renderApp();
    const trigger = screen.getByRole('button', { name: 'New session' });
    assert.ok((trigger as HTMLButtonElement).disabled);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — no button named `New session` exists; the current one reads `+ New`.

- [ ] **Step 3: Write minimal implementation**

Create `src/webview/components/session-create-menu.tsx`:

```tsx
import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';

/**
 * `create-session` has carried `model` and `effort` since the protocol was
 * written, and SessionManager.create resolves them (falling back to
 * `models[0]` and the model's default effort). The UI simply never sent them,
 * so every session silently took the first model. `cwd` stays `''` on purpose:
 * MessageRouter reads that as "use the workspace root", which is what a
 * single-root workspace wants and what `+ New` should keep meaning.
 */
export function SessionCreateMenu() {
  const { state, post } = useStore();
  const provider = state.catalog[0];
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);

  const model = provider?.models.find((m) => m.id === modelId) ?? provider?.models[0];
  const chosenEffort = effort ?? model?.effort?.default;

  const create = () => {
    if (!provider || !model) { return; }
    post({
      t: 'create-session',
      providerId: provider.id,
      cwd: '',
      model: model.id,
      ...(model.effort ? { effort: chosenEffort as never } : {}),
    });
    setModelId(null);
    setEffort(null);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" className="shrink-0" disabled={!provider} />}
        aria-label="New session"
      >
        <PlusIcon aria-hidden />
        New
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model?.id} onValueChange={setModelId}>
          {provider?.models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              {m.displayName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {model?.effort && (
          <>
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={chosenEffort ?? undefined}
              onValueChange={setEffort}
            >
              {model.effort.levels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {level}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={create}>Create session</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

In `session-picker.tsx`, delete the inline `+ New` Button and its `providerId` local, and render `<SessionCreateMenu />` in its place.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. `session-picker.test.tsx`'s `'New posts create-session with the first catalog provider'` test now belongs to this file — delete it there.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "feat: choose model and effort when creating a session"
```

---

## Phase 3 — Roster and destructive actions

### Task 6: One row per session, with a guarded delete

The dropdown currently renders every session twice — N checkbox rows, a separator, then N `Delete "title"` rows that fire immediately. Deletion is placed in a per-row submenu so the confirm is keyboard-native and needs no custom focus management.

**Files:**
- Create: `src/webview/components/session-row.tsx`
- Modify: `src/webview/components/session-picker.tsx:26-61`
- Test: `src/test/dom/session-picker.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary` from the protocol.
- Produces: `export function SessionRow(props: { session: SessionSummary; open: boolean; onToggle: () => void }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Replace the `'the delete item posts delete-session'` test in `src/test/dom/session-picker.test.tsx` with:

```tsx
test('each session appears exactly once in the roster', async () => {
  renderApp();
  hydrateAOpen();

  await userEvent.click(screen.getByText('Sessions (1/2)'));
  assert.strictEqual(
    (await screen.findAllByText('Session b')).length, 1,
    'the roster listed every session twice: once to toggle, once to delete',
  );
});

test('delete is behind a per-row confirm and only fires on the second step', async () => {
  renderApp();
  hydrateAOpen();

  await userEvent.click(screen.getByText('Sessions (1/2)'));
  await userEvent.click(await screen.findByLabelText('Delete session Session b'));

  assert.ok(
    !posted().some((m) => m.t === 'delete-session'),
    'opening the confirm must not delete anything',
  );

  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete Session b' }));
  assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
});

test('the confirm offers a way out', async () => {
  renderApp();
  hydrateAOpen();

  await userEvent.click(screen.getByText('Sessions (1/2)'));
  await userEvent.click(await screen.findByLabelText('Delete session Session b'));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Keep it' }));

  assert.ok(!posted().some((m) => m.t === 'delete-session'));
});

test('toggling visibility still posts set-layout and set-visible', async () => {
  renderApp();
  hydrateAOpen();

  await userEvent.click(screen.getByText('Sessions (1/2)'));
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Session b/ }));

  assert.deepStrictEqual(posted().filter((m) => m.t === 'set-visible').at(-1), {
    t: 'set-visible', sessionIds: ['a', 'b'],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — `findAllByText('Session b')` returns 2, and clicking the delete label posts `delete-session` immediately.

- [ ] **Step 3: Write minimal implementation**

Create `src/webview/components/session-row.tsx`:

```tsx
import { Trash2Icon } from 'lucide-react';
import {
  DropdownMenuCheckboxItem, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

/**
 * The delete confirm is a submenu rather than local state plus a swapped-in
 * pair of buttons. A nested <button> inside a menuitemcheckbox is not
 * reachable by the menu's arrow-key roving focus, so the hover-revealed icon
 * would be mouse-only. A SubmenuTrigger *is* a menu item: ArrowRight opens it,
 * Escape backs out, and the confirm costs no custom focus management.
 */
export function SessionRow({
  session, open, onToggle,
}: {
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { post } = useStore();

  return (
    <DropdownMenuGroup className="group/row flex items-center gap-1">
      <DropdownMenuCheckboxItem
        checked={open}
        onCheckedChange={onToggle}
        className="min-w-0 flex-1"
      >
        <span className="truncate">{session.title}</span>
        {session.archived && (
          <span className="ml-auto pl-2 text-muted-foreground">archived</span>
        )}
      </DropdownMenuCheckboxItem>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={`Delete session ${session.title}`}
          className="shrink-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
        >
          <Trash2Icon aria-hidden />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => post({ t: 'delete-session', id: session.id })}
          >
            Delete {session.title}
          </DropdownMenuItem>
          <DropdownMenuItem>Keep it</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
  );
}
```

In `session-picker.tsx`, replace both `state.sessions.map(...)` blocks and the `DropdownMenuSeparator` between them with one:

```tsx
{state.sessions.map((s) => (
  <SessionRow key={s.id} session={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
))}
```

`DropdownMenuSubTrigger` renders a chevron by default (`dropdown-menu.tsx:101-121`); pass whatever prop that component exposes to suppress it, or set `[&>svg:last-child]:hidden` on the trigger. Check the vendored source before choosing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. If arrow-key traversal does not reach the submenu trigger, that is a real failure — fix it here rather than deferring; the whole point of the submenu is keyboard reachability.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "feat: one roster row per session with a guarded delete"
```

---

### Task 7: Make the split discoverable

Splitting is the product's headline feature and has no affordance. The only place the word "split" appears is an `aria-label` sighted users never see, and the control it labels is a no-op below 500px.

**Files:**
- Modify: `src/webview/components/session-picker.tsx`
- Modify: `src/webview/components/pane-group.tsx:18-52`
- Test: `src/test/dom/session-picker.test.tsx`, `src/test/dom/pane-group.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const NARROW_PX = 500` from `pane-group.tsx`, and `export function useIsNarrow(ref): boolean` moved there so the picker can share it.

- [ ] **Step 1: Write the failing test**

```tsx
test('the roster trigger says what checking a row does', async () => {
  renderApp();
  hydrateAOpen();

  screen.getByRole('button', { name: /1 of 2 in split/i });
});

test('the orientation toggle announces its current state', () => {
  renderApp();
  hydrateAOpen();

  const toggle = screen.getByLabelText(/split direction/i);
  assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
});

test('the empty state offers the way out', () => {
  renderApp();
  sendFromHost({
    t: 'hydrate', sessions: [], layout: { orientation: 'vertical', panes: [] },
    snapshots: [], catalog: catalog(),
  });

  screen.getByText(/no sessions yet/i);
  screen.getByRole('button', { name: 'New session' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — the trigger reads `Sessions (1/2)`, the toggle has no `aria-pressed`, and the empty state is the bare string `No open sessions.`

- [ ] **Step 3: Write minimal implementation**

Trigger copy — say what the number means:

```tsx
<DropdownMenuTrigger
  render={<Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start" />}
>
  <ColumnsIcon aria-hidden />
  {open.size} of {state.sessions.length} in split
</DropdownMenuTrigger>
```

Orientation control — real label, real state, honest about the narrow case:

```tsx
const horizontal = state.layout.orientation === 'horizontal';

<Button
  variant="outline"
  size="icon-sm"
  aria-label={`Split direction: ${horizontal ? 'side by side' : 'stacked'}`}
  aria-pressed={horizontal}
  disabled={narrow}
  title={narrow
    ? 'The panel is too narrow to split side by side; panes stack until it is wider.'
    : undefined}
  className="shrink-0"
  onClick={/* unchanged */}
>
  {horizontal ? <ColumnsIcon aria-hidden /> : <RowsIcon aria-hidden />}
</Button>
```

`narrow` comes from the `ResizeObserver` currently private to `PaneGroup`. Export `NARROW_PX` and the observer hook from `pane-group.tsx` and call it in `SessionPicker` against its own root ref — the picker and the pane group share a width, so either may observe it.

Empty state in `pane-group.tsx`:

```tsx
if (panes.length === 0) {
  return (
    <div ref={rootRef} className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <p className="text-xs text-muted-foreground">
        {roster.length === 0
          ? 'No sessions yet. Start one to give an agent something to do.'
          : 'No sessions in the split. Pick one from the roster above to show it here.'}
      </p>
      {roster.length === 0 && <SessionCreateMenu />}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. jsdom has no `ResizeObserver`; if `src/test/dom/setup.ts` does not already stub it, add a stub there that reports a wide box so `narrow` defaults to `false`.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "feat: make the split roster and orientation control self-explanatory"
```

---

## Phase 4 — Status, identity, transcript

### Task 8: A status model that distinguishes "needs you" from "failed"

`awaiting-approval` and `error` are the same red dot, the dot is `aria-hidden`, and there is no `aria-live` anywhere in `src/`. A pending approval in a pane you cannot see is unannounced and invisible.

**Files:**
- Create: `src/webview/status.ts`
- Create: `src/webview/components/status-badge.tsx`
- Create: `src/test/unit/status.test.ts`
- Create: `src/test/dom/session-header.test.tsx`
- Modify: `src/webview/components/session-header.tsx:8-23`
- Modify: `src/webview/components/session-picker.tsx`

**Interfaces:**
- Produces: `export interface StatusView { label: string; tone: 'idle' | 'busy' | 'attention' | 'failed'; needsUser: boolean }` and `export function statusView(status: SessionStatus): StatusView` from `src/webview/status.ts`; `export function StatusBadge({ status }: { status: SessionStatus }): JSX.Element` from `status-badge.tsx`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/status.test.ts`:

```ts
import * as assert from 'assert';
import { statusView } from '../../webview/status';

suite('statusView', () => {
  test('awaiting-approval is its own tone, not the error tone', () => {
    assert.notStrictEqual(statusView('awaiting-approval').tone, statusView('error').tone);
  });

  test('only awaiting-approval needs the user', () => {
    assert.strictEqual(statusView('awaiting-approval').needsUser, true);
    for (const s of ['idle', 'running', 'error'] as const) {
      assert.strictEqual(statusView(s).needsUser, false, s);
    }
  });

  test('every status has a human label', () => {
    for (const s of ['idle', 'running', 'awaiting-approval', 'error'] as const) {
      assert.ok(statusView(s).label.length > 0, s);
    }
  });
});
```

`src/test/dom/session-header.test.tsx`:

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';

function hydrate(over = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', over)],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', over)],
    catalog: catalog(),
  });
}

suite('SessionHeader status', () => {
  test('status is announced as text, not colour alone', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    const live = screen.getByText('Needs you');
    assert.strictEqual(live.closest('[aria-live]')?.getAttribute('aria-live'), 'polite');
  });

  test('awaiting-approval and error read differently', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'error' });
    screen.getByText('Failed');
    assert.strictEqual(screen.queryByText('Needs you'), null);
  });

  test('the roster trigger counts sessions that need the user', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    screen.getByText(/1 needs you/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit && yarn test:dom`
Expected: FAIL — `src/webview/status` does not exist; no text `Needs you` renders anywhere.

- [ ] **Step 3: Write minimal implementation**

`src/webview/status.ts`:

```ts
import type { SessionStatus } from '../protocol/messages';

export interface StatusView {
  label: string;
  tone: 'idle' | 'busy' | 'attention' | 'failed';
  /** The agent is blocked on a human decision. Distinct from `failed`. */
  needsUser: boolean;
}

const VIEW: Record<SessionStatus, StatusView> = {
  idle: { label: 'Idle', tone: 'idle', needsUser: false },
  running: { label: 'Working', tone: 'busy', needsUser: false },
  'awaiting-approval': { label: 'Needs you', tone: 'attention', needsUser: true },
  error: { label: 'Failed', tone: 'failed', needsUser: false },
};

export function statusView(status: SessionStatus): StatusView {
  return VIEW[status];
}
```

`src/webview/components/status-badge.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { statusView } from '../status';
import type { SessionStatus } from '../../protocol/messages';

const DOT: Record<string, string> = {
  idle: 'bg-muted-foreground',
  busy: 'bg-primary animate-pulse',
  attention: 'bg-primary',
  failed: 'bg-destructive',
};

const CHIP: Record<string, string> = {
  idle: 'text-muted-foreground',
  busy: 'text-muted-foreground',
  attention: 'border border-primary/40 bg-primary/10 text-foreground',
  failed: 'border border-destructive/40 bg-destructive/10 text-destructive',
};

/**
 * Text, not a colour alone — the same reasoning as the bypass badge below it.
 * `aria-live="polite"` because a status change is the one thing a user who is
 * not looking at this pane most needs to hear: "the agent is blocked on you"
 * and "the agent failed" demand opposite responses and used to render as the
 * identical red dot.
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  const view = statusView(status);
  return (
    <span
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium',
        CHIP[view.tone],
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', DOT[view.tone])} aria-hidden />
      {view.label}
    </span>
  );
}
```

In `session-header.tsx`, delete the `DOT` map and the bare dot span, and render `<StatusBadge status={s.status} />` in their place.

In `session-picker.tsx`, extend the trigger:

```tsx
const needing = state.sessions.filter((s) => statusView(s.status).needsUser).length;
...
{open.size} of {state.sessions.length} in split
{needing > 0 && <span className="ml-auto text-primary">{needing} needs you</span>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview src/test
git commit -m "feat: distinguish awaiting-approval from error and announce status"
```

---

### Task 9: Surface session identity — cwd and usage

`cwd` and `usage` are modeled end to end, carried on every summary, and rendered nowhere. With three panes open, sessions are distinguishable only by a host-generated title.

**Files:**
- Create: `src/webview/format.ts`
- Modify: `src/webview/components/session-header.tsx`
- Test: `src/test/dom/session-header.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary.cwd`, `SessionSummary.usage` from the protocol; `statusView` from Task 8.
- Produces: `export function folderName(cwd: string): string` and `export function formatTokens(n: number): string` from `src/webview/format.ts`. Task 11's permission card imports `folderName` from here — do not redefine it locally in either file.

- [ ] **Step 1: Write the failing test**

```tsx
test('the header shows the folder the agent is working in', () => {
  renderApp();
  hydrate({ cwd: '/repos/hiiiid-code' });

  screen.getByText('hiiiid-code');
  assert.strictEqual(
    screen.getByText('hiiiid-code').getAttribute('title'), '/repos/hiiiid-code',
    'the basename is what fits at 300px; the full path is the tooltip',
  );
});

test('token usage is shown once there is any', () => {
  renderApp();
  hydrate({ usage: { inputTokens: 12000, outputTokens: 3400 } });

  screen.getByText('15.4k tokens');
});

test('usage is hidden at zero rather than shown as 0', () => {
  renderApp();
  hydrate();
  assert.strictEqual(screen.queryByText(/tokens/), null);
});

test('the title wins the space contest, not the model label', () => {
  renderApp();
  hydrate();

  const title = screen.getByTitle('Session a');
  assert.ok(title.className.includes('truncate'));
  const model = screen.getByText(/Fake Large/);
  assert.ok(model.className.includes('truncate'), 'the model label must be able to shrink too');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — no cwd or token text is rendered, and the model label is `shrink-0`.

- [ ] **Step 3: Write minimal implementation**

Create `src/webview/format.ts` — a module, not two locals, because Task 11's permission card needs `folderName` too and a second copy would drift:

```ts
/** Last path segment. The full path lives in a title; 300px has no room for it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
```

And in `session-header.tsx`'s JSX, after the title:

```tsx
<span className="truncate text-muted-foreground" title={s.cwd}>
  {folderName(s.cwd)}
</span>
```

Replace the `ml-auto shrink-0` metadata span with a shrinkable one that no longer outranks the title:

```tsx
<span className="ml-auto min-w-0 truncate text-muted-foreground">
  {modelLabel}{s.effort ? ` · ${s.effort}` : ''}
  {total > 0 && ` · ${formatTokens(total)} tokens`}
</span>
```

where `const total = s.usage.inputTokens + s.usage.outputTokens;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components/session-header.tsx src/test/dom/session-header.test.tsx
git commit -m "feat: show cwd and token usage in the session header"
```

---

### Task 10: Render assistant markdown

Assistant text is `whitespace-pre-wrap`, so a coding agent's fenced code, lists and headings render as literal backticks and asterisks. This is the largest content-fidelity gap in the app.

**Files:**
- Create: `src/webview/components/markdown.tsx`
- Create: `src/test/dom/markdown.test.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `export function Markdown({ children }: { children: string }): JSX.Element`.

- [ ] **Step 1: Add the dependency and write the failing test**

```bash
yarn add react-markdown
```

`src/test/dom/markdown.test.tsx`:

```tsx
import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { Markdown } from '@/components/markdown';

suite('Markdown', () => {
  test('renders fenced code as a pre, not as backticks', () => {
    const { container } = render(<Markdown>{'```ts\nconst a = 1;\n```'}</Markdown>);
    const pre = container.querySelector('pre');
    assert.ok(pre, 'a fenced block must become a <pre>');
    assert.ok(pre!.textContent!.includes('const a = 1;'));
    assert.ok(!container.textContent!.includes('```'));
  });

  test('renders lists as lists', () => {
    const { container } = render(<Markdown>{'- one\n- two'}</Markdown>);
    assert.strictEqual(container.querySelectorAll('li').length, 2);
  });

  test('never emits a remote resource', () => {
    const { container } = render(
      <Markdown>{'![x](https://evil.test/a.png)\n\n[link](https://evil.test)'}</Markdown>,
    );
    assert.strictEqual(container.querySelector('img'), null, 'CSP is default-src none');
    const anchor = container.querySelector('a');
    assert.strictEqual(anchor, null, 'links are rendered as plain text, not anchors');
    screen.getByText(/link/);
  });

  test('raw HTML in the stream is not parsed', () => {
    const { container } = render(<Markdown>{'<img src=x onerror=alert(1)>'}</Markdown>);
    assert.strictEqual(container.querySelector('img'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — `Cannot find module '@/components/markdown'`.

- [ ] **Step 3: Write minimal implementation**

`src/webview/components/markdown.tsx`:

```tsx
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

/**
 * No plugins, and an explicit component map, because the webview's CSP is
 * `default-src 'none'`: an <img> or a stylesheet reference from agent output
 * would be blocked at load and show as a broken box, and an <a> is a
 * navigation this panel has no way to service. Both degrade to their text.
 * `react-markdown` does not parse raw HTML unless rehype-raw is added — it
 * is deliberately absent.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        img: ({ alt }) => <span className="text-muted-foreground">{alt ?? 'image'}</span>,
        a: ({ children: text }) => <>{text}</>,
        pre: ({ children: content }) => (
          <pre className="my-1 overflow-x-auto rounded bg-muted p-1.5 text-xs whitespace-pre-wrap wrap-break-word">
            {content}
          </pre>
        ),
        code: ({ className, children: content }) => (
          <code className={cn('rounded bg-muted px-1 py-0.5 text-xs', className)}>
            {content}
          </code>
        ),
        ul: ({ children: content }) => <ul className="my-1 list-disc pl-4">{content}</ul>,
        ol: ({ children: content }) => <ol className="my-1 list-decimal pl-4">{content}</ol>,
        h1: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h2: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h3: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        p: ({ children: content }) => <p className="my-1 wrap-break-word">{content}</p>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
```

Headings render as emphasized paragraphs on purpose: real `<h1>`–`<h3>` from arbitrary agent output would inject a nonsense document outline into a panel whose own structure is set in Task 12.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS, all four.

- [ ] **Step 5: Verify the bundle still builds and commit**

Run: `yarn lint && yarn check-types && yarn run compile`
Confirm `dist/webview.js` grew but built without a warning about a Node builtin.

```bash
git add package.json yarn.lock src/webview/components/markdown.tsx src/test/dom/markdown.test.tsx
git commit -m "feat: render assistant markdown with a CSP-safe component map"
```

---

### Task 11: Give the transcript a role hierarchy

Roles are currently distinguished by `border` vs `border-2`, which at 300px is no distinction at all. Long unbroken tokens are clipped rather than wrapped, because `pre-wrap` breaks only at whitespace and the scroller has no horizontal axis.

**Files:**
- Create: `src/webview/components/transcript-item-shell.tsx`
- Modify: `src/webview/components/transcript-item.tsx`
- Modify: `src/webview/components/permission-card.tsx`
- Modify: `src/webview/components/tool-card.tsx`
- Create: `src/test/dom/transcript-item.test.tsx`

**Interfaces:**
- Consumes: `Markdown` from Task 10.
- Produces: `export function TranscriptItemShell(props: { role: 'user' | 'assistant' | 'tool' | 'permission' | 'error'; label: string; ts?: number; children: ReactNode }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
test('every item is labelled by role', () => {
  renderApp();
  hydrateWithItems([
    { id: '1', ts: 1, role: 'user', text: 'hello' },
    { id: '2', ts: 2, role: 'assistant', text: 'hi `there`' },
  ]);

  screen.getByText('You');
  screen.getByText('Agent');
});

test('assistant text is rendered as markdown', () => {
  renderApp();
  hydrateWithItems([{ id: '2', ts: 2, role: 'assistant', text: '```\ncode\n```' }]);

  assert.ok(document.querySelector('pre'));
  assert.ok(!document.body.textContent!.includes('```'));
});

test('long unbroken tokens wrap rather than clip', () => {
  renderApp();
  hydrateWithItems([{ id: '1', ts: 1, role: 'user', text: 'x'.repeat(400) }]);

  const el = screen.getByText('x'.repeat(400));
  assert.ok(
    el.className.includes('wrap-break-word'),
    'pre-wrap breaks at whitespace only, and the scroller has no horizontal axis',
  );
});

test('an error item is capped so a stack trace cannot blow out the pane', () => {
  renderApp();
  hydrateWithItems([{ id: '3', ts: 3, role: 'error', message: 'boom\n'.repeat(200) }]);

  const el = screen.getByText(/boom/);
  assert.ok(/max-h-\d/.test(el.className) || /max-h-\d/.test(el.parentElement!.className));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — no role labels exist, assistant text renders raw, no `wrap-break-word`, error is uncapped.

- [ ] **Step 3: Write minimal implementation**

`src/webview/components/transcript-item-shell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const RULE: Record<string, string> = {
  user: 'border-l-muted-foreground/40',
  assistant: 'border-l-primary/40',
  tool: 'border-l-border',
  permission: 'border-l-destructive',
  error: 'border-l-destructive',
};

/**
 * One gutter idiom for every role, so scanning a 300px column is a matter of
 * reading a left rule and a label rather than comparing a 1px border to a 2px
 * one. `ts` is on every transcript item and had no renderer at all before.
 */
export function TranscriptItemShell({
  role, label, ts, children,
}: {
  role: 'user' | 'assistant' | 'tool' | 'permission' | 'error';
  label: string;
  ts?: number;
  children: ReactNode;
}) {
  return (
    <div className={cn('my-2 border-l-2 pl-2', RULE[role])}>
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {ts !== undefined && (
          <span
            className="text-[0.65rem] text-muted-foreground"
            title={new Date(ts).toLocaleString()}
          >
            {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
```

Rewrite `transcript-item.tsx`'s `user`, `assistant` and `error` branches:

```tsx
    case 'user':
      return (
        <TranscriptItemShell role="user" label="You" ts={item.ts}>
          <div className="rounded bg-muted px-2 py-1 wrap-break-word whitespace-pre-wrap">
            {item.text}
          </div>
        </TranscriptItemShell>
      );

    case 'assistant':
      return (
        <TranscriptItemShell role="assistant" label="Agent" ts={item.ts}>
          {item.thinking && (
            <div className="mb-1 border-l-2 border-border pl-2 text-xs wrap-break-word text-muted-foreground italic">
              {item.thinking}
            </div>
          )}
          <Markdown>{item.text}</Markdown>
        </TranscriptItemShell>
      );

    case 'error':
      return (
        <TranscriptItemShell role="error" label="Error" ts={item.ts}>
          <div className="max-h-48 overflow-auto rounded border border-destructive px-2 py-1 text-xs wrap-break-word whitespace-pre-wrap text-destructive">
            {item.message}
          </div>
        </TranscriptItemShell>
      );
```

In `permission-card.tsx`, make the pending card categorically heavier than anything else — it is the only item that demands an action — and stop discarding the diff on resolution:

```tsx
  if (item.state !== 'pending') {
    return (
      <TranscriptItemShell role="permission" label={`${item.name} — ${item.state}`} ts={item.ts}>
        {item.reason && <div className="text-xs text-muted-foreground">{item.reason}</div>}
        <details className="text-xs">
          <summary className="cursor-default text-muted-foreground">What was requested</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-1 wrap-break-word whitespace-pre-wrap">
{diff ?? safeStringify(item.input)}
          </pre>
        </details>
      </TranscriptItemShell>
    );
  }
```

and give the live card a fill plus the session's folder, since approving the right change in the wrong repo is the expensive mistake here. `PermissionCard` already reads the store for `isLive`, so the folder comes from the same lookup — import `folderName` from `../format` (Task 9), do not redefine it:

```tsx
  const cwd = state.byId[sessionId]?.summary.cwd ?? '';
  ...
  <div className="my-2 rounded border-2 border-destructive bg-destructive/10 p-2 text-xs">
    <div className="mb-1 flex items-baseline gap-2">
      <span className="font-medium">Allow {item.name}?</span>
      <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
    </div>
```

Colour the diff. Replace the single `<pre>` with a per-line render:

```tsx
<pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1 wrap-break-word whitespace-pre-wrap">
  {(diff ?? safeStringify(item.input)).split('\n').map((line, i) => (
    <div
      key={i}
      className={cn(
        line.startsWith('+') && 'text-(--vscode-gitDecoration-addedResourceForeground)',
        line.startsWith('-') && 'text-(--vscode-gitDecoration-deletedResourceForeground)',
      )}
    >
      {line}
    </div>
  ))}
</pre>
```

Those two are genuine VS Code theme tokens with no shadcn equivalent, so the arbitrary value is correct here rather than a worse spelling of a utility.

In `tool-card.tsx`, replace the glyphs and expose the disclosure state:

```tsx
const StateIcon = item.state === 'running' ? Loader2Icon
  : item.state === 'ok' ? CheckIcon : XIcon;
...
<Button
  variant="ghost"
  onClick={() => setOpen((v) => !v)}
  aria-expanded={open}
  aria-controls={`tool-${item.toolId}`}
  className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1 font-normal"
>
  <StateIcon aria-hidden className={cn(item.state === 'running' && 'animate-spin')} />
  <span className="sr-only">{item.state}</span>
  <span className="font-medium">{item.name}</span>
  <span className="truncate text-muted-foreground">{summarize(item.input)}</span>
</Button>
{open && (
  <pre id={`tool-${item.toolId}`} className="border-t border-border px-2 py-1 wrap-break-word whitespace-pre-wrap">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "feat: give transcript items a role hierarchy and safe wrapping"
```

---

### Task 12: Accessibility sweep

Everything the critique found that is not covered by an earlier task.

**Files:**
- Modify: `src/webview/components/pane-group.tsx`
- Modify: `src/webview/components/composer.tsx`
- Test: `src/test/dom/a11y.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

```tsx
test('close buttons are distinguishable from each other', () => {
  renderApp();
  hydrateTwoPanes();

  screen.getByLabelText('Close session Session a');
  screen.getByLabelText('Close session Session b');
});

test('resize handles name the panes they sit between', () => {
  renderApp();
  hydrateTwoPanes();

  screen.getByLabelText('Resize between Session a and Session b');
});

test('the disabled-bypass reason is available without hover', async () => {
  renderApp();
  hydrateOne();
  sendFromHost({ t: 'session-patch', id: 'a', patch: { op: 'append', item: {
    id: '1', ts: 1, role: 'user', text: 'go',
  } } });

  await userEvent.click(screen.getByLabelText('Permission mode'));
  const bypass = await screen.findByRole('option', { name: /bypass/i });
  assert.ok(
    bypass.getAttribute('aria-describedby'),
    'a title on a disabled option is not reliably announced',
  );
});

test('the panel has a heading structure', () => {
  renderApp();
  hydrateTwoPanes();

  assert.strictEqual(screen.getAllByRole('heading').length, 2, 'one heading per pane');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — labels are `Close session` and `Resize between panes 1 and 2`; the bypass option has only a `title`; there are zero headings.

- [ ] **Step 3: Write minimal implementation**

`pane-group.tsx` — name things by session, not by position:

```tsx
<ResizableHandle
  aria-label={`Resize between ${state.byId[panes[index - 1].sessionId].summary.title} and ${paneState.summary.title}`}
  withHandle
/>
```

`session-header.tsx` — the title becomes the pane's heading. `h2` because the panel is a view inside VS Code's own document, not a page with its own `h1`:

```tsx
<h2 className="truncate text-xs font-medium" title={s.title}>{s.title}</h2>
```

`composer.tsx` — replace the `title` on the disabled bypass option with a described-by element:

```tsx
<SelectItem value="bypass" disabled={disableBypass} aria-describedby={disableBypass ? 'bypass-reason' : undefined}>
  bypass
</SelectItem>
...
{hasStarted && (
  <p id="bypass-reason" className="px-1.5 py-1 text-[0.65rem] text-muted-foreground">
    Bypass can only be chosen before the first message is sent.
  </p>
)}
```

Task 7 put the orientation control's narrow-mode explanation in a `title` on a **disabled** button, which has the same defect this task is fixing for bypass: unreliably announced, unreachable without a pointer. Apply the same remedy rather than vendoring a tooltip primitive for one string — render the reason as visible helper text beside the control and point at it:

```tsx
<Button
  /* …as Task 7… */
  aria-describedby={narrow ? 'orientation-reason' : undefined}
/>
{narrow && (
  <span id="orientation-reason" className="sr-only">
    The panel is too narrow to split side by side; panes stack until it is wider.
  </span>
)}
```

`sr-only` rather than visible: at the width where this applies, there is no room for a sentence in the toolbar, and the control is already visibly disabled.

Focus recovery — in `pane-group.tsx`, when the pane count drops, move focus somewhere real instead of letting it fall to `<body>`:

```tsx
// Closing or deleting a session unmounts its pane. Without this, focus lands
// on <body> and a keyboard user is silently returned to the top of the
// document mid-task.
const prevCount = useRef(panes.length);
useEffect(() => {
  if (panes.length < prevCount.current && document.activeElement === document.body) {
    rootRef.current?.querySelector<HTMLElement>('[data-slot="button"]')?.focus();
  }
  prevCount.current = panes.length;
}, [panes.length]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview src/test/dom
git commit -m "fix: unique control names, heading structure and focus recovery"
```

---

### Task 13: Let the model change after creation

The only genuinely host-side gap. `pendingMode` and `pendingEffort` are already mutable closure vars in the Claude provider; `model` is the one still read straight off `opts` at construction.

**Files:**
- Modify: `src/protocol/messages.ts:73-85`
- Modify: `src/host/message-router.ts`
- Modify: `src/host/agent-session.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/fake/fake-provider.ts`
- Modify: `src/providers/claude/claude-provider.ts:230-256`
- Modify: `src/webview/components/session-header.tsx`
- Test: `src/test/unit/message-router.test.ts`, `src/test/unit/claude-provider.test.ts`, `src/test/dom/session-header.test.tsx`

**Interfaces:**
- Consumes: `AgentRun` from `providers/types.ts`.
- Produces: `{ t: 'set-model'; id: SessionId; model: string }` on `WebviewToHost`; `AgentRun.setModel(model: string): void`; `AgentSession.setModel(model: string): void`.

- [ ] **Step 1: Write the failing tests**

`src/test/unit/message-router.test.ts`:

```ts
test('set-model reaches the session', async () => {
  const { router, manager } = makeRouter();
  const session = await manager.create('fake', '/tmp');
  await router.handle({ t: 'set-model', id: session.id, model: 'fake-small' });

  assert.strictEqual((await session.snapshot()).model, 'fake-small');
});
```

`src/test/unit/claude-provider.test.ts`:

```ts
test('a model chosen before the first send is the one the query is built with', async () => {
  const { provider, constructed } = makeProvider();
  const run = provider.start({ cwd: '/tmp', model: 'opus', permissionMode: 'default' });

  run.setModel('haiku');
  run.send('go');
  await tick();

  assert.strictEqual(constructed.at(-1)!.model, 'haiku',
    'options are built lazily on first send, so a pre-send change must win');
});
```

`src/test/dom/session-header.test.tsx`:

```tsx
test('the model label is a control that posts set-model', async () => {
  renderApp();
  hydrate();

  await userEvent.click(screen.getByLabelText('Model'));
  await userEvent.click(await screen.findByRole('option', { name: 'Fake Small' }));

  assert.deepStrictEqual(posted().at(-1), { t: 'set-model', id: 'a', model: 'fake-small' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit && yarn test:dom`
Expected: FAIL — `set-model` is not in the `WebviewToHost` union, so the router test does not even type-check.

- [ ] **Step 3: Write minimal implementation**

`messages.ts` — one line in the union, beside its siblings:

```ts
  | { t: 'set-model'; id: SessionId; model: string }
```

`message-router.ts` — mirror the `set-effort` case exactly.

`agent-session.ts` — mirror `setEffort`: update `_state.model`, call `run?.setModel(model)`, emit the status/summary change the other setters emit.

`providers/types.ts` — add `setModel(model: string): void` to `AgentRun`.

`fake-provider.ts` — record it, like the other setters.

`claude-provider.ts`:

```ts
let pendingModel = opts.model;
```

then in `buildOptions()`, `model: pendingModel` instead of `model: opts.model`, and:

```ts
setModel: (next: string) => {
  pendingModel = next;
  // No applyFlagSettings equivalent: the SDK fixes the model at query
  // construction. Before the first send() there is no query yet, so the
  // line above is the whole change. After it, the new model applies to the
  // next session — which is why the UI disables this mid-conversation.
},
```

`session-header.tsx` — replace the static model text with a `Select` whose trigger is `size="sm"` and `variant`-less, `aria-label="Model"`, disabled once `pane.items.length > 0`, with a `Tooltip` giving the reason. This mirrors the bypass gate precedent exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test`

```bash
git add src test
git commit -m "feat: allow the model to be changed before the first message"
```

---

### Task 14: Fix the dev-host env scrub

Not a design defect, but it blocked visual verification of every task above and will block the next person the same way.

**Files:**
- Modify: `scripts/dev-host.ps1:36-48`

**Interfaces:** none.

- [ ] **Step 1: Replace the denylist with a pattern**

The literal list misses `VSCODE_ESM_ENTRYPOINT`, `VSCODE_CODE_CACHE_PATH`, `VSCODE_CRASH_REPORTER_PROCESS_TYPE`, `VSCODE_HANDLES_UNCAUGHT_ERRORS` and `VSCODE_L10N_BUNDLE_LOCATION` on VS Code 1.127, and will miss whatever 1.128 adds:

```powershell
# Every ELECTRON_* / VSCODE_* variable leaks in from the parent extension host
# and can break the launch. A literal list goes stale with each VS Code
# release — 1.127 added VSCODE_ESM_ENTRYPOINT, which boots the child as an
# extension host even after ELECTRON_RUN_AS_NODE is cleared. Match the shape
# instead of naming the members.
Get-ChildItem Env: |
    Where-Object { $_.Name -match '^(ELECTRON|VSCODE)_' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }
```

- [ ] **Step 2: Verify by launching**

Run: `yarn dev`
Expected: a second VS Code window opens and stays open. If it exits immediately, check for a running `CodeSetup-stable-*` process — a pending VS Code update holds the `vscode-updating` mutex and every new instance waits 30s and exits. That is not this script's fault.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-host.ps1
git commit -m "fix: scrub every inherited VSCODE_/ELECTRON_ variable in dev-host"
```

---

### Task 15: Collapse close / archive / delete into two honest concepts

Three overlapping destroy verbs wear two labels. The header's `×` posts `close-session` **and** drops the pane; `close-session` sets `archived: true` on the host; the roster checkbox drops the pane *without* archiving; `delete-session` destroys. The word "archived" appears exactly once, as grey text in a dropdown row. A user who clicks `×` to tidy the view has silently archived a session and can only find out by reopening the roster.

**Files:**
- Modify: `src/webview/components/session-header.tsx`
- Modify: `src/webview/components/session-row.tsx`
- Modify: `src/webview/components/session-picker.tsx`
- Test: `src/test/dom/session-header.test.tsx`, `src/test/dom/session-picker.test.tsx`

**Interfaces:**
- Consumes: `SessionRow` from Task 6.
- Produces: nothing importable. No protocol change — `close-session` keeps its host meaning; only what the UI *says* and *offers* changes.

- [ ] **Step 1: Write the failing test**

```tsx
test('the pane X removes the pane without archiving the session', async () => {
  renderApp();
  hydrateTwoPanes();

  await userEvent.click(screen.getByLabelText('Hide Session a from the split'));

  const layouts = posted().filter((m) => m.t === 'set-layout');
  assert.deepStrictEqual(layouts.at(-1)!.layout.panes.map((p) => p.sessionId), ['b']);
  assert.ok(
    !posted().some((m) => m.t === 'close-session'),
    'X means hide; archiving is a deliberate choice made from the roster',
  );
});

test('archive is an explicit, labelled action in the roster row', async () => {
  renderApp();
  hydrateAOpen();

  await userEvent.click(screen.getByText(/1 of 2 in split/i));
  await userEvent.click(await screen.findByLabelText('More actions for Session b'));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive Session b' }));

  assert.deepStrictEqual(posted().at(-1), { t: 'close-session', id: 'b' });
});

test('archived sessions are grouped, not marked with a word', async () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a'), summary('b', { archived: true })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });

  await userEvent.click(screen.getByText(/1 of 2 in split/i));
  screen.getByText('Archived (1)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom`
Expected: FAIL — the header button is labelled `Close session Session a` and posts `close-session`; there is no per-row actions menu; `archived` renders as an inline word.

- [ ] **Step 3: Write minimal implementation**

`session-header.tsx` — the `×` becomes exactly what the roster checkbox already is, and keeps only the layout half of its old behavior. The long comment currently on that handler explains why `close-session` must be paired with a `set-layout`; that reasoning no longer applies once `close-session` is gone from here, so replace the comment rather than leaving it stranded:

```tsx
<Button
  variant="ghost"
  size="icon-xs"
  aria-label={`Hide ${s.title} from the split`}
  className="shrink-0"
  onClick={() => {
    // Hide, not archive. This is the same operation as unchecking the row
    // in the roster, and posts the same message, so the two entry points
    // cannot drift. Archiving is a deliberate choice and lives in the
    // roster row's actions menu, under its own word.
    const remaining = state.layout.panes
      .map((p) => p.sessionId)
      .filter((id) => id !== s.id);
    post({ t: 'set-layout', layout: evenlySizedPanes(remaining, state.layout.orientation) });
  }}
>
  <XIcon aria-hidden />
</Button>
```

`session-row.tsx` — the delete submenu becomes an actions submenu holding both verbs. The trigger's label generalizes:

```tsx
<DropdownMenuSubTrigger
  aria-label={`More actions for ${session.title}`}
  className="shrink-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
>
  <MoreHorizontalIcon aria-hidden />
</DropdownMenuSubTrigger>
<DropdownMenuSubContent>
  <DropdownMenuItem onClick={() => post({ t: 'close-session', id: session.id })}>
    Archive {session.title}
  </DropdownMenuItem>
  <DropdownMenuSub>
    <DropdownMenuSubTrigger aria-label={`Delete session ${session.title}`}>
      Delete…
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent>
      <DropdownMenuItem
        variant="destructive"
        onClick={() => post({ t: 'delete-session', id: session.id })}
      >
        Delete {session.title}
      </DropdownMenuItem>
      <DropdownMenuItem>Keep it</DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>
</DropdownMenuSubContent>
```

Task 6's tests query `Delete session {title}` by label and then the `Delete {title}` menu item; both survive this change, which is why the labels are worth keeping verbatim.

`session-picker.tsx` — group rather than annotate, and drop the inline `archived` span from `session-row.tsx`:

```tsx
const live = state.sessions.filter((s) => !s.archived);
const archived = state.sessions.filter((s) => s.archived);
...
{live.map((s) => <SessionRow key={s.id} … />)}
{archived.length > 0 && (
  <>
    <DropdownMenuSeparator />
    <DropdownMenuLabel>Archived ({archived.length})</DropdownMenuLabel>
    {archived.map((s) => <SessionRow key={s.id} … />)}
  </>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS. Any earlier test asserting `close-session` from the header must be updated — that behavior is intentionally gone.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview/components src/test/dom
git commit -m "feat: separate hiding a pane from archiving a session"
```

---

### Task 16: Active pane, spacing rhythm, and the remaining minors

With N panes rendered at identical weight there is no active-pane indication anywhere, and the transcript pays a double spacing tax: `MessageScrollerContent` has `gap-6` (24px) and every item adds `my-1`/`my-2` on top.

**Files:**
- Modify: `src/webview/components/pane-group.tsx`
- Modify: `src/webview/components/transcript.tsx`
- Modify: `src/webview/components/transcript-item-shell.tsx`
- Modify: `src/webview/components/tool-card-format.ts`
- Modify: `src/webview/components/session-header.tsx`
- Test: `src/test/dom/pane-group.test.tsx`, `src/test/unit/tool-card-format.test.ts`

**Interfaces:**
- Consumes: `TranscriptItemShell` from Task 11.
- Produces: `summarize(input: unknown, budget?: number)` gains an optional second parameter defaulting to `44`.

- [ ] **Step 1: Write the failing test**

```tsx
test('the focused pane is visually distinguished', async () => {
  renderApp();
  hydrateTwoPanes();

  await userEvent.click(screen.getByLabelText('Message', { selector: '[data-slot="input-group-textarea"]' }));
  const panels = screen.getAllByRole('region');
  const active = panels.filter((p) => p.getAttribute('data-active') === 'true');
  assert.strictEqual(active.length, 1, 'exactly one pane is active at a time');
});
```

```ts
test('summarize fits the sidebar, not a desktop column', () => {
  const long = { path: 'x'.repeat(200) };
  assert.ok(summarize(long).length <= 44, '80 chars was tuned for a width this panel rarely has');
  assert.ok(summarize(long, 80).length <= 80, 'the budget stays overridable');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:dom && yarn test:unit`
Expected: FAIL — no `data-active` attribute exists, and `summarize` truncates at a hardcoded 80.

- [ ] **Step 3: Write minimal implementation**

`pane-group.tsx` — track focus within each pane. `focusin` bubbles, unlike `focus`:

```tsx
const [activeId, setActiveId] = useState<string | null>(null);
...
<ResizablePanel
  id={pane.sessionId}
  data-active={activeId === pane.sessionId}
  onFocusCapture={() => setActiveId(pane.sessionId)}
  className={cn(
    'transition-colors',
    // A ring, not a background: at 300px a filled active pane would fight
    // the permission card, which must stay the loudest thing on screen.
    activeId === pane.sessionId && 'ring-1 ring-ring/40 ring-inset',
  )}
  /* …unchanged props… */
>
```

`transcript.tsx` — one rhythm, not two. Drop the viewport's `gap-6` down to the sidebar's scale and let the items own their own margins:

```tsx
<MessageScrollerContent className="gap-2">
```

`transcript-item-shell.tsx` — with the gap now carrying separation, drop `my-2` from the shell to `my-0`.

`tool-card-format.ts`:

```ts
/** 44 chars is what fits at ~300px, the width this panel usually has. */
export function summarize(input: unknown, budget = 44): string {
```

`session-header.tsx` — show which backend a session runs on, so two sessions on different providers are distinguishable. `ProviderInfo.displayName` is already in `state.catalog` and rendered nowhere:

```tsx
const providerLabel = state.catalog.find((p) => p.id === s.providerId)?.displayName;
```

and append it to the metadata span only when more than one provider exists — with a single backend it is noise:

```tsx
{state.catalog.length > 1 && providerLabel && ` · ${providerLabel}`}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom && yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types && yarn run compile`

```bash
git add src/webview src/test
git commit -m "feat: mark the active pane and fix the transcript spacing rhythm"
```

---

## Deliberately Out of Scope

Named so a later reader knows these were considered, not missed. Each is a feature, not a defect, and each needs its own brainstorm:

- **"Always allow this tool for this session."** The critique's strongest power-user finding. Today the only choices are approve-every-time or flip the whole session to `bypass`. Needs a rule model on the host, not a button.
- **Keyboard accelerators** — `Ctrl+1..9` to focus a pane, cycle, jump-to-composer. Task 16 adds the active-pane concept these would move between.
- **Session rename.** Titles are host-generated and immutable; no protocol message exists.
- **A roster-level approval queue.** Critique question 2 — if human-in-the-loop is the product, an approval waiting in a hidden pane arguably deserves a first-class surface rather than the "needs you" counter Task 8 adds.
- **Multi-root `cwd` choice.** `workspaceFolders?.[0]` pins every session to the first folder. Only worth a picker when `workspaceFolders.length > 1`, which needs a host-side capability message the protocol does not have.

## Final Verification

- [ ] `yarn lint` — zero errors, zero warnings
- [ ] `yarn check-types` — clean
- [ ] `yarn run compile` — clean
- [ ] `yarn test:unit` — all pass
- [ ] `yarn test:dom` — all pass
- [ ] `yarn test` — integration passes
- [ ] `node "C:\Users\Marco\.claude\skills\impeccable\scripts\detect.mjs" --json src/webview` — exit 0
- [ ] `yarn dev`, then walk the scene by hand at ~350px: create a session choosing a model, split a second one in, trigger an approval, deny it, delete a session, and confirm every one of those reads correctly in both a light and a dark VS Code theme.
- [ ] Re-run `/impeccable critique src/webview` and compare against the 15/40 baseline.
