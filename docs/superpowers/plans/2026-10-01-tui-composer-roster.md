# TUI composer and roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@` file mentions, path attachments (paste and `/attach`), and roster pin, filter, hide and delete in the Marcode TUI.

**Architecture:** The host and protocol already support everything (`file-search`, `attach-drop`, `set-pinned`, `delete-session`). The work is client-side: move the pure mention helpers into `src/client-core/mentions/` so both clients share them, add a pure path-paste parser, extend the pure roster view model and keymap, then wire three OpenTUI components (mention popup, attachment chips, roster actions) into the existing composer, roster and `App`.

**Tech Stack:** TypeScript, OpenTUI (`@opentui/react`, `@opentui/core`) on Bun, mocha (pure logic), `bun test` (components).

**Spec:** `docs/superpowers/specs/2026-10-01-tui-composer-roster-design.md`

## Global Constraints

- Branch `feat/tui-features`. Never push or merge. No git worktrees. Commit after each task with `feat:`/`fix:`/`test:`/`docs:`/`chore:` prefixes. NEVER add a `Co-Authored-By` or any Claude/Anthropic trailer.
- Pin every gate command with its own `cd /e/Efebia/hiiiid-code &&` (shell cwd reverts between calls).
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM; `src/protocol/messages.ts` stays types-only (no protocol change is needed in this plan).
- Every session-addressed message carries an explicit `SessionId`. Errors are state: failures surface as notices, never thrown. The TUI never writes a session it does not own.
- Tests: never hand a renderer or renderable to an assertion (frame strings, counts, booleans only; `scripts/check-tui-asserts.mjs` enforces it). Never mock the store or hand-build `ClientState`: feed genuine `HostToWebview` messages through `src/test/tui/harness.tsx` (`mount`, `hydrateMsg`, `m.fromHost`, `m.press`, `m.type`, `m.frame`, `m.posted`).
- Pure logic tests go on mocha (`src/test/unit/*.test.ts`, TDD `suite`/`test`, `node:assert`); component tests on bun (`src/test/tui/*.test.tsx`).
- Comments minimal: only non-obvious "why". Files over ~300 lines get split. Filenames kebab-case.
- Never run `yarn build:tui:bin`. Temp files only in the OS temp dir and deleted right after the test that made them. No scratch folders in the repo.
- Gates before each commit that touches code: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, plus the tests named in the task.
- `OpenTUI` facts from the v1 plan's "Deviations" section apply: `<box>` needs `border` with `borderStyle`; Ctrl+J arrives as `linefeed`; `mockInput.typeText` needs React `act` (the harness already wraps it).

## Review Focus

Inputs the spec implies but a happy-path test would miss:

1. A path pasted with trailing newline or surrounding whitespace (terminals append one) must still attach. Pinned in Task 2.
2. A paste of prose that merely contains a path (`see C:\x.png please`) must insert as text, not attach. Task 2 and Task 6.
3. A pasted path that does not exist, or is a directory, must insert as text and attach nothing. Task 6.
4. `@` inside an email address or mid-word must not open the popup, and a `file-search-result` for an older query must not overwrite a newer one. Task 5.
5. Deleting a session while the roster filter hides other rows, and a pin toggle while filtering, must act on the row under the cursor, not on the unfiltered index. Task 4.

---

### Task 1: Move the mention helpers into client-core

**Files:**
- Move: `src/webview/lib/mention-menu.ts` → `src/client-core/mentions/mention-menu.ts`
- Move: `src/webview/lib/file-mentions.ts` → `src/client-core/mentions/file-mentions.ts`
- Move: `src/webview/lib/session-mentions.ts` → `src/client-core/mentions/session-mentions.ts`
- Modify: `src/webview/components/composer.tsx` (imports at lines ~10-22), `src/webview/components/ref-menu.tsx` (line 3)
- Move tests: `src/test/unit/mention-menu.test.ts`, `file-mentions.test.ts`, `session-mentions.test.ts` (update their imports only)

**Interfaces:**
- Produces (unchanged API, new path `src/client-core/mentions/`): `mentionQuery(text, caret)`, `filterMentions`, `tokenFor`, `tokenPresent`, `spliceMention`, `pruneMentions`, `MentionOption<P>`, `PendingMention<P>` from `mention-menu`; `fileMentions(files)`, `fileRefsOf(pending)`, `FileMentionPayload` from `file-mentions`; `sessionMentions`, `SessionMentionPayload` from `session-mentions`.

The moved files import only `../../protocol/messages` and each other, and the new folder is the same depth as `src/webview/lib`, so their internal imports stay valid. `use-mention-menu.ts` is React and stays in `src/webview/lib/`.

- [ ] **Step 1: Move with git**

```bash
cd /e/Efebia/hiiiid-code && mkdir -p src/client-core/mentions \
  && git mv src/webview/lib/mention-menu.ts src/client-core/mentions/mention-menu.ts \
  && git mv src/webview/lib/file-mentions.ts src/client-core/mentions/file-mentions.ts \
  && git mv src/webview/lib/session-mentions.ts src/client-core/mentions/session-mentions.ts
```

- [ ] **Step 2: Fix every importer**

Find them: `cd /e/Efebia/hiiiid-code && grep -rn "lib/mention-menu\|lib/file-mentions\|lib/session-mentions\|'./mention-menu'" src --include=*.ts --include=*.tsx`

Rewrite each:
- In `src/webview/components/*.tsx`: `"../lib/mention-menu"` → `"../../client-core/mentions/mention-menu"` (likewise `file-mentions`, `session-mentions`).
- In `src/test/unit/mention-menu.test.ts`, `file-mentions.test.ts`, `session-mentions.test.ts`: `'../../webview/lib/<name>'` → `'../../client-core/mentions/<name>'`.
- `src/webview/lib/use-mention-menu.ts` and `invocable-menu.ts` do not import the moved files; leave them.

- [ ] **Step 3: Verify nothing else broke**

```bash
cd /e/Efebia/hiiiid-code && yarn check-types && yarn lint && yarn test:unit && yarn test:dom
```
Expected: all pass, same test counts as before the move.

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A && git commit -m "chore: move mention helpers to client-core for sharing with the TUI"
```

---

### Task 2: Pure path-paste parser

**Files:**
- Create: `src/client-core/path-paste.ts`
- Create: `src/tui/attach-paths.ts`
- Test: `src/test/unit/path-paste.test.ts`, `src/test/unit/tui-attach-paths.test.ts`

**Interfaces:**
- Produces: `parsePastedPaths(text: string): string[]` (absolute filesystem paths, `[]` when the text is not purely path(s)); `parseAttachCommand(text: string): string[] | undefined` (paths after a leading `/attach `, `undefined` when the text is not that command); `existingFileUris(paths: string[]): string[] | undefined` in `src/tui/attach-paths.ts` (`file://` URIs when every path is an existing regular file, else `undefined`).

A refinement of the spec: the parser returns filesystem paths and the TUI layer converts to URIs with `pathToFileURL`, since only the TUI layer touches `fs`. The host's `fsPathOfUri` accepts exactly what `pathToFileURL` produces.

- [ ] **Step 1: Write the failing parser tests**

Create `src/test/unit/path-paste.test.ts`:

```ts
import * as assert from 'node:assert';
import { parseAttachCommand, parsePastedPaths } from '../../client-core/path-paste';

suite('path paste', () => {
  test('a bare POSIX or Windows absolute path', () => {
    assert.deepStrictEqual(parsePastedPaths('/home/me/a.png'), ['/home/me/a.png']);
    assert.deepStrictEqual(parsePastedPaths('C:\\Users\\me\\a.png'), ['C:\\Users\\me\\a.png']);
    assert.deepStrictEqual(parsePastedPaths('\\\\host\\share\\a.png'), ['\\\\host\\share\\a.png']);
  });
  test('surrounding whitespace and a trailing newline are ignored', () => {
    assert.deepStrictEqual(parsePastedPaths('  /a/b.txt\r\n'), ['/a/b.txt']);
  });
  test('quoted paths keep their spaces', () => {
    assert.deepStrictEqual(parsePastedPaths('"C:\\My Files\\a b.png"'), ['C:\\My Files\\a b.png']);
    assert.deepStrictEqual(parsePastedPaths("'/tmp/my dir/a.png'"), ['/tmp/my dir/a.png']);
  });
  test('a backslash-escaped space joins the token', () => {
    assert.deepStrictEqual(parsePastedPaths('/tmp/my\\ dir/a.png'), ['/tmp/my dir/a.png']);
  });
  test('file URIs decode to paths', () => {
    assert.deepStrictEqual(parsePastedPaths('file:///tmp/a%20b.png'), ['/tmp/a b.png']);
    assert.deepStrictEqual(parsePastedPaths('file:///C:/Users/me/a%20b.png'), ['C:/Users/me/a b.png']);
  });
  test('several paths separated by newlines or spaces', () => {
    assert.deepStrictEqual(parsePastedPaths('/a/1.txt\n/a/2.txt'), ['/a/1.txt', '/a/2.txt']);
    assert.deepStrictEqual(parsePastedPaths('"/a b/1.txt" /a/2.txt'), ['/a b/1.txt', '/a/2.txt']);
  });
  test('prose that contains a path is not a path paste', () => {
    assert.deepStrictEqual(parsePastedPaths('see /etc/hosts please'), []);
    assert.deepStrictEqual(parsePastedPaths('look at C:\\x.png'), []);
  });
  test('relative paths, empty and unbalanced-quote input are not paths', () => {
    assert.deepStrictEqual(parsePastedPaths('./a.png'), []);
    assert.deepStrictEqual(parsePastedPaths('a.png'), []);
    assert.deepStrictEqual(parsePastedPaths(''), []);
    assert.deepStrictEqual(parsePastedPaths('   \n'), []);
    assert.deepStrictEqual(parsePastedPaths('"/a/b.png'), []);
  });
  test('one non-path token spoils the whole paste', () => {
    assert.deepStrictEqual(parsePastedPaths('/a/1.txt hello'), []);
  });
});

suite('attach command', () => {
  test('/attach takes the rest as paths', () => {
    assert.deepStrictEqual(parseAttachCommand('/attach /a/b.png'), ['/a/b.png']);
    assert.deepStrictEqual(parseAttachCommand('  /attach "C:\\My Files\\a.png"  '), ['C:\\My Files\\a.png']);
  });
  test('anything else is not the command', () => {
    assert.strictEqual(parseAttachCommand('/attachments'), undefined);
    assert.strictEqual(parseAttachCommand('please /attach /a'), undefined);
    assert.strictEqual(parseAttachCommand('hello'), undefined);
  });
  test('/attach with no usable path is the command with no paths', () => {
    assert.deepStrictEqual(parseAttachCommand('/attach'), []);
    assert.deepStrictEqual(parseAttachCommand('/attach nope.png'), []);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -20`
Expected: FAIL, cannot find module `../../client-core/path-paste`.

- [ ] **Step 3: Implement the parser**

Create `src/client-core/path-paste.ts`:

```ts
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

// Backslash only escapes a space: on Windows it is the path separator.
function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { quote = null; } else { cur += c; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && text[i + 1] === ' ') { cur += ' '; i++; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (quote) { return []; }
  if (started) { out.push(cur); }
  return out;
}

function fromFileUri(uri: string): string | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.protocol !== 'file:') { return undefined; }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
}

/** The absolute paths in `text`, or `[]` unless every token in it is one. */
export function parsePastedPaths(text: string): string[] {
  const tokens = tokenize(text);
  const paths: string[] = [];
  for (const token of tokens) {
    const path = token.startsWith('file://') ? fromFileUri(token) : token;
    if (path === undefined || !ABSOLUTE.test(path)) { return []; }
    paths.push(path);
  }
  return paths;
}

const ATTACH = /^\/attach(?:\s+([\s\S]*))?$/;

/** `undefined` when `text` is not the `/attach` command; `[]` when it is but names no usable path. */
export function parseAttachCommand(text: string): string[] | undefined {
  const match = ATTACH.exec(text.trim());
  if (!match) { return undefined; }
  return parsePastedPaths(match[1] ?? '');
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -20`
Expected: PASS including the new suites.

- [ ] **Step 5: Write the failing TUI-layer test**

Create `src/test/unit/tui-attach-paths.test.ts`:

```ts
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existingFileUris } from '../../tui/attach-paths';

suite('tui attach paths', () => {
  let dir = '';
  setup(() => { dir = mkdtempSync(join(tmpdir(), 'marcode-attach-')); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  test('existing regular files become file URIs', () => {
    const a = join(dir, 'a b.txt');
    writeFileSync(a, 'x');
    assert.deepStrictEqual(existingFileUris([a]), [pathToFileURL(a).href]);
  });
  test('a missing path, a directory or no paths yields undefined', () => {
    const a = join(dir, 'a.txt');
    writeFileSync(a, 'x');
    assert.strictEqual(existingFileUris([a, join(dir, 'missing.txt')]), undefined);
    assert.strictEqual(existingFileUris([dir]), undefined);
    assert.strictEqual(existingFileUris([]), undefined);
  });
});
```

- [ ] **Step 6: Run to see it fail, then implement**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15` (Expected: FAIL, module not found.)

Create `src/tui/attach-paths.ts`:

```ts
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function existingFileUris(paths: string[]): string[] | undefined {
  if (paths.length === 0) { return undefined; }
  for (const path of paths) {
    try { if (!statSync(path).isFile()) { return undefined; } } catch { return undefined; }
  }
  return paths.map((path) => pathToFileURL(path).href);
}
```

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15` (Expected: PASS.)

- [ ] **Step 7: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui \
  && git add -A && git commit -m "feat: parse pasted file paths and the /attach command"
```

---

### Task 3: Roster view model and keymap (pin, filter, delete)

**Files:**
- Modify: `src/tui/view/roster-rows.ts`
- Modify: `src/tui/keymap.ts`
- Test: `src/test/unit/tui-view.test.ts` (roster suite), `src/test/unit/tui-keymap.test.ts`

**Interfaces:**
- Produces: `RosterRow` gains `pinned: boolean` and `foreign: boolean`. `rosterRows(sessions: SessionSummary[], focusedId: SessionId | null, filter = ''): RosterRow[]` returns pinned rows first (stable within each group), then the rest, keeping only rows whose title contains `filter` case-insensitively. `Action` gains `{ do: 'roster-pin' } | { do: 'roster-filter' } | { do: 'roster-delete' } | { do: 'attach-remove' }`. Keymap: roster zone `p` → `roster-pin`, `/` → `roster-filter`, shift+`d` → `roster-delete` (plain `d` stays unbound); composer zone Ctrl+X → `attach-remove`.

- [ ] **Step 1: Write the failing tests**

Append to the `tui view: roster rows` suite in `src/test/unit/tui-view.test.ts` (inside the existing `suite(...)` block, before its closing `});`):

```ts
  test('pinned rows sort first, stably, and carry the foreign flag', () => {
    const rows = rosterRows([
      summary('a', { name: 'alpha' }),
      summary('b', { name: 'beta', pinned: true }),
      summary('c', { name: 'gamma', pinned: true, owner: { host: 'vscode', pid: 1 } }),
      summary('d', { name: 'delta' }),
    ], null);
    assert.deepStrictEqual(rows.map((r) => r.id), ['b', 'c', 'a', 'd']);
    assert.deepStrictEqual(rows.map((r) => r.pinned), [true, true, false, false]);
    assert.deepStrictEqual(rows.map((r) => r.foreign), [false, true, false, false]);
  });
  test('the filter matches the title case-insensitively and keeps pinned-first order', () => {
    const rows = rosterRows([
      summary('a', { name: 'API fix' }),
      summary('b', { name: 'docs' }),
      summary('c', { name: 'api docs', pinned: true }),
    ], null, 'API');
    assert.deepStrictEqual(rows.map((r) => r.id), ['c', 'a']);
  });
  test('an empty filter keeps every row', () => {
    assert.strictEqual(rosterRows([summary('a'), summary('b')], null, '').length, 2);
  });
```

Append to `src/test/unit/tui-keymap.test.ts` inside its `suite('tui keymap', ...)` block:

```ts
  test('roster: p pins, / filters, shift+d deletes, plain d does nothing', () => {
    assert.deepStrictEqual(actionFor('roster', { name: 'p' }, idle), { do: 'roster-pin' });
    assert.deepStrictEqual(actionFor('roster', { name: '/' }, idle), { do: 'roster-filter' });
    assert.deepStrictEqual(actionFor('roster', { name: 'd', shift: true }, idle), { do: 'roster-delete' });
    assert.strictEqual(actionFor('roster', { name: 'd' }, idle), undefined);
  });
  test('composer: Ctrl+X removes the last attachment, only in the composer', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'x', ctrl: true }, idle), { do: 'attach-remove' });
    assert.strictEqual(actionFor('transcript', { name: 'x', ctrl: true }, idle), undefined);
  });
```

- [ ] **Step 2: Run to see failures**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -30`
Expected: the new tests FAIL (rows lack `pinned`, keymap returns undefined).

- [ ] **Step 3: Implement**

Replace `src/tui/view/roster-rows.ts` with:

```ts
import type { SessionId, SessionStatus, SessionSummary } from '../../protocol/messages';

export interface RosterRow {
  id: SessionId; title: string; glyph: '●' | '○' | '!' | '✗';
  suffix?: string; dim: boolean; focused: boolean; pinned: boolean; foreign: boolean;
}

const GLYPH: Record<SessionStatus, RosterRow['glyph']> = {
  running: '●', idle: '○', 'awaiting-approval': '!', error: '✗',
};

export function rosterRows(sessions: SessionSummary[], focusedId: SessionId | null, filter = ''): RosterRow[] {
  const needle = filter.toLowerCase();
  const rows = sessions
    .map((s): RosterRow => ({
      id: s.id,
      title: s.name || s.title,
      glyph: GLYPH[s.status],
      ...(s.owner ? { suffix: `${s.owner.host}·${s.owner.pid}` } : {}),
      dim: s.owner !== undefined,
      focused: s.id === focusedId,
      pinned: s.pinned === true,
      foreign: s.owner !== undefined,
    }))
    .filter((row) => needle === '' || row.title.toLowerCase().includes(needle));
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
}
```

In `src/tui/keymap.ts`:
- Extend the `Action` union: add `| { do: 'roster-pin' } | { do: 'roster-filter' } | { do: 'roster-delete' } | { do: 'attach-remove' }`.
- In `actionFor`, immediately after the `linefeed` line and before `if (key.ctrl) { return undefined; }`, add:

```ts
  if (key.ctrl && key.name === 'x' && zone === 'composer') { return act('attach-remove'); }
```
- In the `case 'roster':` switch add:

```ts
        case 'p': return act('roster-pin');
        case '/': return act('roster-filter');
        case 'd': return key.shift ? act('roster-delete') : undefined;
```

- [ ] **Step 4: Run to see it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15 && yarn check-types:tui`
Expected: PASS. (`Roster` still compiles: the new fields are additive.)

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && git add -A && git commit -m "feat: roster pin and filter view model, delete and attach-remove keys"
```

---

### Task 4: Roster UI: pin, filter, delete confirm

**Files:**
- Modify: `src/tui/ui/roster.tsx`
- Create: `src/tui/ui/delete-confirm.tsx`
- Modify: `src/tui/ui/app.tsx`
- Test: `src/test/tui/roster.test.tsx`, `src/test/tui/app-keys.test.tsx`

**Interfaces:**
- Consumes: `rosterRows(sessions, focusedId, filter)`, `RosterRow.pinned/foreign`, actions `roster-pin | roster-filter | roster-delete` (Task 3).
- Produces: `Roster` props become `{ focused: boolean; onFocusSession(id): void; onAskDelete(row: { id: SessionId; title: string }): void }`. `DeleteConfirm` props `{ id: SessionId; title: string; onDone(): void }`.

Behaviour (spec §4): `p` posts `set-pinned` with the toggled value for the row under the cursor; `/` enters filter mode where printable keys append, Backspace deletes, Esc or Enter leaves (Esc also clears); `x` unchanged; shift+`d` calls `onAskDelete` unless the row is foreign, in which case the notice line says why and nothing opens. `App` shows `DeleteConfirm` below the body; `y` posts `delete-session`, `n` or Esc cancels; every other key consumer is inert while it is open, the same way the new-session dialog makes them inert. The cursor indexes the **filtered** rows.

- [ ] **Step 1: Write the failing roster tests**

Append to `src/test/tui/roster.test.tsx`; also change every existing `<Roster focused onFocusSession={...} />` mount in that file to add `onAskDelete={() => {}}` (the prop becomes required):

```tsx
test('p posts set-pinned for the row under the cursor, toggling an already pinned one off', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('a', { name: 'api-fix' }), summary('b', { name: 'docs', pinned: true })],
    snapshots: [snapshot('a')],
  }));
  // pinned 'docs' sorts first, so the cursor starts on it
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'b', pinned: false });
  await m.press('j');
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'a', pinned: true });
});

test('pinned rows show a star', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('a', { name: 'api-fix', pinned: true })], snapshots: [snapshot('a')] }));
  expect(m.frame()).toContain('★ api-fix');
});

test('/ filters by title; the cursor then addresses the filtered rows; Esc clears', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('/');
  await m.type('docs');
  expect(m.frame()).toContain('/docs');
  expect(m.frame()).not.toContain('api-fix');
  await m.press('return');
  await m.press('return');
  expect(chosen).toEqual(['b']);
  await m.press('/');
  await m.press('escape');
  expect(m.frame()).toContain('api-fix');
});

test('filter mode swallows x and p so typing never closes or pins a session', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('/');
  await m.type('xp');
  expect(m.posted.some((p) => p.t === 'close-session' || p.t === 'set-pinned')).toBe(false);
});

test('shift+d asks to delete the filtered row; a foreign row refuses with a notice', async () => {
  const asked: { id: string; title: string }[] = [];
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={(r) => asked.push(r)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('d', { shift: true });
  expect(asked).toEqual([{ id: 'b', title: 'docs' }]);
});
```

Notice text for the foreign refusal is asserted in the App test below, because the notice line lives in `App`, not in `Roster`.

- [ ] **Step 2: Write the failing App tests**

Append to `src/test/tui/app-keys.test.tsx`:

```tsx
const rosterApp = () => hydrateMsg({
  sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' }), summary('s3', { name: 'theirs', owner: { host: 'vscode', pid: 7 } })],
  snapshots: [snapshot('s1')],
});

test('delete confirm: y deletes the highlighted session, other keys are inert meanwhile', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(rosterApp());
  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('d', { shift: true });
  expect(m.frame()).toContain('Delete "two"? y/n');
  await m.press('j');
  expect(m.posted.some((p) => p.t === 'delete-session')).toBe(false);
  await m.press('y');
  expect(m.posted).toContainEqual({ t: 'delete-session', id: 's2' });
  expect(m.frame()).not.toContain('Delete "two"');
});

test('delete confirm: n and Esc cancel without posting', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(rosterApp());
  await m.press('tab');
  await m.press('tab');
  await m.press('d', { shift: true });
  await m.press('n');
  expect(m.frame()).not.toContain('Delete "one"');
  await m.press('d', { shift: true });
  await m.press('escape');
  await settleEscape();
  expect(m.frame()).not.toContain('Delete "one"');
  expect(m.posted.some((p) => p.t === 'delete-session')).toBe(false);
});

test('delete is refused for a session owned by another host, with a notice', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(rosterApp());
  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('j');
  await m.press('d', { shift: true });
  expect(m.frame()).toContain('owned by vscode');
  expect(m.frame()).not.toContain('Delete "theirs"');
});
```

(`Tab` twice moves composer → transcript → roster in the wide layout; `s1` is the initially focused session, so the zone order starts at the composer.)

- [ ] **Step 3: Run to see failures**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui 2>&1 | tail -40`
Expected: the new roster and App tests FAIL.

- [ ] **Step 4: Implement the roster**

Replace `src/tui/ui/roster.tsx` with:

```tsx
import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { rosterRows } from '../view/roster-rows';
import { useTuiStore } from './store';

interface RosterProps {
  focused: boolean;
  onFocusSession(id: SessionId): void;
  onAskDelete(row: { id: SessionId; title: string }): void;
}

export function Roster({ focused, onFocusSession, onAskDelete }: RosterProps) {
  const { state, focusedId, post, setNotice } = useTuiStore();
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const rows = rosterRows(state.sessions, focusedId, filter);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  useKeyboard((key) => {
    if (!focused) { return; }
    if (filtering) {
      if (key.name === 'escape') { setFilter(''); setFiltering(false); }
      else if (key.name === 'return') { setFiltering(false); }
      else if (key.name === 'backspace') { setFilter((f) => f.slice(0, -1)); }
      else if (key.name === 'space') { setFilter((f) => `${f} `); }
      else if (key.name.length === 1 && !key.ctrl && !key.meta) { setFilter((f) => f + key.name); }
      return;
    }
    const action = actionFor('roster', key, { running: false });
    if (!action) { return; }
    const row = rows[cursor];
    if (action.do === 'roster-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action.do === 'roster-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action.do === 'roster-focus' && row) { onFocusSession(row.id); }
    else if (action.do === 'roster-hide' && row) { post({ t: 'close-session', id: row.id }); }
    else if (action.do === 'roster-pin' && row) { post({ t: 'set-pinned', id: row.id, pinned: !row.pinned }); }
    else if (action.do === 'roster-filter') { setFiltering(true); setCursor(0); }
    else if (action.do === 'roster-delete' && row) {
      if (row.foreign) { setNotice(`Cannot delete "${row.title}": ${row.suffix ? `owned by ${row.suffix.split('·')[0]}` : 'owned by another host'}`); }
      else { onAskDelete({ id: row.id, title: row.title }); }
    }
  });

  return (
    <box flexDirection="column" width={26} border borderStyle="single" title="sessions">
      {filtering || filter !== '' ? <text fg="gray">{`/${filter}`}</text> : null}
      {rows.map((row, i) => (
        <text key={row.id} fg={row.dim ? 'gray' : undefined} attributes={focused && i === cursor ? 1 : 0}>
          {`${row.focused ? '▸' : ' '}${row.glyph} ${row.pinned ? '★ ' : ''}${row.title}${row.suffix ? ` ${row.suffix}` : ''}`}
        </text>
      ))}
      {rows.length === 0 ? <text fg="gray">{filter !== '' ? 'no match' : 'no sessions yet'}</text> : null}
    </box>
  );
}
```

Note the existing "x" test: with filtering false `x` still reaches `roster-hide`.

- [ ] **Step 5: Implement the confirm and wire App**

Create `src/tui/ui/delete-confirm.tsx`:

```tsx
import { useKeyboard } from '@opentui/react';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export function DeleteConfirm({ id, title, onDone }: { id: SessionId; title: string; onDone(): void }) {
  const { post } = useTuiStore();
  useKeyboard((key) => {
    if (key.name === 'y') { post({ t: 'delete-session', id }); onDone(); }
    else if (key.name === 'n' || key.name === 'escape') { onDone(); }
  });
  return <text fg="yellow">{`Delete "${title}"? y/n`}</text>;
}
```

In `src/tui/ui/app.tsx`:
- Import `DeleteConfirm`. Add state: `const [deleting, setDeleting] = useState<{ id: SessionId; title: string } | null>(null);`
- `live` becomes `const live = (z: PaneZone) => !dialog && !deleting && paneZone === z;`
- `useAppKeys({ inert: dialog || deleting !== null, ...` (so the Esc that cancels the confirm cannot also interrupt a running turn).
- `<Roster ... onAskDelete={(row) => { setDeleting(row); }} />` (the one place `Roster` is built).
- Render directly above the `StatusLine` box, after the `dialog ? <NewSessionDialog/>` block:

```tsx
      {deleting ? <DeleteConfirm id={deleting.id} title={deleting.title} onDone={() => { setDeleting(null); }} /> : null}
```

- [ ] **Step 6: Run to see it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui 2>&1 | tail -20 && yarn check-types:tui && yarn lint`
Expected: PASS. If the 'owned by vscode' assertion fails, print `m.frame()` and check the notice text matches the one built in `roster.tsx`.

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A && git commit -m "feat: roster pin, filter and delete confirmation in the TUI"
```

---

### Task 5: `@` mention popup

**Files:**
- Create: `src/tui/ui/mention-popup.tsx`
- Create: `src/tui/ui/use-mention-popup.ts`
- Modify: `src/tui/ui/composer.tsx`
- Test: `src/test/tui/mention-popup.test.tsx`

**Interfaces:**
- Consumes: `mentionQuery`, `filterMentions`, `tokenFor`, `spliceMention`, `pruneMentions`, `PendingMention` (Task 1); `fileMentions`, `fileRefsOf`, `FileMentionPayload` (Task 1); `state.fileSearchBySession[id]` (`{ query, files }`).
- Produces: `useMentionPopup(opts: { sessionId: SessionId; text: string; caret: number }): { open: boolean; rows: MentionOption<FileMentionPayload>[]; index: number; move(delta: number): void; dismiss(): void; pick(): { text: string; caret: number } | undefined; refs(): FileMentionPayload['ref'][]; prune(text: string): void }`. `MentionPopup` props `{ rows: MentionOption<FileMentionPayload>[]; index: number }`.

Behaviour: `mentionQuery(text, caret)` decides openness. When open, a 150 ms-debounced `file-search` is posted with `{ t: 'file-search', id, query }`. Rows come from `fileSearchBySession[id]` **only when its `query` equals the live query** (stale answers are ignored). While open and rows exist, the composer's key handling gives Up, Down, Tab and Enter to the popup (Enter inserts, never sends) and Esc dismisses until the query's `start` changes. On send, refs are pruned against the final text and sent as `fileRefs`.

- [ ] **Step 1: Write the failing tests**

Create `src/test/tui/mention-popup.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { Composer } from '../../tui/ui/composer';
import { snapshot } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const searches = () => m!.posted.filter((p) => p.t === 'file-search');
const sends = () => m!.posted.filter((p) => p.t === 'send');
const files = [
  { path: 'src/app.ts', name: 'app.ts' },
  { path: 'docs/app.md', name: 'app.md' },
];

async function open() {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
}

test('typing @ps debounces one file-search for the live query', async () => {
  await open();
  await m!.type('look at @ap');
  await wait(250);
  expect(searches().length).toBe(1);
  expect(searches()[0]).toEqual({ t: 'file-search', id: 's1', query: 'ap' });
});

test('results for the live query render and Enter inserts the token instead of sending', async () => {
  await open();
  await m!.type('look at @ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  expect(m!.frame()).toContain('src/app.ts');
  await m!.press('return');
  expect(sends().length).toBe(0);
  expect(m!.frame()).toContain('@src/app.ts');
  await m!.press('return');
  expect(sends().length).toBe(1);
  const msg = sends()[0];
  expect(msg.t === 'send' && msg.fileRefs).toEqual([{ path: 'src/app.ts', name: 'app.ts' }]);
});

test('Down then Tab picks the second row', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('down');
  await m!.press('tab');
  expect(m!.frame()).toContain('@docs/app.md');
});

test('a result for an older query is ignored', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.type('p');
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  expect(m!.frame()).not.toContain('src/app.ts');
});

test('Esc dismisses the popup and Enter then sends', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('escape');
  expect(m!.frame()).not.toContain('src/app.ts');
  await m!.press('return');
  expect(sends().length).toBe(1);
});

test('@ inside an email address or mid-word never opens the popup', async () => {
  await open();
  await m!.type('mail me@host.com and a@b');
  await wait(250);
  expect(searches().length).toBe(0);
});

test('a mention whose token was deleted before sending carries no fileRef', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('return');
  for (let i = 0; i < '@src/app.ts'.length; i++) { await m!.press('backspace'); }
  await m!.type('hello');
  await m!.press('return');
  const msg = sends()[0];
  expect(msg.t === 'send' && 'fileRefs' in msg).toBe(false);
});
```

- [ ] **Step 2: Run to see failures**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/mention-popup.test.tsx 2>&1 | tail -30`
Expected: FAIL (no `file-search` posted, no popup).

- [ ] **Step 3: Implement the hook**

Create `src/tui/ui/use-mention-popup.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { fileMentions, type FileMentionPayload } from '../../client-core/mentions/file-mentions';
import {
  mentionQuery, pruneMentions, spliceMention, tokenFor, type MentionOption, type PendingMention,
} from '../../client-core/mentions/mention-menu';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

const SEARCH_DEBOUNCE_MS = 150;

export interface MentionPopup {
  open: boolean;
  rows: MentionOption<FileMentionPayload>[];
  index: number;
  move(delta: number): void;
  dismiss(): void;
  pick(): { text: string; caret: number } | undefined;
  refs(): FileMentionPayload['ref'][];
  prune(text: string): void;
}

export function useMentionPopup(opts: { sessionId: SessionId; text: string; caret: number }): MentionPopup {
  const { state, post } = useTuiStore();
  const hit = mentionQuery(opts.text, opts.caret);
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pending = useRef<PendingMention<FileMentionPayload>[]>([]);

  const query = hit?.query;
  useEffect(() => {
    if (query === undefined) { return; }
    const timer = setTimeout(() => { post({ t: 'file-search', id: opts.sessionId, query }); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [query, opts.sessionId]);
  useEffect(() => { setIndex(0); }, [query]);

  const answer = state.fileSearchBySession[opts.sessionId];
  const rows = hit && answer && answer.query === hit.query ? fileMentions(answer.files) : [];
  const open = hit !== undefined && dismissedAt !== hit.start && rows.length > 0;
  const clamped = Math.min(index, Math.max(0, rows.length - 1));

  return {
    open, rows, index: clamped,
    move: (delta) => { setIndex(Math.max(0, Math.min(rows.length - 1, clamped + delta))); },
    dismiss: () => { if (hit) { setDismissedAt(hit.start); } },
    pick: () => {
      const row = rows[clamped];
      if (!hit || !row) { return undefined; }
      const token = tokenFor(row, pending.current.map((p) => p.token));
      pending.current = [...pending.current, { token, payload: row.payload }];
      return spliceMention(opts.text, hit.start, opts.caret, `${token} `);
    },
    refs: () => pending.current.map((p) => p.payload.ref),
    prune: (text) => { pending.current = pruneMentions(text, pending.current); },
  };
}
```

`refs()` returns what survives the last `prune`; the composer calls `popup.prune(finalText)` first, then `popup.refs()`.

- [ ] **Step 4: Implement the popup view**

Create `src/tui/ui/mention-popup.tsx`:

```tsx
import type { FileMentionPayload } from '../../client-core/mentions/file-mentions';
import type { MentionOption } from '../../client-core/mentions/mention-menu';

const MAX_ROWS = 8;

export function MentionPopup({ rows, index }: { rows: MentionOption<FileMentionPayload>[]; index: number }) {
  const start = Math.max(0, Math.min(index - MAX_ROWS + 1, rows.length - MAX_ROWS));
  return (
    <box flexDirection="column" border borderStyle="single" flexShrink={0}>
      {rows.slice(start, start + MAX_ROWS).map((row, i) => (
        <text key={row.id} attributes={start + i === index ? 1 : 0}>
          {`${start + i === index ? '›' : ' '} ${row.baseToken}`}
        </text>
      ))}
    </box>
  );
}
```

- [ ] **Step 5: Wire into the composer**

In `src/tui/ui/composer.tsx`:

1. Add imports: `import { MentionPopup } from './mention-popup';` and `import { useMentionPopup } from './use-mention-popup';`, plus `useState` to the react import.
2. Add state and the popup near the other hooks:

```tsx
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const popup = useMentionPopup({ sessionId, text, caret });
```
3. In `onContentChange`, after reading `text`:
`setText(text); setCaret(box.current?.cursorOffset ?? text.length);`
Rename the local `text` const there to `value` to avoid shadowing, and use `value` for the existing `drafts.set`/`pending.current` lines.
4. In `setBox` (programmatic text), also `setText(text); setCaret(text.length);` so the popup state follows draft restores and history walks.
5. In `submit`, before posting, read the final text and prune:

```tsx
    popup.prune(value);
    const fileRefs = popup.refs();
    post({ t: 'send', id: sessionId, text: value, ...(fileRefs.length > 0 ? { fileRefs } : {}) });
```
6. Pick/intercept. Before the existing `useKeyboard` body's history logic, add an early branch at the top of the callback (after the `if (!focused) { return; }`):

```tsx
    if (popup.open) {
      if (key.name === 'escape') { popup.dismiss(); key.preventDefault(); return; }
      if (key.name === 'down') { popup.move(1); key.preventDefault(); return; }
      if (key.name === 'up') { popup.move(-1); key.preventDefault(); return; }
      if (key.name === 'tab' || key.name === 'return') {
        const next = popup.pick();
        if (next) { setBox(next.text); key.preventDefault(); }
        return;
      }
    }
```
7. Enter would still reach the textarea's own `submit` binding. To stop that, the textarea's `onSubmit` must be a no-op while the popup is open: change `onSubmit={submit}` to `onSubmit={() => { if (!popup.open) { submit(); } }}`. (The key handler above already consumed the Enter for picking; if the ordering of the two handlers makes the textarea fire first, `popup.open` is still true at that instant, so the guard holds either way. If the test "Enter inserts the token instead of sending" shows a send, switch the pick to run from `onSubmit` itself when `popup.open`.)
7b. Render the popup above the queued lines inside the outer `<box>`:

```tsx
      {popup.open ? <MentionPopup rows={popup.rows} index={popup.index} /> : null}
```

8. Tab would also reach `useAppKeys` in `App` and cycle the zone. Expose the popup state through the store: add `mentionOpen: boolean; setMentionOpen(open: boolean): void` to `TuiStoreValue` in `src/tui/ui/store.tsx` (a `useState(false)` in the provider, included in the memo), call `setMentionOpen(popup.open)` from a `useEffect([popup.open])` in the composer, and in `use-app-keys.ts` return early from the keyboard callback when `key.name === 'tab' && mentionOpen`.

- [ ] **Step 6: Run to see it pass**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/mention-popup.test.tsx 2>&1 | tail -30`
Expected: PASS. Then the full TUI suite, to catch the composer and Tab changes: `yarn test:tui 2>&1 | tail -15`.

- [ ] **Step 7: Add an App-level Tab guard test**

Append to `src/test/tui/app-keys.test.tsx`:

```tsx
test('Tab with the @ popup open picks the row and does not cycle the zone', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.type('@ap');
  await wait(250);
  await m.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files: [{ path: 'src/app.ts', name: 'app.ts' }] });
  await m.press('tab');
  expect(m.frame()).toContain('@src/app.ts');
  await m.type('x');
  expect(m.frame()).toContain('@src/app.ts x');
});
```

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui 2>&1 | tail -15` (Expected: PASS; if typing `x` did not land in the composer, the zone cycled: fix the `mentionOpen` guard.)

- [ ] **Step 8: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types:tui && yarn test:unit \
  && git add -A && git commit -m "feat: inline @ file mention popup in the TUI composer"
```

---

### Task 6: Path-paste and `/attach` attachments with chips

**Files:**
- Create: `src/tui/ui/attachment-chips.tsx`
- Modify: `src/tui/ui/composer.tsx`
- Test: `src/test/tui/attachments.test.tsx`

**Interfaces:**
- Consumes: `parsePastedPaths`, `parseAttachCommand` (Task 2), `existingFileUris` (Task 2), `state.byId[id].attachments` (`Attachment[]`), `state.rejectionBySession[id]` (`string[] | undefined`), action `attach-remove` (Task 3).
- Produces: `AttachmentChips` props `{ attachments: Attachment[]; rejected: string[] }`.

Behaviour: a paste whose text parses to paths that all exist as regular files posts `{ t: 'attach-drop', id, uris }` and is swallowed; any other paste inserts as text unchanged. Submitting text that is exactly the `/attach` command posts `attach-drop` for existing files, clears the box, and otherwise sets the notice `attach: path not found or not an absolute file path` and keeps the text. `Ctrl+X` with chips present posts `attach-remove` for the last chip's id. Chips render one per line above the box as `name (size)`; rejection reasons render in yellow under them and clear on the next `session-attachments` (reducer behaviour already exists).

- [ ] **Step 1: Verify the paste hook before building on it**

Run a throwaway probe in the OS temp dir, not in the repo. Create `%TEMP%/paste-probe.test.tsx` that imports the harness by absolute path, mounts `<Composer sessionId="s1" focused />`, and calls `await m.setup.mockInput.pasteBracketedText('/some/path')` inside `act`. Goal: find out whether the focused `<textarea>` accepts an `onPaste` prop whose `event.preventDefault()` stops the insertion. Run it with `bun test` from the repo root using the absolute path. Delete the file immediately afterwards.

Record the result in the commit message of Step 5. If `onPaste` on the textarea does not fire or cannot prevent insertion, fall back to: `onPaste` omitted, and in `onContentChange` detect a content jump (length grew by more than 1 in one change, after at least one path-shaped token) and treat the whole box text via the same path logic. `/attach` is unaffected.

- [ ] **Step 2: Write the failing tests**

Create `src/test/tui/attachments.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { Composer } from '../../tui/ui/composer';
import { snapshot } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'marcode-attach-')); });
afterEach(() => { m?.destroy(); m = undefined; rmSync(dir, { recursive: true, force: true }); });

const drops = () => m!.posted.filter((p) => p.t === 'attach-drop');
const sends = () => m!.posted.filter((p) => p.t === 'send');
const paste = (text: string) => act(async () => { await m!.setup.mockInput.pasteBracketedText(text); });
const file = (name: string) => { const p = join(dir, name); writeFileSync(p, 'x'); return p; };
const attachment = { id: 'a1', path: '/x/shot.png', name: 'shot.png', kind: 'image' as const, bytes: 2048 };

async function open() {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
}

test('pasting an existing file path attaches it and inserts no text', async () => {
  await open();
  const p = file('a b.txt');
  await paste(`"${p}"\n`);
  expect(drops()).toEqual([{ t: 'attach-drop', id: 's1', uris: [pathToFileURL(p).href] }]);
  await m!.press('return');
  expect(sends().length).toBe(0);
});

test('pasting prose, a missing path or a directory inserts as text and attaches nothing', async () => {
  await open();
  await paste(`see ${file('c.txt')} please`);
  await paste(join(dir, 'missing.txt'));
  await paste(dir);
  expect(drops().length).toBe(0);
  expect(m!.frame()).toContain('please');
});

test('/attach <path> attaches and clears the box; a bad path keeps the text and says why', async () => {
  m = await mount(<App launchCwd="/repo" forceNew={false} loginCommands={{}} onQuit={() => {}} />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
  const p = file('d.txt');
  await m.type(`/attach ${p}`);
  await m.press('return');
  expect(drops().length).toBe(1);
  expect(sends().length).toBe(0);
  await m.type('/attach nope.txt');
  await m.press('return');
  expect(drops().length).toBe(1);
  expect(m.frame()).toContain('attach: path not found');
  expect(m.frame()).toContain('/attach nope.txt');
});

test('chips list name and size; Ctrl+X removes the last one', async () => {
  await open();
  await m!.fromHost({ t: 'session-attachments', id: 's1', attachments: [attachment, { ...attachment, id: 'a2', name: 'log.txt', kind: 'file', bytes: 10 }] });
  expect(m!.frame()).toContain('shot.png');
  expect(m!.frame()).toContain('log.txt');
  await m!.press('x', { ctrl: true });
  expect(m!.posted).toContainEqual({ t: 'attach-remove', id: 's1', attachmentId: 'a2' });
});

test('Ctrl+X with no chips posts nothing', async () => {
  await open();
  await m!.press('x', { ctrl: true });
  expect(m!.posted.some((p) => p.t === 'attach-remove')).toBe(false);
});

test('rejection reasons render under the chips and clear on the next attachments update', async () => {
  await open();
  await m!.fromHost({ t: 'attachments-rejected', id: 's1', reasons: ['A turn can carry up to 10 attachments.'] });
  expect(m!.frame()).toContain('up to 10 attachments');
  await m!.fromHost({ t: 'session-attachments', id: 's1', attachments: [] });
  expect(m!.frame()).not.toContain('up to 10 attachments');
});
```

- [ ] **Step 3: Run to see failures**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/attachments.test.tsx 2>&1 | tail -30`
Expected: FAIL.

- [ ] **Step 4: Implement chips**

Create `src/tui/ui/attachment-chips.tsx`:

```tsx
import type { Attachment } from '../../protocol/messages';

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChips({ attachments, rejected }: { attachments: Attachment[]; rejected: string[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {attachments.map((a) => <text key={a.id} fg="cyan">{`📎 ${a.name} (${size(a.bytes)})`}</text>)}
      {rejected.map((r) => <text key={r} fg="yellow">{r}</text>)}
    </box>
  );
}
```

- [ ] **Step 5: Wire into the composer**

In `src/tui/ui/composer.tsx`:

1. Imports: `parseAttachCommand, parsePastedPaths` from `../../client-core/path-paste`; `existingFileUris` from `../attach-paths`; `AttachmentChips` from `./attachment-chips`; `setNotice` from the store.
2. Read `const attachments = pane?.attachments ?? [];` and `const rejected = state.rejectionBySession[sessionId] ?? [];` (add `setNotice` to the `useTuiStore()` destructure).
3. Add helper:

```tsx
  const attach = (paths: string[]): boolean => {
    const uris = existingFileUris(paths);
    if (!uris) { return false; }
    post({ t: 'attach-drop', id: sessionId, uris });
    return true;
  };
```
4. In `submit`, before the `send` post:

```tsx
    const command = parseAttachCommand(value);
    if (command !== undefined) {
      if (!attach(command)) { setNotice('attach: path not found or not an absolute file path'); return; }
      setBox('');
      drafts.set(sessionId, '');
      pending.current = '';
      flush();
      return;
    }
```
5. On the textarea add `onPaste={(event) => { const paths = parsePastedPaths(new TextDecoder().decode(event.bytes)); if (paths.length > 0 && attach(paths)) { event.preventDefault(); } }}`.
6. In the `useKeyboard` callback (after the popup branch from Task 5, before the history branch) add:

```tsx
    if (actionFor('composer', key, { running })?.do === 'attach-remove') {
      const last = attachments.at(-1);
      if (last) { post({ t: 'attach-remove', id: sessionId, attachmentId: last.id }); }
      return;
    }
```
7. Render `<AttachmentChips attachments={attachments} rejected={rejected} />` inside the outer `<box>`, directly above the textarea's bordered box and below the popup.

If Step 1 found `onPaste` unusable, replace item 5 with the content-jump fallback described there and keep the same two tests (the first test's expectations are unchanged).

- [ ] **Step 6: Run to see it pass, then everything**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui 2>&1 | tail -20 && yarn test:unit 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui \
  && git add -A && git commit -m "feat: attach files by pasted path or /attach in the TUI composer"
```

---

### Task 7: Docs and final gates

**Files:**
- Modify: `docs/tui.md` (keymap table around line 30-46, limits list around line 66, smoke checklist from line 72)
- Modify: `AGENTS.md` only if it lists TUI files that this plan added (check with `grep -n "src/tui" AGENTS.md`; add one row each for `src/client-core/mentions/` and `src/client-core/path-paste.ts` if the table there is per-file)

- [ ] **Step 1: Update the keymap table**

In `docs/tui.md`, replace the roster row and add the new ones:

```
| j / k, Enter, x | roster | move, focus, hide the session from the panes |
| p | roster | pin or unpin the session (pinned sort first, shown with ★) |
| / | roster | filter by title; Enter keeps the filter, Esc clears it |
| Shift+D, then y / n | roster | delete the session after confirming; refused for a session owned by another host |
| @ then Up/Down, Tab or Enter, Esc | composer | file mention popup: pick inserts `@path` and attaches its content on send |
| Ctrl+X | composer | remove the last attachment |
```

- [ ] **Step 2: Document attachments and the limits**

Add a short "Attachments" paragraph under the keymap: pasting an absolute file path (what most terminals deliver on a file drop) or sending `/attach <absolute path>` attaches the file; pasted text that is anything else inserts normally; there is no clipboard-image read. In the limits list, change the roster line to: `- Roster rename, the empty-state prompt picker and clipboard-image attach are not implemented.`

- [ ] **Step 3: Extend the manual smoke checklist**

Add under the checklist:

```
- [ ] Type `@` plus a few letters: the popup lists files, Down/Tab picks one, the sent message includes the file's content.
- [ ] Drag a file from the file manager onto the terminal window: a chip appears (Windows Terminal, and one macOS or Linux terminal). If nothing happens, note the terminal; `/attach` must still work.
- [ ] `/attach` a missing path: the notice explains it and the text stays.
- [ ] Roster: `p` pins, `/` filters, Shift+D confirms before deleting, and a session owned by VS Code refuses.
- [ ] Open the new-session dialog in a very short terminal: the provider rows stay visible.
```

- [ ] **Step 4: Run every gate**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui && yarn run compile && yarn test:unit && yarn test:dom && yarn test:tui
```
Expected: all pass. Fix anything red before committing; do not skip a gate.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A && git commit -m "docs: TUI composer and roster keys, attachments and smoke checklist"
```
