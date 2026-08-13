# Webview DOM Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a jsdom-backed DOM test suite that mounts real React components under the real `StoreProvider` and asserts render + interaction behavior no pure-function test can reach.

**Architecture:** Stay on mocha. A `tsx/cjs` require-hook compiles `.tsx` and resolves the `@/*` tsconfig path at runtime; `global-jsdom/register` supplies the DOM. Tests drive components by dispatching genuine `HostToWebview` messages at `window` and assert against messages captured by a stubbed `acquireVsCodeApi`. Node-side tests get their own script so jsdom never leaks into them.

**Tech Stack:** mocha (`--ui tdd`), `tsx`, `jsdom`, `global-jsdom`, `@testing-library/react`, `@testing-library/user-event`, `node:assert`, React 19.

**Spec:** [docs/superpowers/specs/2026-08-13-webview-dom-testing-design.md](../specs/2026-08-13-webview-dom-testing-design.md)

## Global Constraints

- Assertions use `node:assert` (`import * as assert from 'assert'`). There is no `expect` and no `jest-dom`. Never introduce one.
- Test style is mocha TDD: `suite(...)` / `test(...)`. Never `describe` / `it`.
- Filenames are kebab-case, including `.tsx`.
- Nothing under `src/providers/` or `src/protocol/` may import `vscode`. Test files must not either.
- `src/protocol/messages.ts` stays types-only.
- Compose classNames with `cn` from `@/lib/utils` — never template literals.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before every commit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- Commit messages carry no `Co-Authored-By` trailer.
- Node 22, VS Code `^1.125.0`.
- Package manager is **yarn 4** (`yarn add -D`, not npm).

## Wire-format facts the tests depend on

Copied verbatim from `src/protocol/messages.ts` and `src/providers/types.ts`, because getting these wrong is the most likely way to write a test that passes against a fiction:

```ts
type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypass';
type ToolDecision = { allow: true; updatedInput?: unknown } | { allow: false; reason?: string };

// The permission answer is `permission-decision`, NOT `permission-response`:
{ t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
```

---

### Task 1: Tooling — make mocha run a `.tsx` test under jsdom

Proves the load-bearing assumption before any real test is written: that `tsx/cjs` resolves the `@/*` tsconfig path at runtime. If this task fails, stop and read the Fallback note at its end.

**Files:**
- Modify: `package.json` (devDependencies, `scripts`)
- Modify: `tsconfig.json` (nothing to change if `check-types` already covers `src/**`; verify)
- Modify: `eslint.config.mjs`
- Create: `src/test/dom/setup.ts`
- Test: `src/test/dom/smoke.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the `yarn test:dom` script; `src/test/dom/setup.ts` as a mocha `--require` target exporting `mochaHooks`.

- [ ] **Step 1: Install the dependencies**

```bash
yarn add -D tsx jsdom global-jsdom @testing-library/react @testing-library/user-event @types/jsdom
```

- [ ] **Step 2: Rewrite the test scripts in `package.json`**

Replace the existing `test:unit` line and add `test:dom`. `test:unit` gains `--require tsx/cjs` because it now runs `.ts` sources directly instead of the compiled output in `out/` — mocha cannot load TypeScript without a hook.

```json
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "yarn run compile-tests && yarn run compile && yarn run lint",
    "check-types": "tsc --noEmit",
    "lint": "eslint src",
    "test": "yarn run pretest && vscode-test",
    "test:unit": "mocha --ui tdd --require tsx/cjs \"src/test/unit/**/*.test.ts\"",
    "test:dom": "mocha --ui tdd --require tsx/cjs --require global-jsdom/register --require src/test/dom/setup.ts \"src/test/dom/**/*.test.tsx\"",
```

Leave `compile-tests`, `pretest` and `test` exactly as they are: `.vscode-test.mjs` runs `out/test/integration/**/*.test.js`, so the integration suite still needs `tsc --outDir out`.

- [ ] **Step 3: Verify the node-side suite still passes on the new script**

Run: `yarn test:unit`
Expected: all 12 existing unit suites PASS, with no compile step in the output. If a test fails on a missing type or an import, that is a real regression from dropping `tsc` — fix it before continuing.

- [ ] **Step 4: Commit the runner change on its own**

```bash
git add package.json yarn.lock
git commit -m "chore: run unit tests directly from source via tsx"
```

- [ ] **Step 5: Write `src/test/dom/setup.ts`**

`IS_REACT_ACT_ENVIRONMENT` is set at module scope so it is true before React is ever imported. Cleanup goes through mocha's Root Hook Plugin (`export const mochaHooks`) rather than a bare `teardown()` call: root hook plugins use `afterEach` naming regardless of the UI, and under `--ui tdd` there is no global `afterEach` for React Testing Library's automatic cleanup to attach to — so without this, the DOM leaks between tests.

The polyfills are not optional. jsdom implements none of them, and `react-resizable-panels`, Base UI and `@shadcn/react/message-scroller` all reach for them on mount.

```ts
import { cleanup } from '@testing-library/react';
import { resetHost } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}

globalThis.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;

globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;

Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
Element.prototype.scrollTo ??= function scrollTo(): void {};
// Base UI hit-tests pointer interactions; jsdom returns undefined and the
// menu silently refuses to open.
document.elementFromPoint ??= () => document.body;

export const mochaHooks = {
  afterEach(): void {
    cleanup();
    resetHost();
  },
};
```

This file imports `./harness`, which Task 2 creates. To keep Task 1 self-contained, create a placeholder harness now with only the export this file needs — Task 2 fills it in.

- [ ] **Step 6: Create the placeholder `src/test/dom/harness.tsx`**

```tsx
export function resetHost(): void {}
```

- [ ] **Step 7: Write the failing smoke test**

The point of this test is not the assertion — it is that the file loads at all. It imports through the `@` alias, uses JSX, and renders into a jsdom document. If `tsx/cjs` does not resolve `paths`, this fails at import time.

Create `src/test/dom/smoke.test.tsx`:

```tsx
import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { cn } from '@/lib/utils';

suite('dom harness smoke', () => {
  test('renders JSX into jsdom', () => {
    render(<div data-testid="probe" className={cn('p-2', 'p-4')}>hello</div>);
    assert.strictEqual(screen.getByTestId('probe').textContent, 'hello');
  });

  test('the @ alias resolves at runtime', () => {
    // cn is twMerge(clsx(...)) — the later padding wins.
    assert.strictEqual(cn('p-2', 'p-4'), 'p-4');
  });
});
```

- [ ] **Step 8: Run it**

Run: `yarn test:dom`
Expected: both tests PASS.

**Fallback if it fails with a module-resolution error on `@/lib/utils`:** `tsx/cjs` is not honouring tsconfig `paths`. Do not work around it per-file. Instead create `src/test/dom/alias-hook.cjs` registering a `require` hook that rewrites a leading `@/` to `<repo>/src/webview/`, and add `--require ./src/test/dom/alias-hook.cjs` to `test:dom` ahead of `tsx/cjs`. The rest of this plan is unaffected.

- [ ] **Step 9: Teach eslint about the DOM test files**

Open `eslint.config.mjs` and confirm `src/test/dom/**/*.tsx` is matched by an existing block's `files` glob with the TypeScript parser. If the config only globs `**/*.ts`, widen it to `**/*.{ts,tsx}`.

- [ ] **Step 10: Verify the full gate**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all PASS. `check-types` covers the new files because `tsconfig.json` has `rootDir: "src"` and no `include` narrowing.

- [ ] **Step 11: Commit**

```bash
git add package.json yarn.lock eslint.config.mjs src/test/dom/setup.ts src/test/dom/harness.tsx src/test/dom/smoke.test.tsx
git commit -m "test: add jsdom DOM test harness scaffolding"
```

---

### Task 2: The harness and shared fixtures

**Files:**
- Modify: `src/test/dom/harness.tsx` (replace the placeholder)
- Create: `src/webview/app.tsx`
- Modify: `src/webview/main.tsx`
- Create: `src/test/fixtures/protocol.ts`
- Modify: `src/test/unit/webview-reducer.test.ts` (drop its local `summary()` in favour of the fixture)
- Test: `src/test/dom/harness.test.tsx`

**Interfaces:**
- Consumes: `resetHost` from Task 1's placeholder (now real).
- Produces, from `src/test/dom/harness.tsx`:
  - `posted(): WebviewToHost[]`
  - `resetHost(): void`
  - `sendFromHost(...msgs: HostToWebview[]): void`
  - `renderApp(): RenderResult`
  - `renderWithStore(ui: ReactNode): RenderResult`
- Produces, from `src/test/fixtures/protocol.ts`:
  - `summary(id: string, over?: Partial<SessionSummary>): SessionSummary`
  - `snapshot(id: string, over?: Partial<SessionSnapshot>): SessionSnapshot`
  - `layoutOf(...ids: string[]): PaneLayout`
  - `catalog(): ProviderInfo[]`
  - `permission(over?: Partial<PermissionItem>): PermissionItem`
- Produces, from `src/webview/app.tsx`: `App` (named export, no default).

- [ ] **Step 1: Write the fixtures**

Create `src/test/fixtures/protocol.ts`. The `catalog()` provider id is `'fake'` and model `'fake-large'` carries effort levels, matching what `summary()` defaults to — several tests depend on `PaneGroup` resolving `providerId`/`model` through the catalog to find `ModelInfo`.

```ts
import type {
  PaneLayout, ProviderInfo, SessionSnapshot, SessionSummary, TranscriptItem,
} from '../../protocol/messages';

export type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

export function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    providerId: 'fake',
    model: 'fake-large',
    title: `Session ${id}`,
    cwd: '/tmp',
    status: 'idle',
    permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function snapshot(id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...summary(id), items: [], hasMore: false, pending: [], ...over };
}

export function layoutOf(...ids: string[]): PaneLayout {
  return {
    orientation: 'vertical',
    panes: ids.map((sessionId) => ({ sessionId, size: 100 / ids.length })),
  };
}

export function catalog(): ProviderInfo[] {
  return [{
    id: 'fake',
    displayName: 'Fake',
    models: [
      {
        id: 'fake-large',
        displayName: 'Fake Large',
        effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
      },
      { id: 'fake-small', displayName: 'Fake Small' },
    ],
  }];
}

export function permission(over: Partial<PermissionItem> = {}): PermissionItem {
  return {
    id: 'i1',
    ts: 1,
    role: 'permission',
    requestId: 'r1',
    name: 'Write',
    input: { file_path: '/tmp/a.txt', content: 'hi' },
    state: 'pending',
    ...over,
  };
}
```

- [ ] **Step 2: Point the existing reducer test at the fixture**

In `src/test/unit/webview-reducer.test.ts`, delete the local `function summary(id: string)` and import it instead:

```ts
import { summary } from '../fixtures/protocol';
```

The fixture's `title` is `` `Session ${id}` `` where the local one was `'T'`. If any assertion in that file depends on the title string, pass it explicitly: `summary('a', { title: 'T' })`.

- [ ] **Step 3: Run the unit suite**

Run: `yarn test:unit`
Expected: PASS. A failure here means an assertion depended on the old `'T'` title — fix it per Step 2.

- [ ] **Step 4: Extract `App` out of `main.tsx`**

`main.tsx` currently defines `App` *and* calls `createRoot(...).render(...)` at module scope, so importing it from a test mounts a second root against a `#root` that does not exist. Move the component verbatim — every `useEffect`, every doc comment, unchanged — into a new `src/webview/app.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { PaneGroup } from './components/pane-group';
import { SessionPicker } from './components/session-picker';
import { reconcilePaneLayout, rosterSessionIds } from './components/pane-layout';
import { useStore } from './store';

export function App() {
  // ... body moved verbatim from main.tsx, including all comments ...
}
```

Then reduce `src/webview/main.tsx` to exactly:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { StoreProvider } from './store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}
```

- [ ] **Step 5: Verify the bundle still builds**

Run: `yarn check-types && yarn run compile`
Expected: PASS, `dist/webview.js` rebuilt.

- [ ] **Step 6: Write the real harness**

Replace `src/test/dom/harness.tsx` entirely.

```tsx
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { App } from '@/app';
import { StoreProvider } from '@/store';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

const sent: WebviewToHost[] = [];

// vscode-api.ts calls acquireVsCodeApi() at module load, so this stub must be
// installed before that module is ever imported. mocha loads every --require
// file before any spec, and setup.ts imports this one, which guarantees it.
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { sent.push(msg as WebviewToHost); },
  getState() { return undefined; },
  setState() {},
});

/**
 * Everything the webview has posted, oldest first.
 *
 * `ready` is NOT reliably `[0]`. React flushes child effects before parent
 * ones, so under `renderApp` every effect in `App` — including the one that
 * posts `set-visible` — runs before `StoreProvider` posts `ready`. Filter by
 * `t` rather than indexing. Under `renderWithStore` with an effect-free
 * component, `ready` is the only message on mount.
 */
export function posted(): WebviewToHost[] {
  return sent;
}

export function resetHost(): void {
  sent.length = 0;
}

/**
 * Delivers host messages synchronously.
 *
 * Deliberately `dispatchEvent` rather than `window.postMessage`: jsdom queues
 * postMessage asynchronously, which makes every assertion after it racy.
 * `onHostMessage` listens for a `message` event and cannot tell the difference.
 */
export function sendFromHost(...msgs: HostToWebview[]): void {
  act(() => {
    for (const data of msgs) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
  });
}

export function renderApp(): RenderResult {
  return render(<StoreProvider><App /></StoreProvider>);
}

export function renderWithStore(ui: ReactNode): RenderResult {
  return render(<StoreProvider>{ui}</StoreProvider>);
}
```

- [ ] **Step 7: Write the failing harness test**

Create `src/test/dom/harness.test.tsx`:

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

suite('harness', () => {
  test('mounting posts the ready handshake exactly once', () => {
    renderApp();
    assert.deepStrictEqual(posted().filter((m) => m.t === 'ready'), [{ t: 'ready' }]);
  });

  test('resetHost clears captured messages between tests', () => {
    renderApp();
    // Were the afterEach root hook not firing, the previous test's messages
    // would still be here and this count would keep growing.
    assert.strictEqual(posted().filter((m) => m.t === 'ready').length, 1);
  });

  test('sendFromHost delivers a message synchronously', () => {
    renderApp();
    assert.strictEqual(screen.getByText('Loading…').textContent, 'Loading…');

    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [snapshot('a')],
      catalog: catalog(),
    });

    // No await: the assertion runs on the same tick as the dispatch.
    assert.strictEqual(screen.queryByText('Loading…'), null);
  });
});
```

- [ ] **Step 8: Run it**

Run: `yarn test:dom`
Expected: PASS. If the third test still finds `Loading…`, `sendFromHost` is not wrapped in `act()` or is using `postMessage`.

- [ ] **Step 9: Commit**

```bash
git add src/test/dom/harness.tsx src/test/dom/harness.test.tsx src/test/fixtures/protocol.ts src/test/unit/webview-reducer.test.ts src/webview/app.tsx src/webview/main.tsx
git commit -m "test: add store-driven DOM harness and shared protocol fixtures"
```

---

### Task 3: `PermissionCard`

The richest branching in the webview, and the reason this suite exists. Three of these five behaviors are invisible to any pure-function test.

**Files:**
- Test: `src/test/dom/permission-card.test.tsx`
- Read for context: `src/webview/components/permission-card.tsx`

**Interfaces:**
- Consumes: `posted`, `renderWithStore`, `sendFromHost` from `./harness`; `catalog`, `layoutOf`, `permission`, `snapshot`, `summary` from `../fixtures/protocol`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

`PermissionCard` reads `state.byId[sessionId].pending` through `useStore`, so each test hydrates first, then renders the card. `renderWithStore` mounts a fresh `StoreProvider`, so hydrate must be sent *after* render — the provider only attaches its `message` listener on mount.

Note the wire shape: `permission-decision`, and `decision` is a `ToolDecision` object, not a boolean.

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionCard } from '@/components/permission-card';
import { catalog, layoutOf, permission, snapshot, summary } from '../fixtures/protocol';
import { posted, renderWithStore, sendFromHost } from './harness';

function hydrateWith(pending: { requestId: string; name: string; input: unknown }[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { pending })],
    catalog: catalog(),
  });
}

const LIVE = [{ requestId: 'r1', name: 'Write', input: { file_path: '/tmp/a.txt' } }];

suite('PermissionCard', () => {
  test('a live pending request renders enabled Allow and Deny', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    assert.strictEqual(screen.getByText('Allow Write?').textContent, 'Allow Write?');
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, false);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, false);
  });

  test('clicking Allow posts permission-decision with allow true', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Allow Write'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision',
      id: 'a',
      requestId: 'r1',
      decision: { allow: true },
    });
  });

  test('clicking Deny posts a denial carrying the reason', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Deny Write'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision',
      id: 'a',
      requestId: 'r1',
      decision: { allow: false, reason: 'Denied by user' },
    });
  });

  test('answering disables both buttons with no host round-trip', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Allow Write'));
    const after = posted().length;

    // Nothing was sent back from the host: state.byId still lists r1 as pending.
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, true);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, true);

    await userEvent.click(screen.getByLabelText('Allow Write'));
    assert.strictEqual(posted().length, after, 'a second click must post nothing');
  });

  test('a pending item the host no longer holds renders as stale', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Write — no longer awaiting a response');
    assert.strictEqual(
      (screen.getByLabelText('Allow Write (unavailable)') as HTMLButtonElement).disabled, true,
    );
    assert.strictEqual(
      (screen.getByLabelText('Deny Write (unavailable)') as HTMLButtonElement).disabled, true,
    );
  });

  test('a resolved item renders as a one-line summary with no buttons', () => {
    const item = permission({ state: 'denied', reason: 'nope' });
    renderWithStore(<PermissionCard item={item} sessionId="a" />);
    hydrateWith(LIVE);

    screen.getByText('Write — denied: nope');
    assert.strictEqual(screen.queryByLabelText('Allow Write'), null);
  });

  test('an edit-shaped input renders a diff preview', () => {
    const item = permission({
      name: 'Edit',
      input: { file_path: '/tmp/a.txt', old_string: 'one', new_string: 'two' },
    });
    renderWithStore(<PermissionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', name: 'Edit', input: item.input }]);

    const pre = document.querySelector('pre');
    assert.notStrictEqual(pre, null);
    assert.strictEqual(pre!.textContent, '--- /tmp/a.txt\n- one\n+ two');
  });
});
```

- [ ] **Step 2: Run to see them pass or fail**

Run: `yarn test:dom`
Expected: all PASS — `PermissionCard` already implements this behavior; these tests pin it. **If any fails, that is a real bug in the component or a mistake in the expected text.** Read the component before changing either. Do not edit `permission-card.tsx` to satisfy a test without first confirming the current behavior is wrong.

Two texts are easy to get wrong and worth checking against the source rather than guessing: the resolved-state line is built as `` `${item.name} — ${item.state}` `` plus `: ${item.reason}`, and the stale heading is `` `${item.name} — no longer awaiting a response` ``.

- [ ] **Step 3: Commit**

```bash
git add src/test/dom/permission-card.test.tsx
git commit -m "test: cover PermissionCard render and decision behavior at the DOM level"
```

---

### Task 4: `Composer`

**Files:**
- Test: `src/test/dom/composer.test.tsx`
- Read for context: `src/webview/components/composer.tsx`

**Interfaces:**
- Consumes: `posted`, `renderWithStore` from `./harness`; `catalog`, `summary` from `../fixtures/protocol`.
- Produces: nothing consumed by later tasks.

`Composer` takes `pane: PaneState` and `model: ModelInfo | undefined` as props and only pulls `post` from the store, so these tests need no `hydrate` at all.

- [ ] **Step 1: Write the failing tests**

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import type { SessionStatus } from '../../protocol/messages';
import { catalog, summary } from '../fixtures/protocol';
import { posted, renderWithStore } from './harness';

function pane(status: SessionStatus = 'idle'): PaneState {
  return { summary: summary('a', { status }), items: [], hasMore: false, pending: [] };
}

const WITH_EFFORT = catalog()[0].models[0];   // fake-large, effort low/medium/high
const NO_EFFORT = catalog()[0].models[1];     // fake-small

suite('Composer', () => {
  test('Enter posts send and clears the textarea', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, 'hello{Enter}');

    assert.deepStrictEqual(posted().at(-1), { t: 'send', id: 'a', text: 'hello' });
    assert.strictEqual(box.value, '');
  });

  test('Shift+Enter inserts a newline and posts nothing', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, 'one{Shift>}{Enter}{/Shift}two');

    assert.deepStrictEqual(posted().at(-1), { t: 'ready' });
    assert.strictEqual(box.value, 'one\ntwo');
  });

  test('whitespace-only input leaves Send disabled and posts nothing', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '   ');

    assert.strictEqual((screen.getByText('Send') as HTMLButtonElement).disabled, true);
    await userEvent.type(box, '{Enter}');
    assert.deepStrictEqual(posted().at(-1), { t: 'ready' });
  });

  test('a running session shows Stop, and clicking it posts interrupt', async () => {
    renderWithStore(<Composer pane={pane('running')} model={NO_EFFORT} />);

    assert.strictEqual(screen.queryByText('Send'), null);
    await userEvent.click(screen.getByText('Stop'));

    assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
  });

  test('awaiting-approval also shows Stop', () => {
    renderWithStore(<Composer pane={pane('awaiting-approval')} model={NO_EFFORT} />);
    screen.getByText('Stop');
  });

  test('a model without effort renders no Effort control', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    assert.strictEqual(screen.queryByLabelText('Effort'), null);
  });

  test('choosing an effort level posts set-effort', async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} />);

    await userEvent.click(screen.getByLabelText('Effort'));
    await userEvent.click(await screen.findByRole('option', { name: 'high' }));

    assert.deepStrictEqual(posted().at(-1), { t: 'set-effort', id: 'a', effort: 'high' });
  });
});
```

- [ ] **Step 2: Run them**

Run: `yarn test:dom`
Expected: all PASS.

The effort-select test is the one that exercises Base UI's portal. If it fails on the option never appearing, the cause is a missing polyfill rather than a component bug — confirm `document.elementFromPoint` and `Element.prototype.scrollIntoView` are installed in `setup.ts`, and that `screen.findByRole` (not `getByRole`) is used, since the portal content mounts asynchronously.

- [ ] **Step 3: Commit**

```bash
git add src/test/dom/composer.test.tsx
git commit -m "test: cover Composer submit, interrupt and effort behavior"
```

---

### Task 5: App boot sequence

Covers the `set-visible` effect that keeps restored panes alive after a reload — the one whose absence leaves every pane dead until the user happens to create or close a session.

**Files:**
- Test: `src/test/dom/app-boot.test.tsx`
- Read for context: `src/webview/app.tsx`

**Interfaces:**
- Consumes: `posted`, `renderApp`, `sendFromHost` from `./harness`; `catalog`, `layoutOf`, `snapshot`, `summary` from `../fixtures/protocol`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrate(ids: string[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: ids.map((id) => summary(id)),
    layout: layoutOf(...ids),
    snapshots: ids.map((id) => snapshot(id)),
    catalog: catalog(),
  });
}

suite('App boot', () => {
  test('renders Loading… until hydrate arrives', () => {
    renderApp();
    screen.getByText('Loading…');
  });

  test('mount posts ready once, and set-visible for an empty pane set', () => {
    renderApp();

    // App's hooks sit above the `!state.ready` early return, so its effects
    // run on mount even while Loading… is on screen — and child effects flush
    // before the parent's, so this set-visible precedes ready.
    assert.deepStrictEqual(posted().filter((m) => m.t === 'ready'), [{ t: 'ready' }]);
    assert.deepStrictEqual(
      posted().filter((m) => m.t === 'set-visible'),
      [{ t: 'set-visible', sessionIds: [] }],
    );
  });

  test('hydrate renders a pane per layout entry', () => {
    renderApp();
    hydrate(['a', 'b']);

    assert.strictEqual(screen.queryByText('Loading…'), null);
    screen.getByLabelText('Session: Session a');
    screen.getByLabelText('Session: Session b');
  });

  test('hydrate posts set-visible carrying the layout session ids', () => {
    renderApp();
    hydrate(['a', 'b']);

    // Two: the empty one from mount, then the real one once panes exist.
    const visible = posted().filter((m) => m.t === 'set-visible');
    assert.strictEqual(visible.length, 2);
    assert.deepStrictEqual(visible.at(-1), { t: 'set-visible', sessionIds: ['a', 'b'] });
  });

  test('an empty roster renders the empty state', () => {
    renderApp();
    hydrate([]);

    screen.getByText('No open sessions.');
  });
});
```

- [ ] **Step 2: Run them**

Run: `yarn test:dom`
Expected: all PASS.

`hydrate(['a','b'])` mounts the full pane tree — `SessionHeader`, `Transcript` and `Composer` — so this is the first test to exercise `@shadcn/react/message-scroller` and `react-resizable-panels` under jsdom. A crash on mount points at a missing polyfill in `setup.ts`, not at application code.

- [ ] **Step 3: Commit**

```bash
git add src/test/dom/app-boot.test.tsx
git commit -m "test: cover the app boot and set-visible handshake"
```

---

### Task 6: `SessionPicker`

Doubles as the canary for Base UI's dropdown portal.

**Files:**
- Test: `src/test/dom/session-picker.test.tsx`
- Read for context: `src/webview/components/session-picker.tsx`

**Interfaces:**
- Consumes: `posted`, `renderApp`, `sendFromHost` from `./harness`; `catalog`, `layoutOf`, `snapshot`, `summary` from `../fixtures/protocol`.
- Produces: nothing consumed by later tasks.

Mount through `renderApp()` rather than the component alone: `SessionPicker` reads `state.sessions`, `state.layout` and `state.catalog`, all of which arrive via `hydrate` anyway.

- [ ] **Step 1: Write the failing tests**

Toggling a session posts **two** messages — `set-layout` then `set-visible` — so assert on a filtered slice, not on `at(-1)`.

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

/** Two sessions in the roster, only 'a' currently open in a pane. */
function hydrateAOpen() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a'), summary('b')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a'), snapshot('b')],
    catalog: catalog(),
  });
}

suite('SessionPicker', () => {
  test('the trigger shows open-over-total', () => {
    renderApp();
    hydrateAOpen();

    screen.getByText('Sessions (1/2)');
  });

  test('checking a closed session posts set-layout and set-visible for both', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    await userEvent.click(await screen.findByText('Session b'));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.deepStrictEqual(layouts.at(-1), {
      t: 'set-layout',
      layout: { orientation: 'vertical', panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }] },
    });

    const visible = posted().filter((m) => m.t === 'set-visible');
    assert.deepStrictEqual(visible.at(-1), { t: 'set-visible', sessionIds: ['a', 'b'] });
  });

  test('the delete item posts delete-session', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    await userEvent.click(await screen.findByLabelText('Delete session Session b'));

    assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
  });

  test('the orientation toggle posts the flipped layout', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByLabelText('Toggle split orientation'));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.strictEqual(layouts.at(-1)!.layout.orientation, 'horizontal');
  });

  test('New posts create-session with the first catalog provider', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('+ New'));

    assert.deepStrictEqual(posted().at(-1), { t: 'create-session', providerId: 'fake', cwd: '' });
  });
});
```

- [ ] **Step 2: Run them**

Run: `yarn test:dom`
Expected: all PASS.

If `evenlySizedPanes` produces sizes other than `50`, read `src/webview/components/pane-layout.ts` and correct the expected layout to match it — that function is already unit-tested and is the authority.

- [ ] **Step 3: Commit**

```bash
git add src/test/dom/session-picker.test.tsx
git commit -m "test: cover SessionPicker toggling, deletion and orientation"
```

---

### Task 7: `PaneGroup`, cleanup and docs

Thin by design: its real job is proving the pane tree survives mount under jsdom. Also retires the smoke test and updates CLAUDE.md.

**Files:**
- Test: `src/test/dom/pane-group.test.tsx`
- Delete: `src/test/dom/smoke.test.tsx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `renderApp`, `sendFromHost` from `./harness`; fixtures as before.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';

function hydrate(paneIds: string[], rosterIds = paneIds) {
  sendFromHost({
    t: 'hydrate',
    sessions: rosterIds.map((id) => summary(id)),
    layout: layoutOf(...paneIds),
    snapshots: rosterIds.map((id) => snapshot(id)),
    catalog: catalog(),
  });
}

suite('PaneGroup', () => {
  test('renders one labelled panel per layout entry', () => {
    renderApp();
    hydrate(['a', 'b', 'c']);

    screen.getByLabelText('Open agent sessions');
    for (const id of ['a', 'b', 'c']) {
      screen.getByLabelText(`Session: Session ${id}`);
    }
  });

  test('renders a resize handle between panes but not before the first', () => {
    renderApp();
    hydrate(['a', 'b', 'c']);

    screen.getByLabelText('Resize between panes 1 and 2');
    screen.getByLabelText('Resize between panes 2 and 3');
    assert.strictEqual(screen.queryByLabelText('Resize between panes 0 and 1'), null);
  });

  test('a pane whose session left the roster is not rendered', () => {
    renderApp();
    // 'b' has a pane in the layout but is absent from sessions and snapshots.
    hydrate(['a', 'b'], ['a']);

    screen.getByLabelText('Session: Session a');
    assert.strictEqual(screen.queryByLabelText('Session: Session b'), null);
  });

  test('each pane carries its own composer', () => {
    renderApp();
    hydrate(['a', 'b']);

    assert.strictEqual(screen.getAllByLabelText('Message').length, 2);
  });
});
```

- [ ] **Step 2: Run them**

Run: `yarn test:dom`
Expected: all PASS.

The third test relies on `hydrate` passing a shorter roster than the pane list — `visiblePanes` filters on both roster membership and snapshot arrival, and the fixture helper above omits `b` from each.

- [ ] **Step 3: Delete the smoke test**

It proved the toolchain in Task 1 and every later suite now re-proves it on every run.

```bash
git rm src/test/dom/smoke.test.tsx
```

- [ ] **Step 4: Update CLAUDE.md**

In the **Architecture** section, replace the `**Tests:**` line with:

```markdown
**Tests:** mocha for unit tests (`yarn test:unit`, TDD-style `suite`/`test` globals, run
straight from source through the `tsx/cjs` hook), mocha + jsdom for webview DOM tests
(`yarn test:dom`, components mounted under a real `StoreProvider` and driven with genuine
`HostToWebview` messages — see `src/test/dom/harness.tsx`), `@vscode/test-cli` for
integration (`yarn test`).
```

Add to the **Invariants** list:

```markdown
- **DOM tests drive components through the real `StoreProvider`.** State arrives as genuine
  `HostToWebview` messages via `sendFromHost`; assertions read the messages the webview
  posted back. Never mock `useStore` or hand-build a `ClientState` — a fake provider bypasses
  `reduce` and lets a test pass against a state the host could never produce.
```

- [ ] **Step 5: Run the whole gate**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom && yarn test`
Expected: all PASS, including the VS Code integration suite.

- [ ] **Step 6: Commit**

```bash
git add src/test/dom/pane-group.test.tsx CLAUDE.md
git commit -m "test: cover PaneGroup rendering and document the DOM suite"
```

---

## Not covered, deliberately

`Transcript` scroll-follow, virtualization and `load-more` triggering. jsdom computes no
layout — every measured height and every scroll offset is 0 — so a test asserting them would
assert nothing real. That behavior needs a browser, which the spec scoped out.
