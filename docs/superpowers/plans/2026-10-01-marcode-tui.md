# Marcode TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `marcode`, a terminal client for Marcode: roster, one transcript, composer, tool approvals and questions, new session, model/effort/mode switching and read-only foreign sessions, running its own in-process host over the shared `~/.marcode` workspace directory.

**Architecture:** The pure client state (`reduce`, `ClientState`, tool rendering, drafts) moves to `src/client-core/` behind a `ClientTransport` interface. The TUI boots `createHost({ hostKind: 'tui' })`, wraps its `MessageRouter` in an in-process loopback transport, and renders with OpenTUI React. Pure view logic (keymap, roster rows, bottom-slot choice, transcript rows, CLI parsing) lives outside JSX so it runs under mocha on Node 22; components run under `bun test` with OpenTUI's test renderer.

**Tech Stack:** TypeScript, React 19, `@opentui/core` + `@opentui/react`, Bun (runtime and `bun build --compile`), mocha (pure logic), `bun test` (components, end-to-end), esbuild (extension, unchanged).

**Spec:** [docs/superpowers/specs/2026-09-30-marcode-tui-design.md](../specs/2026-09-30-marcode-tui-design.md). Builds on [shared storage and a vscode-free host](../specs/2026-09-30-shared-storage-headless-host-design.md).

## Global Constraints

- Branch `feat/tui`, stacked on `feat/shared-storage-headless-host`. Commit after every task, conventional prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). **No `Co-Authored-By` or Claude/Anthropic trailer on any commit.**
- Run every gate with its own `cd /e/Efebia/hiiiid-code &&` prefix; the shell cwd reverts mid-session.
- The extension keeps VS Code `^1.125.0`, Node 22, CJS bundles. Nothing in this plan changes `dist/extension.js` behavior.
- The TUI runs on **Bun >= 1.3** (local: 1.3.5). OpenTUI is ESM-only and does not run on Node 22.
- `src/protocol/messages.ts` stays types-only. Nothing under `src/tui/` or `src/client-core/` imports `vscode`.
- `src/client-core/` has no React, no DOM, no `vscode`.
- Every message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions. A boot failure prints one stderr line and exits non-zero **before** the renderer starts; after it starts, problems go through `notify.warn` to a status-line notice. Fatal handlers call `renderer.destroy()` first.
- Filenames are kebab-case. Component identifiers PascalCase.
- Comments minimal: only non-obvious "why". Files over ~300 lines get split.
- Shares (context, usage) display as percentages; the only token count anywhere is the context window line, and that dialog is out of scope for v1.
- Tests: pure logic under mocha in `src/test/unit/tui-*.test.ts` (TDD `suite`/`test`, `node:assert`); components under `bun test` in `src/test/tui/`. **Never hand a renderer, renderable or DOM node to an assertion**; compare strings, booleans, counts (`captureCharFrame()` returns a string). Never mock the store or hand-build `ClientState`: feed genuine `HostToWebview` messages through the loopback.
- OpenTUI API names below come from its docs (`useKeyboard`, `testRender`, `<scrollbox stickyScroll stickyStart="bottom">`, `<markdown content streaming>`, `<textarea>` with `onSubmit`/`keyBindings`, `<diff>`). When `yarn check-types:tui` rejects one, correct it from the installed `.d.ts`, keep the behavior, and note it under "Deviations" at the bottom of this file.
- Out of scope (do not build): split panes, fleet/review/history tabs, context dialog, usage strip, attachments, `@` mentions, handoff seeds, worktree/relocation cards beyond a read-only one-liner, mouse, in-TUI login suspend, forking a foreign session.

## Review Focus

Inputs the spec implies but no single feature task would otherwise pin; each has a test in the named task.

1. **Bun cannot load `node:sqlite`** (Task 1, Task 6): the host must still boot with memory off. Test: `bootHost` with `memory.enabled=false` succeeds; spike records the real behavior.
2. **Cwd is not in a git repo, or git is missing** (Task 5): workspace key falls back to the cwd, no throw.
3. **Terminal narrower than 100 columns or resized mid-stream** (Task 9, Task 13): roster becomes an overlay, transcript stays pinned, no crash on width < 40.
4. **Approval arrives while the user is mid-draft** (Task 12): the draft survives and reappears intact after the answer.
5. **A foreign session's owner releases or goes stale while it is focused** (Task 15): the banner turns back into a composer without a restart.
6. **Prompt arg or `--new` on a host with zero available providers** (Task 5, Task 14): no crash and no silently dropped prompt; the empty state explains and keeps the prompt as the draft.
7. **Second `Ctrl+C` / SIGTERM during dispose, uncaught exception after the renderer starts** (Task 15): terminal restored, process exits, no hang.
8. **Very long single-line tool output or assistant paragraph** (Task 10): clamped/wrapped, never one unbounded row.

---

## File Structure

```
src/client-core/                  moved from src/webview (re-exported at old paths)
  reducer.ts  layout-tree.ts  tool-render.ts  tool-card-format.ts
  draft-store.ts  owner-reason.ts  provider-availability.ts  prompt-history.ts
  transport.ts            ClientTransport interface
  loopback-transport.ts   createLoopback(handle) -> { transport, deliver }
src/webview/vscode-transport.ts   vscodeTransport over vscode-api

src/tui/                          pure, no JSX, runs under mocha and bun
  cli.ts            parseArgs
  workspace-root.ts findGitRoot
  boot.ts           bootHost
  tui-config-host.ts  router ConfigHost/EditorContextHost for a terminal
  keymap.ts         zone + key -> action
  view/roster-rows.ts  view/bottom-slot.ts  view/transcript-rows.ts
  view/launch.ts    what to do after hydrate (resume / create / empty)
  subcommands.ts    login, config, migrate
src/tui/ui/                       JSX (OpenTUI), typed by src/tui/ui/tsconfig.json
  main.tsx  app.tsx  store.tsx
  roster.tsx  status-line.tsx  bottom-slot.tsx  composer.tsx
  approval-prompt.tsx  question-prompt.tsx  foreign-banner.tsx
  new-session-dialog.tsx  empty-state.tsx  notice-line.tsx
  transcript/transcript.tsx  transcript/row.tsx  transcript/tool-row.tsx
src/test/unit/tui-*.test.ts       mocha
src/test/tui/                     bun test: harness.tsx, *.test.tsx, e2e.test.tsx
scripts/spikes/bun-host.ts  scripts/check-tui-asserts.mjs  scripts/build-tui.mjs
```

---

### Task 1: Bun compatibility spike and OpenTUI install

Gate for the whole plan. Output is a recorded answer; the script is throwaway.

**Files:**
- Create: `scripts/spikes/bun-host.ts`
- Create: `docs/superpowers/notes/2026-10-01-bun-host-spike.md`
- Modify: `package.json` (devDependencies only)

**Interfaces:**
- Consumes: `createHost` (`src/host/create-host.ts`), `defaultHostConfig` (`src/host/host-config.ts`).
- Produces: a note stating, per probe, `ok`/`FAIL`, and the decision for `node:sqlite` (keep memory, or force `memory.enabled=false` in the TUI).

- [ ] **Step 1: Install the TUI dependencies**

```bash
cd /e/Efebia/hiiiid-code && yarn add -D @opentui/core @opentui/react @types/bun
```
If yarn rejects an `engines` mismatch (OpenTUI's Node floor), rerun with `--ignore-engines`. Record the resolved `@opentui/core` and `@opentui/react` versions in the note, then pin both to that exact version in `package.json` (remove the `^`).

- [ ] **Step 2: Write the spike**

```ts
// scripts/spikes/bun-host.ts   run: bun scripts/spikes/bun-host.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../../src/host/create-host';
import { defaultHostConfig } from '../../src/host/host-config';

const results: Record<string, string> = {};
async function probe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { results[name] = `ok ${String((await fn()) ?? '')}`.trim(); }
  catch (err) { results[name] = `FAIL ${(err as Error).message}`; }
}

await probe('runtime', async () => (process.versions as Record<string, string>).bun ?? 'not bun');
await probe('node:sqlite fts5', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
  db.close();
});
await probe('acp sdk (esm import)', async () => { await import('@agentclientprotocol/sdk'); });
await probe('opencode sdk', async () => { await import('@opencode-ai/sdk/v2'); });
await probe('claude agent sdk', async () => { await import('@anthropic-ai/claude-agent-sdk'); });

for (const memory of [true, false]) {
  await probe(`createHost fake, memory=${memory}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bun-'));
    const host = await createHost({
      workspaceDir: dir, hostKind: 'tui', workspaceRoots: () => [dir], emit: () => {},
      notify: { warn: (m) => { results[`warn:${m.slice(0, 40)}`] = m; } },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: memory, summarizer: undefined } },
    });
    await host.init();
    const s = await host.manager.create('fake', dir);
    s.send('hello');
    await new Promise((r) => setTimeout(r, 300));
    const text = JSON.stringify(await s.snapshot());
    await host.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    return text.includes('"ok"') ? 'turn streamed' : 'no reply in snapshot';
  });
}
console.log(JSON.stringify(results, null, 2));
```

- [ ] **Step 3: Run it and record the result**

```bash
cd /e/Efebia/hiiiid-code && bun scripts/spikes/bun-host.ts
```
Expected: JSON with every probe `ok`. If `node:sqlite fts5` is `FAIL`, that is acceptable (memory off in the TUI); if `createHost fake, memory=false` or the ESM SDK imports are `FAIL`, **stop and report to the user** — the plan's runtime decision is invalid.

- [ ] **Step 4: Write the note**

Create `docs/superpowers/notes/2026-10-01-bun-host-spike.md` with: the date, the Bun and OpenTUI versions, the probe table copied from the output, and one line `Decision: TUI memory = on | off (forced)`. If forced off, Task 6's `bootHost` must set `memory.enabled = false` when `process.versions.bun` is defined and the probe failed; say so in the note.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add scripts/spikes/bun-host.ts docs/superpowers/notes/2026-10-01-bun-host-spike.md package.json yarn.lock && git commit -m "chore: bun compatibility spike and OpenTUI dependencies"
```

---

### Task 2: Move the pure client state into `src/client-core/`

Mechanical move; behavior must not change. Old paths become re-export stubs so no importer changes.

**Files:**
- Move (`git mv`): `src/webview/reducer.ts`, `src/webview/components/layout-tree.ts`, `src/webview/components/tool-render.ts`, `src/webview/components/tool-card-format.ts`, `src/webview/lib/draft-store.ts`, `src/webview/lib/owner-reason.ts`, `src/webview/lib/provider-availability.ts`, `src/webview/lib/prompt-history.ts` → `src/client-core/<same basename>`
- Create (stubs at the old paths): one `export * from '<relative>/client-core/<name>';` per moved file
- Modify imports inside moved files: `reducer.ts` (`./components/layout-tree` → `./layout-tree`; `'../protocol/messages'` stays `../protocol/messages`), `tool-render.ts` and `draft-store.ts` and `prompt-history.ts` (`../../protocol/messages` → `../protocol/messages`), `provider-availability.ts` (`"../reducer"` → `"./reducer"`)
- Test: `src/test/unit/client-core-reexports.test.ts`

**Interfaces:**
- Produces: `src/client-core/<name>` exports identical to the old modules (`reduce`, `initialState`, `ClientState`, `PaneState`, `ClientAction`, `leafSessionIds`, `describeTool`, `describeInput`, `describeOutput`, `clampLines`, `ToolBlock`, `ToolHeader`, `createDraftStore`, `DraftStore`, `ownerReason`, `unavailabilityFor`, `promptHistory`, `safeStringify`, `summarize`, `shortPath`).

- [ ] **Step 1: Write the failing test**

```ts
// src/test/unit/client-core-reexports.test.ts
import * as assert from 'node:assert';
import * as core from '../../client-core/reducer';
import * as coreTool from '../../client-core/tool-render';
import * as oldReducer from '../../webview/reducer';
import * as oldTool from '../../webview/components/tool-render';
import * as oldLayout from '../../webview/components/layout-tree';
import * as coreLayout from '../../client-core/layout-tree';

suite('client-core re-exports', () => {
  test('the old webview paths expose the same functions as client-core', () => {
    assert.strictEqual(oldReducer.reduce, core.reduce);
    assert.strictEqual(oldReducer.initialState, core.initialState);
    assert.strictEqual(oldTool.describeTool, coreTool.describeTool);
    assert.strictEqual(oldLayout.leafSessionIds, coreLayout.leafSessionIds);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "client-core re-exports"
```
Expected: FAIL, `Cannot find module '../../client-core/reducer'`.

- [ ] **Step 3: Move the files and write the stubs**

```bash
cd /e/Efebia/hiiiid-code && mkdir -p src/client-core \
 && git mv src/webview/reducer.ts src/client-core/reducer.ts \
 && git mv src/webview/components/layout-tree.ts src/client-core/layout-tree.ts \
 && git mv src/webview/components/tool-render.ts src/client-core/tool-render.ts \
 && git mv src/webview/components/tool-card-format.ts src/client-core/tool-card-format.ts \
 && git mv src/webview/lib/draft-store.ts src/client-core/draft-store.ts \
 && git mv src/webview/lib/owner-reason.ts src/client-core/owner-reason.ts \
 && git mv src/webview/lib/provider-availability.ts src/client-core/provider-availability.ts \
 && git mv src/webview/lib/prompt-history.ts src/client-core/prompt-history.ts
```
Then fix the five import lines listed above, and create the stubs:

```ts
// src/webview/reducer.ts
export * from '../client-core/reducer';
// src/webview/components/layout-tree.ts
export * from '../../client-core/layout-tree';
// src/webview/components/tool-render.ts
export * from '../../client-core/tool-render';
// src/webview/components/tool-card-format.ts
export * from '../../client-core/tool-card-format';
// src/webview/lib/draft-store.ts
export * from '../../client-core/draft-store';
// src/webview/lib/owner-reason.ts
export * from '../../client-core/owner-reason';
// src/webview/lib/provider-availability.ts
export * from '../../client-core/provider-availability';
// src/webview/lib/prompt-history.ts
export * from '../../client-core/prompt-history';
```

- [ ] **Step 4: Run the whole existing suites**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn check-types && yarn lint
```
Expected: all green, including the new re-export test. If the esbuild bundle needs checking: `node esbuild.js`.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A src && git commit -m "refactor: move pure client state to src/client-core with re-exports"
```

---

### Task 3: `ClientTransport` and the loopback transport

**Files:**
- Create: `src/client-core/transport.ts`, `src/client-core/loopback-transport.ts`, `src/webview/vscode-transport.ts`
- Modify: `src/webview/store.tsx` (use `vscodeTransport`)
- Test: `src/test/unit/loopback-transport.test.ts`

**Interfaces:**
- Produces:
```ts
// transport.ts
export interface ClientTransport {
  post(msg: WebviewToHost): void;
  onMessage(listener: (msg: HostToWebview) => void): () => void;
}
// loopback-transport.ts
export interface Loopback { transport: ClientTransport; deliver(msg: HostToWebview): void }
export function createLoopback(handle: (msg: WebviewToHost) => void | Promise<void>): Loopback;
```
- `deliver` is what the host's `emit` calls. `post` calls `handle` and never throws or rejects across the boundary (a rejected promise is swallowed to `console.error`).

- [ ] **Step 1: Write the failing test**

```ts
// src/test/unit/loopback-transport.test.ts
import * as assert from 'node:assert';
import { createLoopback } from '../../client-core/loopback-transport';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

suite('loopback transport', () => {
  test('post reaches the handler, deliver reaches every listener, off unsubscribes', () => {
    const handled: WebviewToHost[] = [];
    const { transport, deliver } = createLoopback((m) => { handled.push(m); });
    const a: HostToWebview[] = [];
    const b: HostToWebview[] = [];
    const offA = transport.onMessage((m) => a.push(m));
    transport.onMessage((m) => b.push(m));
    transport.post({ t: 'ready' });
    deliver({ t: 'usage-refresh-done' });
    offA();
    deliver({ t: 'usage-refresh-done' });
    assert.deepStrictEqual(handled, [{ t: 'ready' }]);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 2);
  });

  test('a rejecting handler never surfaces as an unhandled rejection', async () => {
    const { transport } = createLoopback(async () => { throw new Error('boom'); });
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRejection);
    const origError = console.error;
    console.error = () => {};
    transport.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    console.error = origError;
    process.off('unhandledRejection', onRejection);
    assert.strictEqual(seen.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "loopback transport"
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/client-core/transport.ts
import type { HostToWebview, WebviewToHost } from '../protocol/messages';

export interface ClientTransport {
  post(msg: WebviewToHost): void;
  onMessage(listener: (msg: HostToWebview) => void): () => void;
}
```
```ts
// src/client-core/loopback-transport.ts
import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import type { ClientTransport } from './transport';

export interface Loopback { transport: ClientTransport; deliver(msg: HostToWebview): void }

export function createLoopback(handle: (msg: WebviewToHost) => void | Promise<void>): Loopback {
  const listeners = new Set<(msg: HostToWebview) => void>();
  return {
    deliver: (msg) => { for (const l of [...listeners]) { l(msg); } },
    transport: {
      post: (msg) => {
        void Promise.resolve()
          .then(() => handle(msg))
          .catch((err: unknown) => { console.error('[marcode] loopback: handler failed', msg.t, err); });
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
}
```
```ts
// src/webview/vscode-transport.ts
import type { ClientTransport } from '../client-core/transport';
import { onHostMessage, postToHost } from './vscode-api';

export const vscodeTransport: ClientTransport = { post: postToHost, onMessage: onHostMessage };
```
In `src/webview/store.tsx`: replace `import { onHostMessage, postToHost } from './vscode-api';` with `import { vscodeTransport } from './vscode-transport';`, `onHostMessage(` → `vscodeTransport.onMessage(`, and both `postToHost(` calls → `vscodeTransport.post(`.

- [ ] **Step 4: Run all suites**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn check-types && yarn lint
```
Expected: green (the DOM harness's `acquireVsCodeApi` stub still applies because `vscode-transport` imports `vscode-api`).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A src && git commit -m "feat: ClientTransport seam and in-process loopback transport"
```

---

### Task 4: TUI toolchain scaffold and proof

Wires typechecking, the `bun test` runner, the RAM guard and the assert ban, and proves OpenTUI renders and takes input under the test renderer.

**Files:**
- Create: `src/tui/ui/tsconfig.json`, `src/test/tui/tsconfig.json`, `src/test/tui/toolchain.test.tsx`, `scripts/check-tui-asserts.mjs`, `src/test/unit/check-tui-asserts.test.ts`
- Modify: `tsconfig.json` (exclude), `package.json` (scripts), `scripts/run-tests-ram-guard.mjs` (new suite)

**Interfaces:**
- Produces: scripts `check-types:tui`, `test:tui`, `test:tui:raw`; `findViolations(source: string): string[]` exported from `scripts/check-tui-asserts.mjs`.

- [ ] **Step 1: tsconfig split**

Root `tsconfig.json`: add `"exclude": ["node_modules", "out", "dist", "src/tui/ui", "src/test/tui"]` next to `compilerOptions`. Create both per-directory configs (Bun reads the nearest `tsconfig.json` for JSX settings):

```json
// src/tui/ui/tsconfig.json  and  src/test/tui/tsconfig.json  (identical)
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ESNext",
    "lib": ["ESNext"],
    "types": ["bun"],
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "rootDir": "../..",
    "noEmit": true
  },
  "include": ["./**/*"],
  "exclude": []
}
```
(`src/tui/ui` and `src/test/tui` are both two levels below `src`, so the same relative `extends` and `rootDir` work for both.) Add a root-level `tsconfig.tui.json`:

```json
{
  "extends": "./src/tui/ui/tsconfig.json",
  "include": ["src/tui/**/*", "src/client-core/**/*", "src/test/tui/**/*", "src/test/fixtures/**/*"],
  "exclude": []
}
```
`package.json` scripts:
```json
"check-types:tui": "tsc -p tsconfig.tui.json --noEmit",
"test:tui:raw": "bun test src/test/tui",
"test:tui": "node scripts/run-tests-ram-guard.mjs tui && node scripts/check-tui-asserts.mjs",
```
and change `"compile"` to `"node esbuild.js && yarn run check-types && yarn run check-types:tui && yarn run lint"`.

- [ ] **Step 2: RAM guard suite**

In `scripts/run-tests-ram-guard.mjs`, add to `SUITES`:
```js
    tui: {
        bin: process.platform === "win32" ? "bun.exe" : "bun",
        args: ["test", "src/test/tui"],
    },
```
and update the usage string/comment list to include `tui`. The existing `spawn(..., { shell: false })` resolves `bun.exe` from PATH.

- [ ] **Step 3: Failing test for the assert ban**

```js
// scripts/check-tui-asserts.mjs  (exports findViolations; CLI scans src/test/tui)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = /\b(?:expect|assert\w*)\(\s*[^)]*\b(?:renderer|renderable|getRenderable|\.root\b)/;

export function findViolations(source) {
  return source.split('\n').flatMap((line, i) => (BANNED.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'test', 'tui');
  const bad = walk(root).flatMap((f) => findViolations(readFileSync(f, 'utf8')).map((v) => `${f}:${v}`));
  if (bad.length > 0) {
    console.error('A renderer or renderable reached an assertion; compare a string/boolean/count instead:\n' + bad.join('\n'));
    process.exit(1);
  }
}
```
```ts
// src/test/unit/check-tui-asserts.test.ts
import * as assert from 'node:assert';

suite('check-tui-asserts', () => {
  test('flags a renderer in an assertion and passes a frame string', async () => {
    const { findViolations } = await import('../../../scripts/check-tui-asserts.mjs');
    assert.strictEqual(findViolations('expect(setup.renderer).toBeDefined()').length, 1);
    assert.strictEqual(findViolations('expect(setup.captureCharFrame()).toContain("ok")').length, 0);
  });
});
```
Run `cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "check-tui-asserts"`: write the test first (FAIL, module missing), then add the script, rerun (PASS). If TS rejects the `.mjs` import, add `// @ts-expect-error untyped script` above it.

- [ ] **Step 4: Toolchain proof test (fails until the runner and config exist)**

```tsx
// src/test/tui/toolchain.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { useState } from 'react';

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => { setup?.renderer.destroy(); setup = undefined; });

function Counter() {
  const [n, setN] = useState(0);
  return (
    <box flexDirection="column">
      <text>{`count ${n}`}</text>
      <input focused onInput={() => setN((v) => v + 1)} />
    </box>
  );
}

test('the test renderer draws a frame and takes typed input', async () => {
  setup = await testRender(<Counter />, { width: 40, height: 6 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('count 0');
  setup.mockInput.typeText('ab');
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('count 2');
});
```
- [ ] **Step 5: Run the gates**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn check-types && yarn lint && yarn test:unit
```
Expected: PASS everywhere. If `testRender` is not async or `onInput` is not the prop name, correct from the installed types and note it under Deviations. Confirm `yarn test:tui` (guarded) also passes.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add -A . ':!dist' && git commit -m "chore: TUI toolchain (tsconfigs, bun test runner, ram guard, assert ban)"
```

---

### Task 5: CLI parsing and workspace root

**Files:**
- Create: `src/tui/cli.ts`, `src/tui/workspace-root.ts`
- Test: `src/test/unit/tui-cli.test.ts`, `src/test/unit/tui-workspace-root.test.ts`

**Interfaces:**
- Produces:
```ts
export type CliCommand =
  | { kind: 'run'; prompt?: string; forceNew: boolean }
  | { kind: 'login'; provider: string }
  | { kind: 'config' }
  | { kind: 'migrate'; oldDir: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string };
export function parseArgs(argv: string[]): CliCommand;          // argv = process.argv.slice(2)
export const USAGE: string;
export function findGitRoot(cwd: string): Promise<string>;       // git toplevel, else cwd
```

- [ ] **Step 1: Failing tests**

```ts
// src/test/unit/tui-cli.test.ts
import * as assert from 'node:assert';
import { parseArgs } from '../../tui/cli';

suite('tui cli', () => {
  test('no args resumes', () => {
    assert.deepStrictEqual(parseArgs([]), { kind: 'run', forceNew: false });
  });
  test('a quoted prompt is the prompt; extra words are joined', () => {
    assert.deepStrictEqual(parseArgs(['fix', 'the', 'tests']), { kind: 'run', prompt: 'fix the tests', forceNew: false });
  });
  test('--new alone and with a prompt', () => {
    assert.deepStrictEqual(parseArgs(['--new']), { kind: 'run', forceNew: true });
    assert.deepStrictEqual(parseArgs(['--new', 'go']), { kind: 'run', prompt: 'go', forceNew: true });
  });
  test('subcommands', () => {
    assert.deepStrictEqual(parseArgs(['login', 'claude']), { kind: 'login', provider: 'claude' });
    assert.deepStrictEqual(parseArgs(['config']), { kind: 'config' });
    assert.deepStrictEqual(parseArgs(['migrate', 'C:\\old']), { kind: 'migrate', oldDir: 'C:\\old' });
    assert.deepStrictEqual(parseArgs(['--help']), { kind: 'help' });
  });
  test('missing operands and unknown flags are errors, never throws', () => {
    assert.strictEqual(parseArgs(['login']).kind, 'error');
    assert.strictEqual(parseArgs(['migrate']).kind, 'error');
    assert.strictEqual(parseArgs(['--bogus']).kind, 'error');
  });
  test('a prompt that begins with a login-like word needs --', () => {
    assert.deepStrictEqual(parseArgs(['--', 'login', 'page']), { kind: 'run', prompt: 'login page', forceNew: false });
  });
});
```
```ts
// src/test/unit/tui-workspace-root.test.ts
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGitRoot } from '../../tui/workspace-root';

suite('tui workspace root', () => {
  let dir: string;
  setup(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-root-'))); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a subfolder of a repo resolves to the repo root', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const sub = path.join(dir, 'a', 'b');
    await fs.mkdir(sub, { recursive: true });
    assert.strictEqual(path.resolve(await findGitRoot(sub)), path.resolve(dir));
  });
  test('outside a repo the cwd is the root, with no throw', async () => {
    assert.strictEqual(path.resolve(await findGitRoot(dir)), path.resolve(dir));
  });
  test('a missing directory falls back to itself', async () => {
    const gone = path.join(dir, 'nope');
    assert.strictEqual(await findGitRoot(gone), gone);
  });
});
```
Note: the `outside a repo` test assumes the OS temp dir is not inside a git repo, which holds for `os.tmpdir()`.

- [ ] **Step 2: Run to verify they fail**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui "
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```ts
// src/tui/cli.ts
export type CliCommand =
  | { kind: 'run'; prompt?: string; forceNew: boolean }
  | { kind: 'login'; provider: string }
  | { kind: 'config' }
  | { kind: 'migrate'; oldDir: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const USAGE = [
  'marcode [--new] [prompt...]   open the TUI (resume the last session; with a prompt, start one)',
  'marcode login <provider>      sign a provider in',
  'marcode config                open ~/.marcode/config.json in $EDITOR',
  'marcode migrate <old-dir>     import a VS Code storage folder',
  'marcode -- <prompt...>        a prompt that starts with a subcommand word',
].join('\n');

export function parseArgs(argv: string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h') { return { kind: 'help' }; }
  if (first === 'login') {
    return rest[0] ? { kind: 'login', provider: rest[0] } : { kind: 'error', message: 'login needs a provider id' };
  }
  if (first === 'config') { return { kind: 'config' }; }
  if (first === 'migrate') {
    return rest[0] ? { kind: 'migrate', oldDir: rest[0] } : { kind: 'error', message: 'migrate needs the old storage directory' };
  }
  let forceNew = false;
  const words: string[] = [];
  let literal = false;
  for (const arg of argv) {
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg === '--new') { forceNew = true; continue; }
    if (!literal && arg.startsWith('-')) { return { kind: 'error', message: `unknown option ${arg}` }; }
    words.push(arg);
  }
  const prompt = words.join(' ').trim();
  return prompt ? { kind: 'run', prompt, forceNew } : { kind: 'run', forceNew };
}
```
```ts
// src/tui/workspace-root.ts
import { execFile } from 'node:child_process';

export function findGitRoot(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd }, (err, stdout) => {
      const top = stdout.trim();
      resolve(err || top === '' ? cwd : top);
    });
  });
}
```
- [ ] **Step 4: Run to verify they pass**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui " && yarn check-types && yarn lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/unit && git commit -m "feat: TUI CLI parsing and git-root workspace resolution"
```

---

### Task 6: `bootHost`

The one place that assembles host, router and transport. No JSX, no OpenTUI import, so it is tested under mocha.

**Files:**
- Create: `src/tui/boot.ts`, `src/tui/tui-hooks.ts`
- Test: `src/test/unit/tui-boot.test.ts`

**Interfaces:**
- Consumes: `marcodeHome`, `resolveWorkspaceDir` (`src/host/workspace-dir.ts`), `configPath`, `loadConfig`, `favoriteModelsSource`, `watchConfig` (`src/host/config-file.ts`; read their signatures first), `createHost`, `MessageRouter`, `createLoopback`, `findGitRoot`.
- Produces:
```ts
export interface BootOptions {
  cwd: string;
  home?: string;                         // default marcodeHome(); tests pass a temp dir
  config?: Partial<HostConfig>;          // tests override (e.g. enabledProviders: ['fake'])
  notify?: (message: string) => void;    // warnings; default console.error until the UI installs its own
}
export interface Booted {
  host: HostHandle;
  router: MessageRouter;
  loopback: Loopback;
  workspaceRoot: string;                 // git root or cwd
  launchCwd: string;                     // BootOptions.cwd
  configFile: string;
  warnings: string[];
  shutdown(): Promise<void>;             // idempotent
}
export async function bootHost(opts: BootOptions): Promise<Booted>;
```
- Router wiring: `EditorContextHost` no-ops except `openExternal` (`console`-free no-op in v1) and `login` (records `loginRequested` through `opts`-less hook, see `tui-hooks.ts`); `ConfigHost.setFavoriteModels` via `favoriteModelsSource(configFile, ...)`.

- [ ] **Step 1: Read the real signatures first**

```bash
cd /e/Efebia/hiiiid-code && sed -n 80,140p src/host/config-file.ts
```
Use `favoriteModelsSource(file, initial, warn)` and `watchConfig` exactly as `src/extension.ts` does.

- [ ] **Step 2: Failing test**

```ts
// src/test/unit/tui-boot.test.ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootHost, type Booted } from '../../tui/boot';
import type { HostToWebview } from '../../protocol/messages';

suite('tui boot', () => {
  let tmp: string;
  let booted: Booted | undefined;
  setup(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-boot-'))); });
  teardown(async () => { await booted?.shutdown(); booted = undefined; await fs.rm(tmp, { recursive: true, force: true }); });

  const boot = async () => {
    booted = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'),
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    return booted;
  };

  test('ready through the loopback hydrates with the fake provider in the catalog', async () => {
    const b = await boot();
    const got: HostToWebview[] = [];
    b.loopback.transport.onMessage((m) => got.push(m));
    b.loopback.transport.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 100));
    const hydrate = got.find((m) => m.t === 'hydrate');
    assert.strictEqual(hydrate?.t === 'hydrate' && hydrate.catalog.some((p) => p.id === 'fake'), true);
  });

  test('the workspace directory lives under the given home and is stable', async () => {
    const b = await boot();
    assert.strictEqual(b.workspaceRoot, tmp);
    const entries = await fs.readdir(path.join(tmp, 'home', 'workspaces'));
    assert.strictEqual(entries.length, 1);
  });

  test('a corrupt config.json is a warning and the defaults, not a failed boot', async () => {
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'home', 'config.json'), '{ not json');
    const b = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'),
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    booted = b;
    assert.strictEqual(b.warnings.some((w) => w.includes('not valid JSON')), true);
  });

  test('shutdown twice is harmless', async () => {
    const b = await boot();
    await b.shutdown();
    await b.shutdown();
    booted = undefined;
  });
});
```
- [ ] **Step 3: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui boot"
```
Expected: FAIL, module missing.

- [ ] **Step 4: Implement**

```ts
// src/tui/tui-hooks.ts
import type { ConfigHost, EditorContextHost } from '../host/message-router';

export function terminalEditorHost(onLogin: (providerId: string) => void): EditorContextHost {
  return {
    current: () => null,
    reveal: () => {},
    openDiff: () => {},
    openSettings: () => {},
    openExternal: () => {},
    exportCsv: () => {},
    exportImage: () => {},
    login: onLogin,
  };
}

export function terminalConfigHost(setFavorites: (ids: string[]) => void): ConfigHost {
  return { setFavoriteModels: setFavorites };
}
```
```ts
// src/tui/boot.ts
import { configPath, favoriteModelsSource, loadConfig } from '../host/config-file';
import { createHost, type HostHandle } from '../host/create-host';
import { defaultHostConfig, type HostConfig } from '../host/host-config';
import { MessageRouter } from '../host/message-router';
import { marcodeHome, resolveWorkspaceDir } from '../host/workspace-dir';
import { createLoopback, type Loopback } from '../client-core/loopback-transport';
import { terminalConfigHost, terminalEditorHost } from './tui-hooks';
import { findGitRoot } from './workspace-root';

export interface BootOptions {
  cwd: string;
  home?: string;
  config?: Partial<HostConfig>;
  notify?: (message: string) => void;
}

export interface Booted {
  host: HostHandle;
  router: MessageRouter;
  loopback: Loopback;
  workspaceRoot: string;
  launchCwd: string;
  configFile: string;
  warnings: string[];
  shutdown(): Promise<void>;
}

export async function bootHost(opts: BootOptions): Promise<Booted> {
  const home = opts.home ?? marcodeHome();
  const configFile = configPath(home);
  const warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); opts.notify?.(message); };

  const loaded = await loadConfig(configFile);
  for (const w of loaded.warnings) { warn(w); }
  const config: HostConfig = { ...defaultHostConfig(), ...loaded.config, ...opts.config };

  const workspaceRoot = await findGitRoot(opts.cwd);
  const workspaceDir = await resolveWorkspaceDir(home, workspaceRoot);

  let router: MessageRouter | undefined;
  const loopback = createLoopback((msg) => router?.handle(msg));
  const host = await createHost({
    workspaceDir, config, hostKind: 'tui',
    workspaceRoots: () => [workspaceRoot],
    emit: (msg) => loopback.deliver(msg),
    notify: { warn },
  });
  await host.init();

  const favorites = favoriteModelsSource(configFile, config.favoriteModels, warn);
  router = new MessageRouter(
    host.manager, (msg) => loopback.deliver(msg), opts.cwd,
    terminalEditorHost(() => {}), host.attachments, undefined, config.review.pollIntervalMs,
    undefined, favorites.get(), terminalConfigHost((ids) => { void favorites.set(ids); }),
  );

  let down: Promise<void> | undefined;
  return {
    host, router, loopback, workspaceRoot, launchCwd: opts.cwd, configFile, warnings,
    shutdown: () => (down ??= host.dispose()),
  };
}
```
`host.init()` before the router exists is safe: `emit` goes to a loopback with no listeners yet, and `hydrate` on `ready` recovers all state.

- [ ] **Step 5: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui boot" && yarn check-types && yarn lint
```
Expected: PASS. If Task 1 recorded "memory forced off under Bun", add to `bootHost` right after the merge: `if (process.versions.bun && config.memory.enabled) { config.memory = { ...config.memory, enabled: false }; warn('Memory is unavailable under Bun in this build; recall is off.'); }` and add a test for it behind `process.versions.bun` (skipped under Node).

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/unit && git commit -m "feat: bootHost assembles host, router and loopback transport"
```

---

### Task 7: Pure view models (roster rows, bottom slot, transcript rows)

**Files:**
- Create: `src/tui/view/roster-rows.ts`, `src/tui/view/bottom-slot.ts`, `src/tui/view/transcript-rows.ts`
- Test: `src/test/unit/tui-view.test.ts`

**Interfaces:**
- Consumes: `SessionSummary`, `TranscriptItem`, `PermissionRequest`, `QuestionRequest`, `PaneState` (`src/client-core/reducer`), `describeTool`, `ToolHeader` (`src/client-core/tool-render`), `ownerReason`.
- Produces:
```ts
// roster-rows.ts
export interface RosterRow {
  id: SessionId; title: string; glyph: '●' | '○' | '!' | '✗';
  suffix?: string;   // "vscode·4812" for a foreign session
  dim: boolean; focused: boolean;
}
export function rosterRows(sessions: SessionSummary[], focusedId: SessionId | null): RosterRow[];
// bottom-slot.ts
export type BottomSlot =
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'foreign'; text: string }
  | { kind: 'composer' };
export function bottomSlot(summary: SessionSummary | undefined, pane: PaneState | undefined): BottomSlot;
// transcript-rows.ts
export type TranscriptRow =
  | { kind: 'user'; id: string; text: string; fromName?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; header: ToolHeader; state: 'running' | 'ok' | 'error'; depth: number }
  | { kind: 'permission'; id: string; header: ToolHeader; state: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'question'; id: string; state: string; text: string }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string };
export function transcriptRows(items: TranscriptItem[], running: boolean): TranscriptRow[];
```
Rules: a foreign summary (`owner` set) never yields `question`/`permission` slots; a question beats a permission; among questions a blocking one beats a non-blocking one. `transcriptRows` skips an assistant item with empty text, flattens a tool item's `children` at `depth: 1` right after it, marks only the **last** assistant row `streaming` and only while `running`, and maps `error`, `compaction`, `switch`, `relocation` items to `notice`.

- [ ] **Step 1: Failing tests**

```ts
// src/test/unit/tui-view.test.ts
import * as assert from 'node:assert';
import { bottomSlot } from '../../tui/view/bottom-slot';
import { rosterRows } from '../../tui/view/roster-rows';
import { transcriptRows } from '../../tui/view/transcript-rows';
import { permission, question, summary, tool } from '../fixtures/protocol';
import type { PaneState } from '../../client-core/reducer';
import type { PermissionRequest, QuestionRequest } from '../../protocol/messages';

const pane = (over: Partial<PaneState> = {}): PaneState => ({
  summary: summary('s1'), items: [], hasMore: false, pending: [], mcpServers: [],
  attachments: [], pendingQuestions: [], ...over,
});
const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };
const ask = (blocking: boolean, id = 'q'): QuestionRequest => ({
  requestId: id, blocking, questions: [{ id: 'a', header: 'h', question: 'q?', multiSelect: false, allowOther: false, secret: false }],
});

suite('tui view: roster rows', () => {
  test('glyph follows status, foreign rows are dim and carry host and pid', () => {
    const rows = rosterRows([
      summary('a', { status: 'running' }),
      summary('b', { status: 'awaiting-approval' }),
      summary('c', { status: 'error' }),
      summary('d', { status: 'idle', owner: { host: 'vscode', pid: 4812 } }),
    ], 'b');
    assert.deepStrictEqual(rows.map((r) => r.glyph), ['●', '!', '✗', '○']);
    assert.deepStrictEqual(rows.map((r) => r.focused), [false, true, false, false]);
    assert.strictEqual(rows[3].dim, true);
    assert.strictEqual(rows[3].suffix, 'vscode·4812');
    assert.strictEqual(rows[0].suffix, undefined);
  });
});

suite('tui view: bottom slot', () => {
  test('composer by default', () => {
    assert.strictEqual(bottomSlot(summary('s1'), pane()).kind, 'composer');
  });
  test('a pending permission takes the slot; a question beats it', () => {
    assert.strictEqual(bottomSlot(summary('s1'), pane({ pending: [perm] })).kind, 'permission');
    assert.strictEqual(bottomSlot(summary('s1'), pane({ pending: [perm], pendingQuestions: [ask(true)] })).kind, 'question');
  });
  test('a blocking question is chosen before a non-blocking one', () => {
    const slot = bottomSlot(summary('s1'), pane({ pendingQuestions: [ask(false, 'n'), ask(true, 'b')] }));
    assert.strictEqual(slot.kind === 'question' && slot.request.requestId, 'b');
  });
  test('a foreign session is read-only even with a stale pending entry', () => {
    const foreign = summary('s1', { owner: { host: 'vscode', pid: 7 } });
    const slot = bottomSlot(foreign, pane({ pending: [perm], summary: foreign }));
    assert.strictEqual(slot.kind, 'foreign');
    assert.strictEqual(slot.kind === 'foreign' && slot.text.includes('vscode (pid 7)'), true);
  });
  test('no summary yet is a composer-less safe default', () => {
    assert.strictEqual(bottomSlot(undefined, undefined).kind, 'composer');
  });
});

suite('tui view: transcript rows', () => {
  test('only the last assistant row streams, and only while running', () => {
    const items = [
      { id: 'a1', ts: 1, role: 'assistant' as const, text: 'one' },
      { id: 'a2', ts: 2, role: 'assistant' as const, text: 'two' },
    ];
    const running = transcriptRows(items, true);
    assert.deepStrictEqual(running.map((r) => r.kind === 'assistant' && r.streaming), [false, true]);
    assert.deepStrictEqual(transcriptRows(items, false).map((r) => r.kind === 'assistant' && r.streaming), [false, false]);
  });
  test('an empty assistant item is skipped', () => {
    assert.strictEqual(transcriptRows([{ id: 'a', ts: 1, role: 'assistant', text: '' }], true).length, 0);
  });
  test('tool children are flattened at depth 1 after their parent', () => {
    const child = tool({ id: 'c1', toolId: 'tc' });
    const rows = transcriptRows([tool({ id: 'p', children: [child] })], false);
    assert.deepStrictEqual(rows.map((r) => (r.kind === 'tool' ? r.depth : -1)), [0, 1]);
  });
  test('permission, error and switch items map to their row kinds', () => {
    const rows = transcriptRows([
      permission({ id: 'p1' }),
      { id: 'e1', ts: 1, role: 'error', message: 'boom' },
      { id: 's1', ts: 1, role: 'switch', kind: 'model', text: 'Model: a → b' },
    ], false);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['permission', 'notice', 'notice']);
  });
  test('a question item keeps its state', () => {
    const rows = transcriptRows([question({ id: 'q1' })], false);
    assert.strictEqual(rows[0].kind === 'question' && rows[0].state, 'pending');
  });
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui view"
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```ts
// src/tui/view/roster-rows.ts
import type { SessionId, SessionStatus, SessionSummary } from '../../protocol/messages';

export interface RosterRow {
  id: SessionId; title: string; glyph: '●' | '○' | '!' | '✗';
  suffix?: string; dim: boolean; focused: boolean;
}

const GLYPH: Record<SessionStatus, RosterRow['glyph']> = {
  running: '●', idle: '○', 'awaiting-approval': '!', error: '✗',
};

export function rosterRows(sessions: SessionSummary[], focusedId: SessionId | null): RosterRow[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.name || s.title,
    glyph: GLYPH[s.status],
    ...(s.owner ? { suffix: `${s.owner.host}·${s.owner.pid}` } : {}),
    dim: s.owner !== undefined,
    focused: s.id === focusedId,
  }));
}
```
```ts
// src/tui/view/bottom-slot.ts
import { ownerReason } from '../../client-core/owner-reason';
import type { PaneState } from '../../client-core/reducer';
import type { PermissionRequest, QuestionRequest, SessionSummary } from '../../protocol/messages';

export type BottomSlot =
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'foreign'; text: string }
  | { kind: 'composer' };

export function bottomSlot(summary: SessionSummary | undefined, pane: PaneState | undefined): BottomSlot {
  const foreign = summary ? ownerReason(summary) : undefined;
  if (summary && !summary.owner && pane) {
    const asks = pane.pendingQuestions;
    const question = asks.find((q) => q.blocking) ?? asks[0];
    if (question) { return { kind: 'question', request: question }; }
    const request = pane.pending[0];
    if (request) { return { kind: 'permission', request }; }
  }
  if (foreign) { return { kind: 'foreign', text: foreign }; }
  return { kind: 'composer' };
}
```
```ts
// src/tui/view/transcript-rows.ts
import { describeTool, type ToolHeader } from '../../client-core/tool-render';
import type { TranscriptItem } from '../../protocol/messages';

export type TranscriptRow =
  | { kind: 'user'; id: string; text: string; fromName?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; header: ToolHeader; state: 'running' | 'ok' | 'error'; depth: number }
  | { kind: 'permission'; id: string; header: ToolHeader; state: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'question'; id: string; state: string; text: string }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string };

function toolRows(item: Extract<TranscriptItem, { role: 'tool' }>, depth: number): TranscriptRow[] {
  const own: TranscriptRow = { kind: 'tool', id: item.id, header: describeTool(item.tool), state: item.state, depth };
  const kids = (item.children ?? []).flatMap((c) => (c.role === 'tool' ? toolRows(c, 1) : []));
  return [own, ...kids];
}

export function transcriptRows(items: TranscriptItem[], running: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const item of items) {
    switch (item.role) {
      case 'user':
        rows.push({ kind: 'user', id: item.id, text: item.text, ...(item.from ? { fromName: item.from.name } : {}) });
        break;
      case 'assistant':
        if (item.text !== '') { rows.push({ kind: 'assistant', id: item.id, text: item.text, streaming: false }); }
        break;
      case 'tool':
        rows.push(...toolRows(item, 0));
        break;
      case 'permission':
        rows.push({ kind: 'permission', id: item.id, header: describeTool(item.tool), state: item.state, ...(item.reason ? { reason: item.reason } : {}) });
        break;
      case 'question':
        rows.push({ kind: 'question', id: item.id, state: item.state, text: item.questions.map((q) => q.question).join(' / ') });
        break;
      case 'error':
        rows.push({ kind: 'notice', id: item.id, tone: 'error', text: item.message });
        break;
      case 'switch':
        rows.push({ kind: 'notice', id: item.id, tone: 'info', text: item.text });
        break;
      case 'compaction':
        rows.push({ kind: 'notice', id: item.id, tone: item.state === 'failed' ? 'error' : 'info', text: `Conversation compaction ${item.state}` });
        break;
      case 'relocation':
        rows.push({ kind: 'notice', id: item.id, tone: 'info', text: `Worktree move offered: ${item.path} (${item.state})` });
        break;
    }
  }
  if (running) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === 'assistant') { rows[i] = { ...row, streaming: true }; break; }
    }
  }
  return rows;
}
```
- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui view" && yarn check-types && yarn lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/unit && git commit -m "feat: pure TUI view models for roster, bottom slot and transcript"
```

---

### Task 8: Keymap

**Files:**
- Create: `src/tui/keymap.ts`
- Test: `src/test/unit/tui-keymap.test.ts`

**Interfaces:**
- Produces:
```ts
export type Zone = 'composer' | 'transcript' | 'roster' | 'approval' | 'question';
export interface KeyInput { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type Action =
  | { do: 'toggle-roster' } | { do: 'new-session' } | { do: 'interrupt' } | { do: 'quit-request' }
  | { do: 'cycle-zone' } | { do: 'cycle-model' } | { do: 'cycle-effort' } | { do: 'cycle-mode' }
  | { do: 'send' } | { do: 'newline' } | { do: 'history-prev' }
  | { do: 'item-next' } | { do: 'item-prev' } | { do: 'toggle-item' } | { do: 'page-up' } | { do: 'page-down' } | { do: 'repin' }
  | { do: 'roster-next' } | { do: 'roster-prev' } | { do: 'roster-focus' } | { do: 'roster-hide' } | { do: 'roster-rename' }
  | { do: 'allow' } | { do: 'deny' } | { do: 'confirm' }
  | { do: 'option-next' } | { do: 'option-prev' } | { do: 'option-toggle' } | { do: 'submit-answers' }
  | { do: 'refresh-catalog' };
export function actionFor(zone: Zone, key: KeyInput, ctx: { running: boolean }): Action | undefined;
```
Bindings (from the spec): Global `Ctrl+B` toggle-roster, `Ctrl+N` new-session, `Ctrl+C` → `interrupt` when `ctx.running` else `quit-request`, `Esc` interrupt (only when running; otherwise undefined), `Ctrl+P` cycle-model, `Ctrl+E` cycle-effort, `Shift+Tab` cycle-mode, `Tab` cycle-zone (not in `approval`/`question` where `Tab` belongs to the prompt). Composer: `Enter` send, `Ctrl+J` and `Alt+Enter` (`meta`+`return`) newline, `Up` history-prev. Transcript: `j` item-next, `k` item-prev, `Enter` toggle-item, `PageUp/PageDown`, `End` repin. Roster: `j`/`k`, `Enter` roster-focus, `x` roster-hide, `r` roster-rename. Approval: `y` allow, `n` deny, `Enter` confirm. Question: `Up`/`Down`, `Space` option-toggle, `Enter` submit-answers. `r` in the empty state is the one non-zone binding: expose `refresh-catalog` for zone `'roster'`-less callers through `actionFor('composer', {name:'r', ctrl:true})`? No: keep it a plain `Ctrl+R` global `refresh-catalog`. OpenTUI names: Enter is `"return"`, arrows `"up"`/`"down"`, `"pageup"`/`"pagedown"`, `"escape"`, `"tab"`, `"space"`.

- [ ] **Step 1: Failing test**

```ts
// src/test/unit/tui-keymap.test.ts
import * as assert from 'node:assert';
import { actionFor } from '../../tui/keymap';

const idle = { running: false };
const busy = { running: true };

suite('tui keymap', () => {
  test('Ctrl+C interrupts a running turn and otherwise asks to quit', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'c', ctrl: true }, busy), { do: 'interrupt' });
    assert.deepStrictEqual(actionFor('composer', { name: 'c', ctrl: true }, idle), { do: 'quit-request' });
  });
  test('Esc interrupts only while running', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'escape' }, busy), { do: 'interrupt' });
    assert.strictEqual(actionFor('composer', { name: 'escape' }, idle), undefined);
  });
  test('composer: Enter sends, Ctrl+J and Alt+Enter insert a newline, Up recalls', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'return' }, idle), { do: 'send' });
    assert.deepStrictEqual(actionFor('composer', { name: 'j', ctrl: true }, idle), { do: 'newline' });
    assert.deepStrictEqual(actionFor('composer', { name: 'return', meta: true }, idle), { do: 'newline' });
    assert.deepStrictEqual(actionFor('composer', { name: 'up' }, idle), { do: 'history-prev' });
  });
  test('a plain letter in the composer is never an action', () => {
    for (const name of ['j', 'k', 'y', 'n', 'x', 'r']) {
      assert.strictEqual(actionFor('composer', { name }, idle), undefined);
    }
  });
  test('transcript, roster, approval and question bindings', () => {
    assert.deepStrictEqual(actionFor('transcript', { name: 'j' }, idle), { do: 'item-next' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'return' }, idle), { do: 'toggle-item' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'end' }, idle), { do: 'repin' });
    assert.deepStrictEqual(actionFor('roster', { name: 'x' }, idle), { do: 'roster-hide' });
    assert.deepStrictEqual(actionFor('roster', { name: 'return' }, idle), { do: 'roster-focus' });
    assert.deepStrictEqual(actionFor('approval', { name: 'y' }, idle), { do: 'allow' });
    assert.deepStrictEqual(actionFor('approval', { name: 'n' }, idle), { do: 'deny' });
    assert.deepStrictEqual(actionFor('question', { name: 'space' }, idle), { do: 'option-toggle' });
    assert.deepStrictEqual(actionFor('question', { name: 'return' }, idle), { do: 'submit-answers' });
  });
  test('Tab cycles zones except inside a prompt', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'tab' }, idle), { do: 'cycle-zone' });
    assert.strictEqual(actionFor('approval', { name: 'tab' }, idle), undefined);
    assert.strictEqual(actionFor('question', { name: 'tab' }, idle), undefined);
  });
  test('global chords', () => {
    assert.deepStrictEqual(actionFor('transcript', { name: 'b', ctrl: true }, idle), { do: 'toggle-roster' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'n', ctrl: true }, idle), { do: 'new-session' });
    assert.deepStrictEqual(actionFor('composer', { name: 'tab', shift: true }, idle), { do: 'cycle-mode' });
    assert.deepStrictEqual(actionFor('composer', { name: 'r', ctrl: true }, idle), { do: 'refresh-catalog' });
  });
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui keymap"
```
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
// src/tui/keymap.ts
export type Zone = 'composer' | 'transcript' | 'roster' | 'approval' | 'question';
export interface KeyInput { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type Action =
  | { do: 'toggle-roster' } | { do: 'new-session' } | { do: 'interrupt' } | { do: 'quit-request' }
  | { do: 'cycle-zone' } | { do: 'cycle-model' } | { do: 'cycle-effort' } | { do: 'cycle-mode' }
  | { do: 'send' } | { do: 'newline' } | { do: 'history-prev' }
  | { do: 'item-next' } | { do: 'item-prev' } | { do: 'toggle-item' } | { do: 'page-up' } | { do: 'page-down' } | { do: 'repin' }
  | { do: 'roster-next' } | { do: 'roster-prev' } | { do: 'roster-focus' } | { do: 'roster-hide' } | { do: 'roster-rename' }
  | { do: 'allow' } | { do: 'deny' } | { do: 'confirm' }
  | { do: 'option-next' } | { do: 'option-prev' } | { do: 'option-toggle' } | { do: 'submit-answers' }
  | { do: 'refresh-catalog' };

const act = <T extends Action['do']>(d: T) => ({ do: d }) as Extract<Action, { do: T }>;

function globalAction(key: KeyInput, zone: Zone, ctx: { running: boolean }): Action | undefined {
  if (key.ctrl) {
    switch (key.name) {
      case 'b': return act('toggle-roster');
      case 'n': return act('new-session');
      case 'c': return ctx.running ? act('interrupt') : act('quit-request');
      case 'p': return act('cycle-model');
      case 'e': return act('cycle-effort');
      case 'r': return act('refresh-catalog');
    }
    return undefined;
  }
  if (key.name === 'escape') { return ctx.running ? act('interrupt') : undefined; }
  if (key.name === 'tab') {
    if (key.shift) { return act('cycle-mode'); }
    return zone === 'approval' || zone === 'question' ? undefined : act('cycle-zone');
  }
  return undefined;
}

export function actionFor(zone: Zone, key: KeyInput, ctx: { running: boolean }): Action | undefined {
  const global = globalAction(key, zone, ctx);
  if (global) { return global; }
  if (key.ctrl && key.name === 'j' && zone === 'composer') { return act('newline'); }
  if (key.ctrl) { return undefined; }
  switch (zone) {
    case 'composer':
      if (key.name === 'return') { return key.meta ? act('newline') : act('send'); }
      if (key.name === 'up') { return act('history-prev'); }
      return undefined;
    case 'transcript':
      switch (key.name) {
        case 'j': return act('item-next');
        case 'k': return act('item-prev');
        case 'return': return act('toggle-item');
        case 'pageup': return act('page-up');
        case 'pagedown': return act('page-down');
        case 'end': return act('repin');
      }
      return undefined;
    case 'roster':
      switch (key.name) {
        case 'j': return act('roster-next');
        case 'k': return act('roster-prev');
        case 'return': return act('roster-focus');
        case 'x': return act('roster-hide');
        case 'r': return act('roster-rename');
      }
      return undefined;
    case 'approval':
      switch (key.name) {
        case 'y': return act('allow');
        case 'n': return act('deny');
        case 'return': return act('confirm');
      }
      return undefined;
    case 'question':
      switch (key.name) {
        case 'up': return act('option-prev');
        case 'down': return act('option-next');
        case 'space': return act('option-toggle');
        case 'return': return act('submit-answers');
      }
      return undefined;
  }
}
```
- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui keymap" && yarn check-types && yarn lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/unit && git commit -m "feat: TUI keymap table"
```

---

### Task 9: TUI store, harness and the roster

First component task. Establishes the harness every later UI test reuses.

**Files:**
- Create: `src/tui/ui/store.tsx`, `src/tui/ui/roster.tsx`, `src/test/tui/harness.tsx`
- Test: `src/test/tui/roster.test.tsx`

**Interfaces:**
- Consumes: `reduce`, `initialState`, `ClientState` (`src/client-core/reducer`), `createDraftStore`, `DraftStore`, `ClientTransport`, `rosterRows`, `HostToWebview`/`WebviewToHost`.
- Produces:
```ts
// store.tsx
export interface TuiStoreValue {
  state: ClientState;
  post(msg: WebviewToHost): void;
  drafts: DraftStore;
  focusedId: SessionId | null;                 // client-local; mirrors host focus
  focus(id: SessionId): void;                  // dispatches local-focus, posts focus-pane, set-layout (single leaf), set-visible [id]
  notice: string | null; setNotice(text: string | null): void;
}
export function TuiStoreProvider(props: { transport: ClientTransport; children: ReactNode }): JSX.Element;
export function useTuiStore(): TuiStoreValue;
// roster.tsx
export function Roster(props: { focused: boolean; onFocusSession(id: SessionId): void }): JSX.Element;
// harness.tsx
export interface Mounted {
  setup: Awaited<ReturnType<typeof testRender>>;
  posted: WebviewToHost[];
  fromHost(...msgs: HostToWebview[]): Promise<void>;   // deliver + renderOnce
  frame(): string;
  press(name: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean }): Promise<void>;
  type(text: string): Promise<void>;
  destroy(): void;
}
export async function mount(ui: ReactNode, size?: { width: number; height: number }): Promise<Mounted>;
export function hydrateMsg(over?: Partial<Extract<HostToWebview, { t: 'hydrate' }>>): HostToWebview;
```
`focus(id)` posts, in order: `{ t: 'set-layout', layout: { root: { kind: 'leaf', sessionId: id, size: 100 }, presets: state.layout.presets, focusedSessionId: id } }`, `{ t: 'set-visible', sessionIds: [id] }`, `{ t: 'focus-pane', sessionId: id }`, and dispatches `{ t: 'local-layout', layout }` and `{ t: 'local-focus', id }` (the reducer actions the webview store already uses). Read `src/client-core/reducer.ts` `ClientAction` once to confirm the exact action names before writing.

- [ ] **Step 1: Write the harness and a failing roster test**

```tsx
// src/test/tui/harness.tsx
import { testRender } from '@opentui/react/test-utils';
import type { ReactNode } from 'react';
import { createLoopback } from '../../client-core/loopback-transport';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';
import { TuiStoreProvider } from '../../tui/ui/store';
import { catalog, singlePaneLayout, snapshot, summary } from '../fixtures/protocol';

export interface Mounted {
  setup: Awaited<ReturnType<typeof testRender>>;
  posted: WebviewToHost[];
  fromHost(...msgs: HostToWebview[]): Promise<void>;
  frame(): string;
  press(name: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean }): Promise<void>;
  type(text: string): Promise<void>;
  destroy(): void;
}

export async function mount(ui: ReactNode, size = { width: 100, height: 30 }): Promise<Mounted> {
  const posted: WebviewToHost[] = [];
  const loop = createLoopback((m) => { posted.push(m); });
  const setup = await testRender(<TuiStoreProvider transport={loop.transport}>{ui}</TuiStoreProvider>, size);
  await setup.renderOnce();
  return {
    setup, posted,
    fromHost: async (...msgs) => { for (const m of msgs) { loop.deliver(m); } await setup.renderOnce(); },
    frame: () => setup.captureCharFrame(),
    press: async (name, mods) => { setup.mockInput.pressKey(name, mods); await setup.renderOnce(); },
    type: async (text) => { setup.mockInput.typeText(text); await setup.renderOnce(); },
    destroy: () => setup.renderer.destroy(),
  };
}

export function hydrateMsg(over: Partial<Extract<HostToWebview, { t: 'hydrate' }>> = {}): HostToWebview {
  const s = snapshot('s1');
  return {
    t: 'hydrate', sessions: [summary('s1')], layout: singlePaneLayout('s1'), snapshots: [s],
    catalog: catalog(), unavailable: [], probing: false, usage: {}, ...over,
  };
}
```
```tsx
// src/test/tui/roster.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { Roster } from '../../tui/ui/roster';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const sessions = [
  summary('a', { name: 'api-fix', status: 'running' }),
  summary('b', { name: 'docs', status: 'awaiting-approval' }),
  summary('c', { name: 'shared', owner: { host: 'vscode', pid: 4812 } }),
];

test('rows show glyph, name and the foreign owner label', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a', { name: 'api-fix' })] }));
  const f = m.frame();
  expect(f).toContain('● api-fix');
  expect(f).toContain('! docs');
  expect(f).toContain('shared');
  expect(f).toContain('vscode·4812');
});

test('j then Enter focuses the second session and posts the visible set', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('return');
  expect(chosen).toEqual(['b']);
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, `store`/`roster` modules missing.

- [ ] **Step 3: Implement the store**

```tsx
// src/tui/ui/store.tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode,
} from 'react';
import { createDraftStore, type DraftStore } from '../../client-core/draft-store';
import { initialState, reduce, type ClientState } from '../../client-core/reducer';
import type { ClientTransport } from '../../client-core/transport';
import type { PaneLayout, SessionId, WebviewToHost } from '../../protocol/messages';

export interface TuiStoreValue {
  state: ClientState;
  post(msg: WebviewToHost): void;
  drafts: DraftStore;
  focusedId: SessionId | null;
  focus(id: SessionId): void;
  notice: string | null;
  setNotice(text: string | null): void;
}

const Ctx = createContext<TuiStoreValue | undefined>(undefined);

export function TuiStoreProvider({ transport, children }: { transport: ClientTransport; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [notice, setNotice] = useState<string | null>(null);
  const draftsRef = useRef<DraftStore | undefined>(undefined);
  if (!draftsRef.current) { draftsRef.current = createDraftStore(); }
  const drafts = draftsRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const off = transport.onMessage((msg) => {
      if (msg.t === 'hydrate') {
        drafts.hydrate(msg.sessions.filter((s): s is typeof s & { draft: string } => s.draft !== undefined).map((s) => [s.id, s.draft]));
      }
      dispatch(msg);
    });
    transport.post({ t: 'ready' });
    return off;
  }, [transport, drafts]);

  const post = useCallback((msg: WebviewToHost) => { transport.post(msg); }, [transport]);

  const focus = useCallback((id: SessionId) => {
    const layout: PaneLayout = {
      root: { kind: 'leaf', sessionId: id, size: 100 },
      presets: stateRef.current.layout.presets,
      focusedSessionId: id,
    };
    transport.post({ t: 'set-layout', layout });
    transport.post({ t: 'set-visible', sessionIds: [id] });
    transport.post({ t: 'focus-pane', sessionId: id });
    dispatch({ t: 'local-layout', layout });
    dispatch({ t: 'local-focus', id });
  }, [transport]);

  const focusedId = state.focusedSessionId ?? null;
  const value = useMemo<TuiStoreValue>(
    () => ({ state, post, drafts, focusedId, focus, notice, setNotice }),
    [state, post, drafts, focusedId, focus, notice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTuiStore(): TuiStoreValue {
  const value = useContext(Ctx);
  if (!value) { throw new Error('useTuiStore must be used inside TuiStoreProvider'); }
  return value;
}
```
If `ClientState` has no `focusedSessionId` (the webview store dispatches `local-focus`, so it should), take the field name the reducer actually sets for that action.

- [ ] **Step 4: Implement the roster**

```tsx
// src/tui/ui/roster.tsx
import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { rosterRows } from '../view/roster-rows';
import { useTuiStore } from './store';

export function Roster({ focused, onFocusSession }: { focused: boolean; onFocusSession(id: SessionId): void }) {
  const { state, focusedId, post } = useTuiStore();
  const rows = rosterRows(state.sessions, focusedId);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  useKeyboard((key) => {
    if (!focused) { return; }
    const action = actionFor('roster', key, { running: false });
    if (!action) { return; }
    const row = rows[cursor];
    if (action.do === 'roster-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action.do === 'roster-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action.do === 'roster-focus' && row) { onFocusSession(row.id); }
    else if (action.do === 'roster-hide' && row) { post({ t: 'close-session', id: row.id }); }
  });

  return (
    <box flexDirection="column" width={26} borderStyle="single" title="sessions">
      {rows.map((row, i) => (
        <text key={row.id} fg={row.dim ? 'gray' : undefined} attributes={focused && i === cursor ? 1 : 0}>
          {`${row.focused ? '▸' : ' '}${row.glyph} ${row.title}${row.suffix ? ` ${row.suffix}` : ''}`}
        </text>
      ))}
      {rows.length === 0 ? <text fg="gray">no sessions yet</text> : null}
    </box>
  );
}
```
Renaming (`r`) is posted from a later task when the dialog exists; here `roster-rename` is deliberately unhandled.

- [ ] **Step 5: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS. If the frame shows `▸● api-fix` rather than `● api-fix` for the focused row, adjust the first assertion to match the focused-marker spacing, not the production code. Add `{ t: 'close-session' }` post coverage in a third test: press `x` on row 0 and assert `m.posted` contains `{ t: 'close-session', id: 'a' }`.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI store, test harness and roster"
```

---

### Task 10: Transcript (scrollback, streaming markdown, tool rows)

**Files:**
- Create: `src/tui/ui/transcript/transcript.tsx`, `src/tui/ui/transcript/row.tsx`, `src/tui/ui/transcript/tool-row.tsx`
- Test: `src/test/tui/transcript.test.tsx`

**Interfaces:**
- Consumes: `transcriptRows`, `describeInput`, `describeOutput`, `clampLines`, `ToolBlock`, `useTuiStore`, `actionFor`.
- Produces:
```tsx
export function Transcript(props: { sessionId: SessionId; focused: boolean }): JSX.Element;
```
Behavior: renders `transcriptRows(pane.items, summary.status === 'running')` in a `<scrollbox stickyScroll stickyStart="bottom" viewportCulling focused={focused}>`; assistant text is `<markdown content streaming>`; user rows are `> text`; tool rows are `▸ <verb> <primary>` with the glyph `▸`/`▾` and a state mark (`…` running, `✗` error); with `focused`, `j`/`k` move a cursor over rows, `Enter` toggles that row's expansion (a `Set<string>` of expanded item ids) and an expanded tool row renders `describeInput` + `describeOutput` blocks beneath the header: `diff` blocks through `<diff>`-free plain lines first (`+`/`-` coloured green/red per line; swap to `<diff>` only if the installed component accepts a unified patch string without extra setup), `command` as `$ text`, `lines` clamped by `clampLines(text, 12, 8)` with a `… N lines hidden …` divider, `note`/`field`/`path` as dim text, `json` clamped the same way. A `pane.hasMore` flag shows a dim `↑ older messages` row at the top and, when the scrollbox is scrolled to the top, posts `{ t: 'load-more', id: sessionId, beforeItemId: pane.items[0].id }` once per distinct first item id. Long unbroken lines wrap (`wrapMode="word"` on `<text>` if the installed API names it differently, use its wrap prop).

- [ ] **Step 1: Failing tests**

```tsx
// src/test/tui/transcript.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { Transcript } from '../../tui/ui/transcript/transcript';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary, tool } from '../fixtures/protocol';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const withItems = (items: TranscriptItem[], status: 'idle' | 'running' = 'idle', hasMore = false) =>
  hydrateMsg({
    sessions: [summary('s1', { status })],
    snapshots: [snapshot('s1', { status, items, hasMore })],
  });

test('user and assistant text render, assistant as markdown', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([
    { id: 'u1', ts: 1, role: 'user', text: 'fix the tests' },
    { id: 'a1', ts: 2, role: 'assistant', text: 'Done. **All green.**' },
  ]));
  expect(m.frame()).toContain('> fix the tests');
  expect(m.frame()).toContain('All green');
});

test('a tool call is one header line until expanded', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1', tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' }, output: { kind: 'text', text: 'line one\nline two' } })]));
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).not.toContain('line two');
  await m.press('j');
  await m.press('return');
  expect(m.frame()).toContain('line two');
  await m.press('return');
  expect(m.frame()).not.toContain('line two');
});

test('a very long output is clamped with a hidden-lines divider', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 100, height: 60 });
  const long = Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\n');
  await m.fromHost(withItems([tool({ id: 't1', output: { kind: 'text', text: long } })]));
  await m.press('j');
  await m.press('return');
  expect(m.frame()).toContain('lines hidden');
  expect(m.frame()).not.toContain('row 40');
});

test('a single enormous line wraps instead of overflowing', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 40, height: 20 });
  await m.fromHost(withItems([{ id: 'a1', ts: 1, role: 'assistant', text: 'x'.repeat(200) }]));
  const widest = Math.max(...m.frame().split('\n').map((l) => l.length));
  expect(widest).toBeLessThanOrEqual(40);
});

test('hasMore shows the older-messages row', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'u1', ts: 1, role: 'user', text: 'hi' }], 'idle', true));
  expect(m.frame()).toContain('older messages');
});

test('a streaming delta appends to the visible assistant text', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'a1', ts: 1, role: 'assistant', text: 'Hel' }], 'running'));
  await m.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'delta', itemId: 'a1', field: 'text', delta: 'lo there' } });
  expect(m.frame()).toContain('Hello there');
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```tsx
// src/tui/ui/transcript/tool-row.tsx
import { clampLines, describeInput, describeOutput, type ToolBlock } from '../../../client-core/tool-render';
import type { ToolCall, ToolOutput } from '../../../protocol/messages';

function clamped(text: string): string[] {
  const c = clampLines(text, 12, 8);
  return c.hidden === 0 ? c.head : [...c.head, `… ${c.hidden} lines hidden …`, ...c.tail];
}

function blockLines(block: ToolBlock): { text: string; fg?: string }[] {
  switch (block.kind) {
    case 'note': return [{ text: block.text, fg: 'gray' }];
    case 'field': return [{ text: `${block.label}: ${block.value}`, fg: 'gray' }];
    case 'command': return [{ text: `$ ${block.text}` }];
    case 'path': return [{ text: block.path, fg: 'gray' }];
    case 'diff': return clamped(block.lines.join('\n')).map((text) => ({
      text, fg: text.startsWith('+') ? 'green' : text.startsWith('-') ? 'red' : undefined,
    }));
    case 'todos': return block.items.map((i) => ({ text: `[${i.status}] ${i.text}` }));
    case 'lines': return clamped(block.text).map((text) => ({ text, fg: block.tone === 'error' ? 'red' : undefined }));
    case 'json': return clamped(block.text).map((text) => ({ text }));
    case 'image': return [{ text: '[image]', fg: 'gray' }];
  }
}

export function ToolBody(props: { tool: ToolCall; output?: ToolOutput; state: 'running' | 'ok' | 'error' }) {
  const blocks = [...describeInput(props.tool), ...describeOutput(props.tool.kind, props.output, props.state)];
  const lines = blocks.flatMap(blockLines);
  return (
    <box flexDirection="column" paddingLeft={4}>
      {lines.map((l, i) => <text key={i} fg={l.fg}>{l.text}</text>)}
    </box>
  );
}
```
```tsx
// src/tui/ui/transcript/row.tsx
import type { TranscriptRow } from '../../view/transcript-rows';

const MARK = { running: '…', ok: '', error: ' ✗' } as const;

export function RowView(props: { row: TranscriptRow; selected: boolean; expanded: boolean }) {
  const { row, selected } = props;
  const bold = selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      return <text attributes={bold}>{`> ${row.fromName ? `[${row.fromName}] ` : ''}${row.text}`}</text>;
    case 'assistant':
      return <markdown content={row.text} streaming={row.streaming} />;
    case 'tool':
      return (
        <text attributes={bold} fg="gray">
          {`${' '.repeat(row.depth * 2)}${props.expanded ? '▾' : '▸'} ${row.header.verb} ${row.header.primary}${MARK[row.state]}`}
        </text>
      );
    case 'permission':
      return <text attributes={bold} fg="yellow">{`? ${row.header.verb} ${row.header.primary} — ${row.state}${row.reason ? ` (${row.reason})` : ''}`}</text>;
    case 'question':
      return <text attributes={bold} fg="yellow">{`? ${row.text} — ${row.state}`}</text>;
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? 'red' : 'gray'}>{row.text}</text>;
  }
}
```
```tsx
// src/tui/ui/transcript/transcript.tsx
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '../../../protocol/messages';
import { actionFor } from '../../keymap';
import { transcriptRows } from '../../view/transcript-rows';
import { useTuiStore } from '../store';
import { RowView } from './row';
import { ToolBody } from './tool-row';

export function Transcript({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state, post } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const rows = useMemo(() => transcriptRows(pane?.items ?? [], running), [pane?.items, running]);
  const [cursor, setCursor] = useState(-1);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef<string | undefined>(undefined);
  const scroll = useRef<{ scrollBy(n: number): void; scrollTo(n: number): void } | null>(null);

  const itemById = useMemo(() => new Map((pane?.items ?? []).flatMap((i) => [[i.id, i] as const, ...((i.role === 'tool' ? i.children ?? [] : []).map((c) => [c.id, c] as const))])), [pane?.items]);

  useEffect(() => {
    const first = pane?.items[0]?.id;
    if (pane?.hasMore && first && asked.current !== first && cursor === 0) {
      asked.current = first;
      post({ t: 'load-more', id: sessionId, beforeItemId: first });
    }
  }, [cursor, pane?.hasMore, pane?.items, post, sessionId]);

  useKeyboard((key) => {
    if (!focused) { return; }
    const action = actionFor('transcript', key, { running });
    if (!action) { return; }
    if (action.do === 'item-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action.do === 'item-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action.do === 'toggle-item') {
      const row = rows[cursor];
      if (row?.kind !== 'tool') { return; }
      setOpen((s) => { const n = new Set(s); if (n.has(row.id)) { n.delete(row.id); } else { n.add(row.id); } return n; });
    }
    else if (action.do === 'repin') { setCursor(-1); scroll.current?.scrollTo(Number.MAX_SAFE_INTEGER); }
  });

  return (
    <scrollbox ref={scroll as never} flexGrow={1} stickyScroll stickyStart="bottom" viewportCulling focused={focused}>
      {pane?.hasMore ? <text fg="gray">↑ older messages</text> : null}
      {rows.map((row, i) => {
        const item = itemById.get(row.id);
        const expanded = open.has(row.id);
        return (
          <box key={row.id} flexDirection="column">
            <RowView row={row} selected={i === cursor} expanded={expanded} />
            {row.kind === 'tool' && expanded && item?.role === 'tool'
              ? <ToolBody tool={item.tool} output={item.output} state={item.state} /> : null}
          </box>
        );
      })}
    </scrollbox>
  );
}
```
If the `hasMore`/`load-more` effect never fires in a test because `cursor === 0` is the wrong trigger for "scrolled to the top", replace it with the scrollbox's own scroll-position callback from the installed types (record it under Deviations) and add a test that scrolling to the top posts exactly one `load-more`.

- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS. Fix prop names from the installed types if `check-types:tui` rejects any (`wrapMode`, `ref` typing, `attributes`); keep the assertions.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI transcript with sticky scroll, streaming markdown and expandable tool rows"
```

---

### Task 11: Composer

**Files:**
- Create: `src/tui/ui/composer.tsx`
- Test: `src/test/tui/composer.test.tsx`

**Interfaces:**
- Consumes: `useTuiStore` (`drafts`, `post`), `promptHistory`, `actionFor`, `QueuedMessage`.
- Produces:
```tsx
export function Composer(props: { sessionId: SessionId; focused: boolean }): JSX.Element;
```
Behavior: a `<textarea>` seeded from `drafts.get(sessionId)`; every content change calls `drafts.set(id, text)` and posts `{ t: 'set-draft', id, text }` (debounced 300 ms, flushed on unmount); `Enter` with non-blank text posts `{ t: 'send', id, text }`, clears the draft and the textarea; blank `Enter` does nothing; `Ctrl+J` / `Alt+Enter` insert `\n`; `Up` when the textarea is empty or the cursor is at the very start recalls the previous entry from `promptHistory(pane.items)` (repeated `Up` walks back, any edit resets the walk); `summary.queued` renders one dim `queued: <text>` line each above the box. While `running`, the placeholder reads `Working… Esc to interrupt`; otherwise `Message — Enter send, Ctrl+J newline`.

- [ ] **Step 1: Failing tests**

```tsx
// src/test/tui/composer.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { Composer } from '../../tui/ui/composer';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

test('Enter posts send with the typed text and clears the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('fix the tests');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send')).toEqual([{ t: 'send', id: 's1', text: 'fix the tests' }]);
  expect(m.frame()).not.toContain('fix the tests');
});

test('a blank Enter sends nothing', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('   ');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('Ctrl+J inserts a newline instead of sending', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('line one');
  await m.press('j', { ctrl: true });
  await m.type('line two');
  expect(m.frame()).toContain('line one');
  expect(m.frame()).toContain('line two');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('Up recalls the previous prompt when the box is empty', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1')],
    snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'earlier prompt' }] })],
  }));
  await m.press('up');
  expect(m.frame()).toContain('earlier prompt');
});

test('queued messages show above the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { status: 'running', queued: [{ id: 'q1', text: 'then run lint' }] })],
    snapshots: [snapshot('s1', { status: 'running', queued: [{ id: 'q1', text: 'then run lint' }] })],
  }));
  expect(m.frame()).toContain('queued: then run lint');
  expect(m.frame()).toContain('Esc to interrupt');
});

test('a draft from the host seeds the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { draft: 'half written' })], snapshots: [snapshot('s1')] }));
  expect(m.frame()).toContain('half written');
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, composer missing.

- [ ] **Step 3: Implement**

```tsx
// src/tui/ui/composer.tsx
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { promptHistory } from '../../client-core/prompt-history';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { useTuiStore } from './store';

export function Composer({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state, post, drafts } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const queued = pane?.summary.queued ?? [];
  const history = useMemo(() => promptHistory(pane?.items ?? []), [pane?.items]);
  const [text, setText] = useState(() => drafts.get(sessionId));
  const walk = useRef(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<{ setText?(t: string): void; insertText?(t: string): void } | null>(null);

  useEffect(() => drafts.subscribe(sessionId, () => {
    const next = drafts.get(sessionId);
    setText(next);
    box.current?.setText?.(next);
  }), [drafts, sessionId]);

  const change = (next: string) => {
    walk.current = -1;
    setText(next);
    drafts.set(sessionId, next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => post({ t: 'set-draft', id: sessionId, text: next }), 300);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const submit = () => {
    const value = text.trim();
    if (value === '') { return; }
    post({ t: 'send', id: sessionId, text: value });
    change('');
    box.current?.setText?.('');
    post({ t: 'set-draft', id: sessionId, text: '' });
  };

  useKeyboard((key) => {
    if (!focused) { return; }
    const action = actionFor('composer', key, { running });
    if (action?.do === 'send') { submit(); }
    else if (action?.do === 'newline') { box.current?.insertText?.('\n'); }
    else if (action?.do === 'history-prev' && text === '' && history.length > 0) {
      walk.current = Math.min(walk.current + 1, history.length - 1);
      const entry = history[walk.current];
      setText(entry);
      box.current?.setText?.(entry);
    }
  });

  return (
    <box flexDirection="column">
      {queued.map((q) => <text key={q.id} fg="gray">{`queued: ${q.text}`}</text>)}
      <textarea
        ref={box as never}
        focused={focused}
        initialValue={text}
        placeholder={running ? 'Working… Esc to interrupt' : 'Message — Enter send, Ctrl+J newline'}
        onContentChange={() => {}}
        onInput={change}
        height={4}
        borderStyle="single"
      />
    </box>
  );
}
```
Textarea API caveat: the docs list `onSubmit`, `keyBindings`, `onContentChange` and the methods `insertText`/`setText`/`undo`. The textarea's own default `Enter` inserts a newline, so bind `Enter` to submit via `keyBindings={[{ name: 'return', action: 'submit' }]}` and `onSubmit={submit}` (and drop the manual `send` branch above) if the installed version supports that; if the content callback is `onContentChange` rather than `onInput`, wire `change` to it and delete the `onInput` line. Whichever combination makes the tests above pass without double-sending is correct; record the final prop names under Deviations.

- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI composer with drafts, history recall, newline chords and queued lines"
```

---

### Task 12: Approval and question prompts

**Files:**
- Create: `src/tui/ui/approval-prompt.tsx`, `src/tui/ui/question-prompt.tsx`
- Test: `src/test/tui/approval-prompt.test.tsx`, `src/test/tui/question-prompt.test.tsx`

**Interfaces:**
- Consumes: `PermissionRequest`, `QuestionRequest`, `QuestionSpec` (`src/providers/types.ts`), `describeTool`, `describeInput`, `actionFor`, `useTuiStore().post`.
- Produces:
```tsx
export function ApprovalPrompt(props: { sessionId: SessionId; request: PermissionRequest; focused: boolean }): JSX.Element;
export function QuestionPrompt(props: { sessionId: SessionId; request: QuestionRequest; focused: boolean }): JSX.Element;
```
Approval: header from `describeTool(request.tool)`, the `describeInput` blocks clamped to ~6 lines, `meta.description`/`meta.decisionReason` when present, and a line `[y] allow  [n] deny`. `y` posts `{ t: 'permission-decision', id, requestId, decision: { allow: true } }`. `n` switches to a one-line reason input (`<input>`); `Enter` there posts `{ allow: false, reason }` (empty reason → `{ allow: false }`), `Esc` returns to the choice. A `Enter` on the choice line while no letter was pressed runs the highlighted option (default highlighted: allow). Question: for each `QuestionSpec` in order — options as a list (`Up`/`Down`, `Space` toggles when `multiSelect`, otherwise `Space`/`Enter` selects the highlighted one and advances), free text via `<input>` when there are no options or when `allowOther` and the user picks "Other…", masked (`●`) when `secret`; after the last question `Enter` posts `{ t: 'question-answer', id, requestId, answers }` where `answers` is `Record<spec.id, string[]>`. Nothing is ever posted twice for one request id (a `sent` ref guards it).

- [ ] **Step 1: Failing tests**

```tsx
// src/test/tui/approval-prompt.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { ApprovalPrompt } from '../../tui/ui/approval-prompt';
import { mount, type Mounted } from './harness';
import type { PermissionRequest } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const req: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf build' } };

test('shows the tool and the keys', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).toContain('rm -rf build');
  expect(m.frame()).toContain('[y] allow');
});

test('y allows exactly once', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('y');
  await m.press('y');
  expect(m.posted.filter((p) => p.t === 'permission-decision')).toEqual([
    { t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: true } },
  ]);
});

test('n then a reason denies with that reason; n then Enter denies without one', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.type('too risky');
  await m.press('return');
  expect(m.posted.find((p) => p.t === 'permission-decision')).toEqual(
    { t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: false, reason: 'too risky' } },
  );
  m.destroy();
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.press('return');
  expect(m.posted.find((p) => p.t === 'permission-decision')).toEqual(
    { t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: false } },
  );
});

test('an unfocused prompt ignores keys', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused={false} />);
  await m.press('y');
  expect(m.posted.some((p) => p.t === 'permission-decision')).toBe(false);
});
```
```tsx
// src/test/tui/question-prompt.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { QuestionPrompt } from '../../tui/ui/question-prompt';
import { mount, type Mounted } from './harness';
import type { QuestionRequest } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const single: QuestionRequest = {
  requestId: 'r1', blocking: true,
  questions: [{ id: 'scope', header: 'Scope', question: 'Which one?', multiSelect: false, allowOther: false, secret: false,
    options: [{ label: 'Cards only', description: 'small' }, { label: 'Both', description: 'shared' }] }],
};
const multi: QuestionRequest = {
  requestId: 'r2', blocking: true,
  questions: [{ id: 'pick', header: 'Pick', question: 'Which?', multiSelect: true, allowOther: false, secret: false,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }] }],
};
const secret: QuestionRequest = {
  requestId: 'r3', blocking: true,
  questions: [{ id: 'key', header: 'Key', question: 'API key?', multiSelect: false, allowOther: false, secret: true }],
};

test('single select: Down then Enter answers with the second label', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={single} focused />);
  expect(m.frame()).toContain('Which one?');
  await m.press('down');
  await m.press('return');
  expect(m.posted.find((p) => p.t === 'question-answer')).toEqual(
    { t: 'question-answer', id: 's1', requestId: 'r1', answers: { scope: ['Both'] } },
  );
});

test('multi select: Space toggles and Enter submits the chosen set', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={multi} focused />);
  await m.press('space');
  await m.press('down');
  await m.press('down');
  await m.press('space');
  await m.press('return');
  expect(m.posted.find((p) => p.t === 'question-answer')).toEqual(
    { t: 'question-answer', id: 's1', requestId: 'r2', answers: { pick: ['A', 'C'] } },
  );
});

test('a secret answer is masked on screen but sent verbatim', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={secret} focused />);
  await m.type('hunter2');
  expect(m.frame()).not.toContain('hunter2');
  await m.press('return');
  expect(m.posted.find((p) => p.t === 'question-answer')).toEqual(
    { t: 'question-answer', id: 's1', requestId: 'r3', answers: { key: ['hunter2'] } },
  );
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```tsx
// src/tui/ui/approval-prompt.tsx
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { clampLines, describeInput, describeTool } from '../../client-core/tool-render';
import type { PermissionRequest, SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { useTuiStore } from './store';

export function ApprovalPrompt(props: { sessionId: SessionId; request: PermissionRequest; focused: boolean }) {
  const { post } = useTuiStore();
  const { request } = props;
  const header = describeTool(request.tool);
  const body = describeInput(request.tool).flatMap((b) =>
    b.kind === 'command' ? [`$ ${b.text}` ] : b.kind === 'diff' ? b.lines : b.kind === 'lines' ? b.text.split('\n') : b.kind === 'path' ? [b.path] : []);
  const shown = clampLines(body.join('\n'), 5, 1);
  const [mode, setMode] = useState<'choose' | 'reason'>('choose');
  const [reason, setReason] = useState('');
  const sent = useRef(false);

  const decide = (decision: { allow: true } | { allow: false; reason?: string }) => {
    if (sent.current) { return; }
    sent.current = true;
    post({ t: 'permission-decision', id: props.sessionId, requestId: request.requestId, decision });
  };

  useKeyboard((key) => {
    if (!props.focused) { return; }
    if (mode === 'reason') {
      if (key.name === 'escape') { setMode('choose'); }
      else if (key.name === 'return') { decide(reason.trim() ? { allow: false, reason: reason.trim() } : { allow: false }); }
      else if (key.name === 'backspace') { setReason((r) => r.slice(0, -1)); }
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) { setReason((r) => r + key.sequence); }
      return;
    }
    const action = actionFor('approval', key, { running: false });
    if (action?.do === 'allow' || action?.do === 'confirm') { decide({ allow: true }); }
    else if (action?.do === 'deny') { setMode('reason'); }
  });

  return (
    <box flexDirection="column" borderStyle="single" title="permission">
      <text fg="yellow">{`${header.verb} ${header.primary}`}</text>
      {request.meta?.description ? <text fg="gray">{request.meta.description}</text> : null}
      {[...shown.head, ...(shown.hidden > 0 ? [`… ${shown.hidden} more …`] : []), ...shown.tail].map((l, i) => <text key={i}>{l}</text>)}
      {mode === 'choose'
        ? <text>[y] allow  [n] deny</text>
        : <text>{`deny reason (Enter to send, Esc back): ${reason}`}</text>}
    </box>
  );
}
```
```tsx
// src/tui/ui/question-prompt.tsx
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import type { QuestionRequest, SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { useTuiStore } from './store';

export function QuestionPrompt(props: { sessionId: SessionId; request: QuestionRequest; focused: boolean }) {
  const { post } = useTuiStore();
  const specs = props.request.questions;
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [text, setText] = useState('');
  const answers = useRef<Record<string, string[]>>({});
  const sent = useRef(false);
  const spec = specs[qi];
  const options = spec?.options ?? [];

  const finishQuestion = (value: string[]) => {
    answers.current[spec.id] = value;
    if (qi < specs.length - 1) { setQi(qi + 1); setCursor(0); setPicked(new Set()); setText(''); return; }
    if (sent.current) { return; }
    sent.current = true;
    post({ t: 'question-answer', id: props.sessionId, requestId: props.request.requestId, answers: answers.current });
  };

  useKeyboard((key) => {
    if (!props.focused || !spec) { return; }
    if (options.length === 0) {
      if (key.name === 'return') { finishQuestion([text]); }
      else if (key.name === 'backspace') { setText((t) => t.slice(0, -1)); }
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) { setText((t) => t + key.sequence); }
      return;
    }
    const action = actionFor('question', key, { running: false });
    if (action?.do === 'option-next') { setCursor((c) => Math.min(c + 1, options.length - 1)); }
    else if (action?.do === 'option-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action?.do === 'option-toggle' && spec.multiSelect) {
      setPicked((s) => { const n = new Set(s); if (n.has(cursor)) { n.delete(cursor); } else { n.add(cursor); } return n; });
    }
    else if (action?.do === 'submit-answers') {
      finishQuestion(spec.multiSelect ? [...picked].sort((a, b) => a - b).map((i) => options[i].label) : [options[cursor].label]);
    }
  });

  if (!spec) { return <text fg="gray">No question.</text>; }
  return (
    <box flexDirection="column" borderStyle="single" title={spec.header}>
      <text>{spec.question}</text>
      {options.map((o, i) => (
        <text key={o.label} attributes={i === cursor ? 1 : 0}>
          {`${i === cursor ? '›' : ' '} ${spec.multiSelect ? (picked.has(i) ? '[x]' : '[ ]') : ''} ${o.label}${o.description ? ` — ${o.description}` : ''}`}
        </text>
      ))}
      {options.length === 0 ? <text>{`> ${spec.secret ? '●'.repeat(text.length) : text}`}</text> : null}
      <text fg="gray">{options.length === 0 ? 'Enter submit' : spec.multiSelect ? 'Space toggle, Enter submit' : 'Up/Down, Enter choose'}</text>
    </box>
  );
}
```
The prompt reads raw key events instead of an `<input>` so it owns the whole keyboard while it is the trapped slot; `key.sequence` carries the typed character. If a test shows `typeText` arriving as `sequence` with `name` set to the character, this works as written; if it arrives differently, adjust only the character-append branch.

- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI approval and question prompts"
```

---

### Task 13: Bottom slot, foreign banner, status line, empty states

**Files:**
- Create: `src/tui/ui/bottom-slot.tsx`, `src/tui/ui/foreign-banner.tsx`, `src/tui/ui/status-line.tsx`, `src/tui/ui/empty-state.tsx`, `src/tui/ui/notice-line.tsx`
- Test: `src/test/tui/bottom-slot.test.tsx`, `src/test/tui/empty-state.test.tsx`

**Interfaces:**
- Consumes: `bottomSlot`, `unavailabilityFor`, `ApprovalPrompt`, `QuestionPrompt`, `Composer`, `useTuiStore`.
- Produces:
```tsx
export function BottomSlotView(props: { sessionId: SessionId; focused: boolean }): JSX.Element;
export function StatusLine(props: { sessionId: SessionId | null; width: number }): JSX.Element;
export function EmptyState(props: { pendingPrompt?: string; loginCommands: Record<string, string> }): JSX.Element;
export function NoticeLine(): JSX.Element;      // renders store.notice, dim; null when absent
```
- `StatusLine` shows `provider · model · effort · mode` from the focused session's summary and the provider's display name from `state.catalog`; when `summary.contextPercent`-style data is absent it shows nothing extra (no tokens ever). It also shows `restart to apply config changes` when the store's `notice` says so.
- `EmptyState` covers, in order: probing (`state.probing !== false && state.catalog.length === 0` → "Checking providers…"), no providers enabled (`catalog` empty, `unavailable` empty, probing false → "No provider is enabled. Run `marcode config` to enable one."), providers unavailable (each `displayName: reason` plus `loginCommands[id]` when present, `Ctrl+R to re-check`), and no sessions (catalog available → a provider list with `Ctrl+N` hint). `pendingPrompt` is shown as `Your prompt is kept: <text>` so a `marcode "…"` on a broken install is never silently lost.

- [ ] **Step 1: Failing tests**

```tsx
// src/test/tui/bottom-slot.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { BottomSlotView } from '../../tui/ui/bottom-slot';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const perm = { requestId: 'r1', tool: { kind: 'command' as const, label: 'Bash', command: 'rm -rf x' } };

test('a pending permission replaces the composer and the draft survives the round trip', async () => {
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('half a thought');
  expect(m.frame()).toContain('half a thought');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm] }) });
  expect(m.frame()).toContain('[y] allow');
  expect(m.frame()).not.toContain('half a thought');
  await m.press('y');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pending: [] }) });
  expect(m.frame()).toContain('half a thought');
});

test('a foreign session shows the banner and no composer', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner })] }));
  expect(m.frame()).toContain('Running in vscode (pid 4812). Read-only here.');
  await m.type('hello');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('when the owner lets go the banner turns back into a composer', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner })] }));
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s1')] });
  expect(m.frame()).not.toContain('Read-only here');
  await m.type('now mine');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(true);
});
```
```tsx
// src/test/tui/empty-state.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { EmptyState } from '../../tui/ui/empty-state';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

test('probing says so and makes no diagnosis', async () => {
  m = await mount(<EmptyState loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], catalog: [], probing: true }));
  expect(m.frame()).toContain('Checking providers');
  expect(m.frame()).not.toContain('marcode config');
});

test('nothing enabled points at the config command', async () => {
  m = await mount(<EmptyState loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], catalog: [], unavailable: [], probing: false }));
  expect(m.frame()).toContain('marcode config');
});

test('an unavailable provider shows its reason, its login command and the kept prompt', async () => {
  m = await mount(<EmptyState pendingPrompt="fix the tests" loginCommands={{ claude: 'claude auth login' }} />);
  await m.fromHost(hydrateMsg({
    sessions: [], snapshots: [], catalog: [], probing: false,
    unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'not signed in' }],
  }));
  expect(m.frame()).toContain('Claude: not signed in');
  expect(m.frame()).toContain('marcode login claude');
  expect(m.frame()).toContain('Your prompt is kept: fix the tests');
});
```
Note the login hint is the `marcode login <id>` subcommand, never the raw vendor command: `EmptyState` renders `marcode login ${id}` for any provider whose id is a key of `loginCommands` (the map's value is shown only in the `marcode login` failure output, Task 16).

- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```tsx
// src/tui/ui/bottom-slot.tsx
import type { SessionId } from '../../protocol/messages';
import { bottomSlot } from '../view/bottom-slot';
import { ApprovalPrompt } from './approval-prompt';
import { Composer } from './composer';
import { ForeignBanner } from './foreign-banner';
import { QuestionPrompt } from './question-prompt';
import { useTuiStore } from './store';

export function BottomSlotView({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state } = useTuiStore();
  const pane = state.byId[sessionId];
  const slot = bottomSlot(pane?.summary ?? state.sessions.find((s) => s.id === sessionId), pane);
  switch (slot.kind) {
    case 'question': return <QuestionPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'permission': return <ApprovalPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'foreign': return <ForeignBanner text={slot.text} />;
    case 'composer': return <Composer sessionId={sessionId} focused={focused} />;
  }
}
```
```tsx
// src/tui/ui/foreign-banner.tsx
export function ForeignBanner({ text }: { text: string }) {
  return (
    <box borderStyle="single">
      <text fg="gray">{text}</text>
    </box>
  );
}
```
```tsx
// src/tui/ui/notice-line.tsx
import { useTuiStore } from './store';

export function NoticeLine() {
  const { notice } = useTuiStore();
  return notice ? <text fg="yellow">{notice}</text> : null;
}
```
```tsx
// src/tui/ui/status-line.tsx
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export function StatusLine({ sessionId, width }: { sessionId: SessionId | null; width: number }) {
  const { state } = useTuiStore();
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg="gray">{'no session — Ctrl+N new'}</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const parts = [provider, s.model, s.effort, s.permissionMode].filter((p): p is string => Boolean(p));
  const line = parts.join(' · ');
  return <text fg="gray">{line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line}</text>;
}
```
```tsx
// src/tui/ui/empty-state.tsx
import { useTuiStore } from './store';

export function EmptyState({ pendingPrompt, loginCommands }: { pendingPrompt?: string; loginCommands: Record<string, string> }) {
  const { state } = useTuiStore();
  const lines: string[] = [];
  if (state.catalog.length === 0) {
    if (state.probing !== false) { lines.push('Checking providers…'); }
    else if (state.unavailable.length === 0) { lines.push('No provider is enabled. Run `marcode config` to enable one.'); }
    else {
      for (const p of state.unavailable) {
        lines.push(`${p.displayName}: ${p.reason}`);
        if (p.id in loginCommands) { lines.push(`  run: marcode login ${p.id}`); }
      }
      lines.push('Press Ctrl+R to check again.');
    }
  } else {
    lines.push('No sessions yet. Press Ctrl+N to start one:');
    for (const p of state.catalog) { lines.push(`  ${p.displayName}`); }
  }
  if (pendingPrompt) { lines.push(`Your prompt is kept: ${pendingPrompt}`); }
  return (
    <box flexDirection="column" padding={1}>
      {lines.map((l, i) => <text key={i} fg={i === 0 ? undefined : 'gray'}>{l}</text>)}
    </box>
  );
}
```
- [ ] **Step 4: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS. The draft-survival test is the one most likely to fail: `Composer` unmounts when the slot changes, so its `useState` seed must come from `drafts.get(sessionId)` (it does) and `change()` must have written the draft before the unmount; if the frame lacks the text, flush `drafts.set` synchronously on every change (already done) and check the debounce timer is not the only writer.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI bottom slot, foreign banner, status line and empty states"
```

---

### Task 14: New-session dialog, pickers and the launch plan

**Files:**
- Create: `src/tui/view/launch.ts`, `src/tui/ui/new-session-dialog.tsx`, `src/tui/view/cycle.ts`
- Test: `src/test/unit/tui-launch.test.ts`, `src/test/tui/new-session-dialog.test.tsx`

**Interfaces:**
- Produces:
```ts
// view/launch.ts
export type LaunchPlan =
  | { kind: 'wait' }                                     // not hydrated or still probing with nothing to go on
  | { kind: 'resume'; sessionId: SessionId }
  | { kind: 'create'; providerId: string; model?: string; seed?: { text: string } }
  | { kind: 'empty'; pendingPrompt?: string };           // nothing to run on, explain
export function launchPlan(args: {
  ready: boolean; probing: boolean; sessions: SessionSummary[]; catalog: ProviderInfo[];
  layout: PaneLayout; prompt?: string; forceNew: boolean;
}): LaunchPlan;
// view/cycle.ts
export function nextModel(catalog: ProviderInfo[], s: SessionSummary): string | undefined;
export function nextEffort(catalog: ProviderInfo[], s: SessionSummary): EffortLevel | undefined;
export function nextMode(catalog: ProviderInfo[], s: SessionSummary): PermissionMode | undefined;
// new-session-dialog.tsx
export function NewSessionDialog(props: {
  cwd: string; initialPrompt?: string; onClose(): void; onCreated(): void;
}): JSX.Element;
```
`launchPlan` rules: not `ready` → `wait`. `forceNew` or a `prompt`: needs a catalog provider — none and `probing` → `wait`, none and settled → `{ kind: 'empty', pendingPrompt: prompt }`, else `{ kind: 'create', providerId: catalog[0].id, model: catalog[0].models[0]?.id, seed: prompt ? { text: prompt } : undefined }`. Otherwise (resume): the layout's `focusedSessionId` if it is in `sessions`, else the first leaf session id in `layout.root` that is in `sessions`, else the most recent session by `updatedAt`; no sessions at all → settled-and-no-catalog `empty`, settled-with-catalog `empty` (the empty state offers Ctrl+N), still probing with no sessions `wait`. The default provider for a quick create is the provider of the most recently updated session when it is in the catalog, else `catalog[0]`. Cyclers: `nextModel` picks the next model id (wrapping) of the session's provider; `nextEffort` the next level of that model's `effort.levels` (undefined when the model has none); `nextMode` the next of the provider's `permissionModes` ids, **never advancing into `bypass`** (it is creation-only on the wire) and returning `undefined` when only one mode remains.

- [ ] **Step 1: Failing tests**

```ts
// src/test/unit/tui-launch.test.ts
import * as assert from 'node:assert';
import { launchPlan } from '../../tui/view/launch';
import { nextEffort, nextMode, nextModel } from '../../tui/view/cycle';
import { catalog, singlePaneLayout, summary } from '../fixtures/protocol';

const base = { ready: true, probing: false, sessions: [summary('a', { updatedAt: 5 }), summary('b', { updatedAt: 9 })], catalog: catalog(), layout: singlePaneLayout('a'), forceNew: false };

suite('tui launch plan', () => {
  test('waits until hydrated', () => {
    assert.strictEqual(launchPlan({ ...base, ready: false }).kind, 'wait');
  });
  test('resumes the focused session, else the first layout leaf, else the newest', () => {
    assert.deepStrictEqual(launchPlan({ ...base, layout: { ...singlePaneLayout('a'), focusedSessionId: 'b' } }), { kind: 'resume', sessionId: 'b' });
    assert.deepStrictEqual(launchPlan(base), { kind: 'resume', sessionId: 'a' });
    assert.deepStrictEqual(launchPlan({ ...base, layout: singlePaneLayout('gone') }), { kind: 'resume', sessionId: 'b' });
  });
  test('a prompt or --new creates with the default provider and seeds the prompt', () => {
    const plan = launchPlan({ ...base, prompt: 'fix the tests' });
    assert.strictEqual(plan.kind, 'create');
    assert.deepStrictEqual(plan.kind === 'create' && plan.seed, { text: 'fix the tests' });
    assert.strictEqual(launchPlan({ ...base, forceNew: true }).kind, 'create');
  });
  test('with no available provider the prompt is kept in an empty plan, never dropped', () => {
    assert.deepStrictEqual(launchPlan({ ...base, catalog: [], prompt: 'go' }), { kind: 'empty', pendingPrompt: 'go' });
  });
  test('still probing with nothing to go on waits', () => {
    assert.strictEqual(launchPlan({ ...base, catalog: [], sessions: [], probing: true }).kind, 'wait');
  });
  test('no sessions and a ready catalog is the empty state', () => {
    assert.deepStrictEqual(launchPlan({ ...base, sessions: [] }), { kind: 'empty' });
  });
});

suite('tui cyclers', () => {
  const s = summary('a', { providerId: 'fake', model: 'fake-large' });
  test('model wraps around the provider list', () => {
    const next = nextModel(catalog(), s);
    assert.strictEqual(typeof next, 'string');
  });
  test('permission mode never advances into bypass', () => {
    const cat = catalog();
    cat[0].permissionModes = [{ id: 'default' }, { id: 'plan' }, { id: 'bypass' }] as never;
    assert.strictEqual(nextMode(cat, { ...s, permissionMode: 'default' }), 'plan');
    assert.strictEqual(nextMode(cat, { ...s, permissionMode: 'plan' }), 'default');
  });
  test('effort is undefined for a model without levels', () => {
    const cat = catalog();
    cat[0].models = [{ id: 'fake-large', displayName: 'L' }];
    assert.strictEqual(nextEffort(cat, s), undefined);
  });
});
```
- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui launch|tui cyclers"
```
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement the pure part**

```ts
// src/tui/view/launch.ts
import { leafSessionIds } from '../../client-core/layout-tree';
import type { PaneLayout, ProviderInfo, SessionId, SessionSummary } from '../../protocol/messages';

export type LaunchPlan =
  | { kind: 'wait' }
  | { kind: 'resume'; sessionId: SessionId }
  | { kind: 'create'; providerId: string; model?: string; seed?: { text: string } }
  | { kind: 'empty'; pendingPrompt?: string };

export function launchPlan(a: {
  ready: boolean; probing: boolean; sessions: SessionSummary[]; catalog: ProviderInfo[];
  layout: PaneLayout; prompt?: string; forceNew: boolean;
}): LaunchPlan {
  if (!a.ready) { return { kind: 'wait' }; }
  const newest = [...a.sessions].sort((x, y) => y.updatedAt - x.updatedAt)[0];
  if (a.forceNew || a.prompt) {
    const provider = a.catalog.find((p) => p.id === newest?.providerId) ?? a.catalog[0];
    if (!provider) { return a.probing ? { kind: 'wait' } : { kind: 'empty', pendingPrompt: a.prompt }; }
    return {
      kind: 'create', providerId: provider.id, model: provider.models[0]?.id,
      ...(a.prompt ? { seed: { text: a.prompt } } : {}),
    };
  }
  const known = new Set(a.sessions.map((s) => s.id));
  const focused = a.layout.focusedSessionId;
  if (focused && known.has(focused)) { return { kind: 'resume', sessionId: focused }; }
  const leaf = leafSessionIds(a.layout.root).find((id) => known.has(id));
  if (leaf) { return { kind: 'resume', sessionId: leaf }; }
  if (newest) { return { kind: 'resume', sessionId: newest.id }; }
  return a.catalog.length === 0 && a.probing ? { kind: 'wait' } : { kind: 'empty' };
}
```
```ts
// src/tui/view/cycle.ts
import type { ProviderInfo, SessionSummary } from '../../protocol/messages';
import type { EffortLevel, PermissionMode } from '../../providers/types';

function after<T>(list: T[], current: T | undefined): T | undefined {
  if (list.length === 0) { return undefined; }
  const i = current === undefined ? -1 : list.indexOf(current);
  return list[(i + 1) % list.length];
}

export function nextModel(catalog: ProviderInfo[], s: SessionSummary): string | undefined {
  const ids = catalog.find((p) => p.id === s.providerId)?.models.map((m) => m.id) ?? [];
  return ids.length < 2 ? undefined : after(ids, s.model);
}

export function nextEffort(catalog: ProviderInfo[], s: SessionSummary): EffortLevel | undefined {
  const levels = catalog.find((p) => p.id === s.providerId)?.models.find((m) => m.id === s.model)?.effort?.levels ?? [];
  return levels.length < 2 ? undefined : after(levels, s.effort);
}

export function nextMode(catalog: ProviderInfo[], s: SessionSummary): PermissionMode | undefined {
  const modes = (catalog.find((p) => p.id === s.providerId)?.permissionModes ?? []).map((m) => m.id).filter((m) => m !== 'bypass');
  return modes.length < 2 ? undefined : after(modes, s.permissionMode);
}
```
If `ModelInfo`-level aliases mean `s.model` is a wire id not present in the list, `after` starts from the first entry; that is acceptable.

- [ ] **Step 4: Failing dialog test, then the component**

```tsx
// src/test/tui/new-session-dialog.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { NewSessionDialog } from '../../tui/ui/new-session-dialog';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

test('Enter creates a session with the highlighted provider and the launch cwd', async () => {
  let created = 0;
  m = await mount(<NewSessionDialog cwd="/repo/pkg" onClose={() => {}} onCreated={() => { created++; }} />);
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('New session');
  await m.press('return');
  const msg = m.posted.find((p) => p.t === 'create-session');
  expect(msg?.t === 'create-session' && msg.providerId).toBe('fake');
  expect(msg?.t === 'create-session' && msg.cwd).toBe('/repo/pkg');
  expect(created).toBe(1);
});

test('Esc closes without creating', async () => {
  let closed = 0;
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => { closed++; }} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  await m.press('escape');
  expect(closed).toBe(1);
  expect(m.posted.some((p) => p.t === 'create-session')).toBe(false);
});
```
```tsx
// src/tui/ui/new-session-dialog.tsx
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { useTuiStore } from './store';

export function NewSessionDialog(props: { cwd: string; initialPrompt?: string; onClose(): void; onCreated(): void }) {
  const { state, post } = useTuiStore();
  const providers = state.catalog;
  const [pi, setPi] = useState(0);
  const [mi, setMi] = useState(0);
  const [step, setStep] = useState<'provider' | 'model'>('provider');
  const provider = providers[pi];
  const models = provider?.models ?? [];

  useKeyboard((key) => {
    if (key.name === 'escape') { props.onClose(); return; }
    if (!provider) { return; }
    const list = step === 'provider' ? providers.length : models.length;
    const move = (d: number) => (step === 'provider' ? setPi : setMi)((i) => Math.max(0, Math.min(list - 1, i + d)));
    if (key.name === 'down' || key.name === 'j') { move(1); }
    else if (key.name === 'up' || key.name === 'k') { move(-1); }
    else if (key.name === 'return') {
      if (step === 'provider' && models.length > 1) { setStep('model'); return; }
      post({
        t: 'create-session', providerId: provider.id, cwd: props.cwd, model: models[mi]?.id,
        ...(props.initialPrompt ? { seed: { text: props.initialPrompt } } : {}),
      });
      props.onCreated();
    }
  });

  return (
    <box flexDirection="column" borderStyle="double" title="New session" padding={1}>
      {providers.length === 0 ? <text fg="gray">No provider available.</text> : null}
      {step === 'provider'
        ? providers.map((p, i) => <text key={p.id} attributes={i === pi ? 1 : 0}>{`${i === pi ? '›' : ' '} ${p.displayName}`}</text>)
        : models.map((mo, i) => <text key={mo.id} attributes={i === mi ? 1 : 0}>{`${i === mi ? '›' : ' '} ${mo.displayName}`}</text>)}
      <text fg="gray">{`${props.cwd} — Enter create, Esc cancel`}</text>
    </box>
  );
}
```
The fixture catalog's `fake` provider must have exactly one model for the first test's single `Enter` to create immediately; if `catalog()` has two, press `return` twice in the test. Effort and permission mode default on the host (`create-session` leaves them optional), so "last choice" persistence is a deliberate follow-up, not part of this task.

- [ ] **Step 5: Run to verify**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui launch|tui cyclers" && yarn test:tui:raw && yarn check-types && yarn check-types:tui && yarn lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test && git commit -m "feat: TUI launch plan, cyclers and new-session dialog"
```

---

### Task 15: App composition, entry point and lifecycle

**Files:**
- Create: `src/tui/ui/app.tsx`, `src/tui/ui/main.tsx`
- Test: `src/test/tui/app.test.tsx`

**Interfaces:**
- Consumes: everything above; `bootHost`, `parseArgs`, `launchPlan`, `nextModel/nextEffort/nextMode`, `actionFor`.
- Produces:
```tsx
export interface AppProps {
  launchCwd: string; prompt?: string; forceNew: boolean;
  loginCommands: Record<string, string>;
  onQuit(): void;
}
export function App(props: AppProps): JSX.Element;      // inside TuiStoreProvider
```
`App` layout: `useTerminalDimensions()`; wide (`width >= 100`) shows `<Roster>` as a left column when the roster is toggled on (default on), narrower renders it as an overlay only while toggled on (default off). Right column: `Transcript` (flexGrow), `BottomSlotView`, `StatusLine`, `NoticeLine`. Zone state `'composer' | 'transcript' | 'roster'` (a prompt in the bottom slot forces the zone to `composer`, i.e. the prompt owns the keyboard); `Tab` cycles; `Ctrl+B` toggles; `Ctrl+N` opens `NewSessionDialog`; `Ctrl+C` / `Esc` → `interrupt` post when running; a first idle `Ctrl+C` sets notice "Press Ctrl+C again to quit" for 2 s, a second within that window calls `onQuit`; `Ctrl+P/E/Shift+Tab` post `set-model`/`set-effort`/`set-permission-mode` from the cyclers (and do nothing when the cycler returns `undefined`); `Ctrl+R` posts `refresh-catalog`; the roster's `onFocusSession` calls `focus(id)`. A launch effect runs `launchPlan` once the first time its kind is not `wait`: `resume` → `focus(sessionId)`; `create` → post `create-session` (cwd = `launchCwd`, `seed` as given) then, when the host answers with `session-snapshot`, `focus` it (watch `state.byId` for a session id not seen before); `empty` → render `EmptyState`. With no focused session the body is `EmptyState`.

`main.tsx`: parse args → on `login`/`config`/`migrate` call the Task 16 handlers and exit; on `help`/`error` print and exit (error → code 2); on `run`: `bootHost` inside try/catch (failure → one stderr line `marcode: <message>`, exit 1, **no renderer yet**), then `createCliRenderer()`, `createRoot(renderer).render(<TuiStoreProvider transport={booted.loopback.transport}><App …/></TuiStoreProvider>)`, install `process.on('SIGINT'|'SIGTERM')`, `uncaughtException`, `unhandledRejection` handlers that call one idempotent `shutdown(code)`: `renderer.destroy()` first, then `booted.shutdown()` raced against a 3 s timeout, then `process.exit(code)`; a second signal during shutdown calls `process.exit(130)` immediately. The `notify` passed to `bootHost` before the renderer exists writes to stderr; once mounted, warnings go to the store's `setNotice` through a `warnings` array bridge (render each `booted.warnings` entry as the initial notice).

- [ ] **Step 1: Failing tests**

```tsx
// src/test/tui/app.test.tsx
import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };

test('resumes the last session and posts the single-leaf visible set', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'api-fix' })],
    snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'hello there' }] })],
  }));
  expect(m.frame()).toContain('hello there');
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds.length === 1 && p.sessionIds[0] === 's1')).toBe(true);
});

test('a prompt argument creates a session in the launch cwd with the prompt as seed', async () => {
  m = await mount(<App {...props} prompt="fix the tests" />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  const create = m.posted.find((p) => p.t === 'create-session');
  expect(create?.t === 'create-session' && create.cwd).toBe('/repo');
  expect(create?.t === 'create-session' && create.seed?.text).toBe('fix the tests');
});

test('a prompt argument with no provider is kept on screen, not sent', async () => {
  m = await mount(<App {...props} prompt="fix the tests" />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], catalog: [], unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'not signed in' }], probing: false }));
  expect(m.posted.some((p) => p.t === 'create-session')).toBe(false);
  expect(m.frame()).toContain('Your prompt is kept: fix the tests');
});

test('Ctrl+C while idle needs a second press to quit', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg());
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.frame()).toContain('Press Ctrl+C again');
  await m.press('c', { ctrl: true });
  expect(quit).toBe(1);
});

test('Ctrl+C during a running turn interrupts instead of quitting', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running' })] }));
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.posted.some((p) => p.t === 'interrupt' && p.id === 's1')).toBe(true);
});

test('Ctrl+B toggles the roster and focusing another session posts set-visible for it', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
    snapshots: [snapshot('s1')],
  }));
  expect(m.frame()).toContain('two');
  await m.press('b', { ctrl: true });
  expect(m.frame()).not.toContain('two');
  await m.press('b', { ctrl: true });
  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds[0] === 's2')).toBe(true);
});

test('a terminal narrower than 40 columns still renders without throwing', async () => {
  m = await mount(<App {...props} />, { width: 30, height: 12 });
  await m.fromHost(hydrateMsg());
  expect(m.frame().length).toBeGreaterThan(0);
});

test('a resize while streaming keeps the newest text visible', async () => {
  m = await mount(<App {...props} />, { width: 100, height: 14 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running', items: [{ id: 'a1', ts: 1, role: 'assistant', text: 'start' }] })] }));
  await m.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'delta', itemId: 'a1', field: 'text', delta: '\n'.repeat(30) + 'the newest line' } });
  m.setup.resize(70, 12);
  await m.setup.renderOnce();
  expect(m.frame()).toContain('the newest line');
});
```
`setup.resize` is the test renderer's resize method; if the installed one is named differently, use that. The Tab-twice navigation in the roster test lands on the roster zone (composer → transcript → roster); if the zone order differs, adjust the count, not the zone order the spec fixes.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: FAIL, `App` missing.

- [ ] **Step 3: Implement `app.tsx`** following the interface description above. Keep it under ~250 lines: zone state, `useKeyboard` global handler built on `actionFor` with the current zone, the launch effect, and the layout. Split the key handler into `src/tui/ui/use-app-keys.ts` if the file passes 250 lines.

```tsx
// src/tui/ui/app.tsx (structure; fill with the behavior listed in the task text)
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { actionFor, type Zone } from '../keymap';
import { launchPlan } from '../view/launch';
import { nextEffort, nextMode, nextModel } from '../view/cycle';
import { BottomSlotView } from './bottom-slot';
import { EmptyState } from './empty-state';
import { NewSessionDialog } from './new-session-dialog';
import { NoticeLine } from './notice-line';
import { Roster } from './roster';
import { StatusLine } from './status-line';
import { useTuiStore } from './store';
import { Transcript } from './transcript/transcript';

export interface AppProps {
  launchCwd: string; prompt?: string; forceNew: boolean;
  loginCommands: Record<string, string>; onQuit(): void;
}

const ZONES: Zone[] = ['composer', 'transcript', 'roster'];

export function App(props: AppProps) {
  const { state, post, focus, focusedId, setNotice } = useTuiStore();
  const { width } = useTerminalDimensions();
  const wide = width >= 100;
  const [rosterOn, setRosterOn] = useState<boolean | undefined>(undefined);
  const showRoster = rosterOn ?? wide;
  const [zone, setZone] = useState<Zone>('composer');
  const [dialog, setDialog] = useState(false);
  const planned = useRef(false);
  const quitArmed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seen = useRef<Set<string>>(new Set());
  const awaitingCreate = useRef(false);

  const summary = focusedId ? state.byId[focusedId]?.summary ?? state.sessions.find((s) => s.id === focusedId) : undefined;
  const running = summary?.status === 'running';
  const plan = launchPlan({
    ready: state.ready, probing: state.probing !== false, sessions: state.sessions, catalog: state.catalog,
    layout: state.layout, prompt: props.prompt, forceNew: props.forceNew,
  });

  useEffect(() => {
    if (planned.current || plan.kind === 'wait') { return; }
    planned.current = true;
    state.sessions.forEach((s) => seen.current.add(s.id));
    if (plan.kind === 'resume') { focus(plan.sessionId); }
    else if (plan.kind === 'create') {
      awaitingCreate.current = true;
      post({ t: 'create-session', providerId: plan.providerId, cwd: props.launchCwd, model: plan.model, ...(plan.seed ? { seed: plan.seed } : {}) });
    }
  }, [plan.kind, state.ready]);

  useEffect(() => {
    if (!awaitingCreate.current) { return; }
    const fresh = state.sessions.find((s) => !seen.current.has(s.id));
    if (fresh) { awaitingCreate.current = false; focus(fresh.id); }
  }, [state.sessions]);

  const slotForcesComposer = Boolean(focusedId && ((state.byId[focusedId]?.pending.length ?? 0) > 0 || (state.byId[focusedId]?.pendingQuestions.length ?? 0) > 0));
  const activeZone: Zone = slotForcesComposer ? 'composer' : zone;

  useKeyboard((key) => {
    if (dialog) { return; }
    const action = actionFor(activeZone, key, { running });
    if (!action) { return; }
    switch (action.do) {
      case 'toggle-roster': setRosterOn(!showRoster); return;
      case 'new-session': setDialog(true); return;
      case 'cycle-zone': setZone(ZONES[(ZONES.indexOf(zone) + 1) % ZONES.length]); return;
      case 'interrupt': if (focusedId) { post({ t: 'interrupt', id: focusedId }); } return;
      case 'quit-request':
        if (quitArmed.current) { props.onQuit(); return; }
        setNotice('Press Ctrl+C again to quit');
        quitArmed.current = setTimeout(() => { quitArmed.current = undefined; setNotice(null); }, 2000);
        return;
      case 'refresh-catalog': post({ t: 'refresh-catalog' }); return;
      case 'cycle-model': { const v = summary && nextModel(state.catalog, summary); if (focusedId && v) { post({ t: 'set-model', id: focusedId, model: v }); } return; }
      case 'cycle-effort': { const v = summary && nextEffort(state.catalog, summary); if (focusedId && v) { post({ t: 'set-effort', id: focusedId, effort: v }); } return; }
      case 'cycle-mode': { const v = summary && nextMode(state.catalog, summary); if (focusedId && v) { post({ t: 'set-permission-mode', id: focusedId, mode: v }); } return; }
      default: return;
    }
  });

  const body = focusedId ? (
    <box flexDirection="column" flexGrow={1}>
      <Transcript sessionId={focusedId} focused={activeZone === 'transcript'} />
      <BottomSlotView sessionId={focusedId} focused={activeZone === 'composer'} />
    </box>
  ) : (
    <EmptyState pendingPrompt={plan.kind === 'empty' ? plan.pendingPrompt : props.prompt} loginCommands={props.loginCommands} />
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        {showRoster ? <Roster focused={activeZone === 'roster'} onFocusSession={focus} /> : null}
        {body}
      </box>
      <StatusLine sessionId={focusedId} width={width} />
      <NoticeLine />
      {dialog ? <NewSessionDialog cwd={props.launchCwd} onClose={() => setDialog(false)} onCreated={() => { setDialog(false); awaitingCreate.current = true; state.sessions.forEach((s) => seen.current.add(s.id)); }} /> : null}
    </box>
  );
}
```
Two checks while wiring: (1) the `create-session` message's `seed` field shape must match `WebviewToHost` (`seed: { text: string; ... }`, see `messages.ts`), (2) `launchPlan`'s `empty` plan must not re-fire the effect (the `planned` ref guards it). In the narrow-terminal case the roster is an overlay only when toggled; do not reserve a column for it.

- [ ] **Step 4: Implement `main.tsx`** per the description.

```tsx
// src/tui/ui/main.tsx
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { bootHost, type Booted } from '../boot';
import { parseArgs, USAGE } from '../cli';
import { runLogin, runConfig, runMigrate } from '../subcommands';
import { App } from './app';
import { TuiStoreProvider } from './store';

async function main(): Promise<void> {
  const cmd = parseArgs(process.argv.slice(2));
  if (cmd.kind === 'help') { console.log(USAGE); return; }
  if (cmd.kind === 'error') { console.error(`marcode: ${cmd.message}\n${USAGE}`); process.exitCode = 2; return; }
  if (cmd.kind === 'login') { process.exitCode = await runLogin(cmd.provider, process.cwd()); return; }
  if (cmd.kind === 'config') { process.exitCode = await runConfig(); return; }
  if (cmd.kind === 'migrate') { process.exitCode = await runMigrate(cmd.oldDir, process.cwd()); return; }

  let booted: Booted;
  try {
    booted = await bootHost({ cwd: process.cwd(), notify: (m) => console.error(`marcode: ${m}`) });
  } catch (err) {
    console.error(`marcode: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) { process.exit(130); }
    closing = true;
    try { renderer.destroy(); } catch { /* terminal already restored */ }
    await Promise.race([booted.shutdown(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(code);
  };
  process.on('SIGINT', () => { void shutdown(130); });
  process.on('SIGTERM', () => { void shutdown(143); });
  process.on('uncaughtException', (err) => { console.error(`marcode: ${err.stack ?? err.message}`); void shutdown(1); });
  process.on('unhandledRejection', (err) => { console.error(`marcode: ${String(err)}`); void shutdown(1); });

  const loginCommands = Object.fromEntries([...booted.host.loginRecipes].map(([id, r]) => [id, r.command]));
  createRoot(renderer).render(
    <TuiStoreProvider transport={booted.loopback.transport}>
      <App launchCwd={booted.launchCwd} prompt={cmd.prompt} forceNew={cmd.forceNew} loginCommands={loginCommands} onQuit={() => { void shutdown(0); }} />
    </TuiStoreProvider>,
  );
}

void main();
```
`exitOnCtrlC: false` stops OpenTUI from quitting on its own `Ctrl+C`; if the option is named differently in the installed version, use that name. Boot warnings are written to stderr before the renderer starts; surfacing them in the notice line is a deliberate follow-up.

- [ ] **Step 5: Run to verify**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw && yarn check-types:tui && yarn lint
```
Expected: PASS. Then a manual launch from a scratch folder to see the empty state and a clean exit: `cd /e/Efebia/hiiiid-code && bun src/tui/ui/main.tsx` (with `MARCODE_HOME` pointed at a temp dir); press `Ctrl+C` twice and confirm the terminal is restored.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/tui && git commit -m "feat: TUI app composition, launch flow, entry point and lifecycle"
```

---

### Task 16: Subcommands (`login`, `config`, `migrate`)

**Files:**
- Create: `src/tui/subcommands.ts`
- Test: `src/test/unit/tui-subcommands.test.ts`

**Interfaces:**
- Consumes: `bootHost`-free pieces only: `marcodeHome`, `configPath`, `loadConfig`, `createHost`'s `loginRecipes` (needs a host), `migrateStorage` (read `src/host/migrate-storage.ts` for its exported function and signature first), `resolveWorkspaceDir`, `findGitRoot`.
- Produces:
```ts
export async function runLogin(providerId: string, cwd: string, io?: SubIo): Promise<number>;
export async function runConfig(io?: SubIo): Promise<number>;
export async function runMigrate(oldDir: string, cwd: string, io?: SubIo): Promise<number>;
export interface SubIo {
  home?: string;
  out: (line: string) => void; err: (line: string) => void;
  spawn: (command: string, env: NodeJS.ProcessEnv) => Promise<number>;   // runs through the shell with inherited stdio
  editor: () => string | undefined;                                     // $VISUAL || $EDITOR
}
```
`runLogin`: boot a host with `notify` to `io.err`, find `loginRecipes.get(providerId)`; absent → `err("no sign-in flow for <id>; known: a, b")`, return 1; present → `await io.spawn(recipe.command, recipe.env)` and return its code; always dispose the host. `runConfig`: ensure the file exists (`seedConfigFileSafely(file, {})` creates `{}`), then if `io.editor()` is set spawn `${editor} "${file}"`, else print the path and return 0. `runMigrate`: resolve the workspace dir for `findGitRoot(cwd)` and call the existing migration function with `oldDir`; print "Imported N sessions" or the failure message; return 0/1.

- [ ] **Step 1: Read the existing migration entry point**

```bash
cd /e/Efebia/hiiiid-code && grep -n "export" src/host/migrate-storage.ts
```

- [ ] **Step 2: Failing tests**

```ts
// src/test/unit/tui-subcommands.test.ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runConfig, runLogin, type SubIo } from '../../tui/subcommands';

suite('tui subcommands', () => {
  let tmp: string;
  setup(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-sub-'))); });
  teardown(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const io = (over: Partial<SubIo> = {}) => {
    const out: string[] = []; const err: string[] = []; const ran: string[] = [];
    const base: SubIo = {
      home: path.join(tmp, 'home'),
      out: (l) => out.push(l), err: (l) => err.push(l),
      spawn: async (c) => { ran.push(c); return 0; },
      editor: () => undefined,
      ...over,
    };
    return { base, out, err, ran };
  };

  test('login for an unknown provider lists the known ones and exits 1', async () => {
    const t = io();
    const code = await runLogin('nope', tmp, t.base);
    assert.strictEqual(code, 1);
    assert.strictEqual(t.err.some((l) => l.includes('no sign-in flow for nope')), true);
    assert.strictEqual(t.ran.length, 0);
  });

  test('login for claude runs its recipe command with inherited stdio', async () => {
    const t = io();
    const code = await runLogin('claude', tmp, t.base);
    assert.strictEqual(code, 0);
    assert.strictEqual(t.ran.some((c) => c.includes('auth login')), true);
  });

  test('config creates the file and prints its path when no editor is set', async () => {
    const t = io();
    const code = await runConfig(t.base);
    assert.strictEqual(code, 0);
    assert.strictEqual(t.out.some((l) => l.endsWith('config.json')), true);
    await fs.access(path.join(tmp, 'home', 'config.json'));
  });

  test('config opens the editor when one is set', async () => {
    const t = io({ editor: () => 'vim' });
    await runConfig(t.base);
    assert.strictEqual(t.ran.some((c) => c.startsWith('vim ')), true);
  });
});
```
- [ ] **Step 3: Run to verify it fails**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui subcommands"
```
Expected: FAIL, module missing.

- [ ] **Step 4: Implement**

```ts
// src/tui/subcommands.ts
import { spawn } from 'node:child_process';
import { configPath, seedConfigFileSafely } from '../host/config-file';
import { marcodeHome } from '../host/workspace-dir';
import { bootHost } from './boot';

export interface SubIo {
  home?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  spawn: (command: string, env: NodeJS.ProcessEnv) => Promise<number>;
  editor: () => string | undefined;
}

export const realIo: SubIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  spawn: (command, env) => new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', env });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  }),
  editor: () => process.env.VISUAL || process.env.EDITOR || undefined,
};

export async function runLogin(providerId: string, cwd: string, io: SubIo = realIo): Promise<number> {
  const booted = await bootHost({
    cwd, home: io.home, notify: io.err,
    config: { memory: { enabled: false, summarizer: undefined } },
  });
  try {
    const recipe = booted.host.loginRecipes.get(providerId);
    if (!recipe) {
      io.err(`marcode: no sign-in flow for ${providerId}; known: ${[...booted.host.loginRecipes.keys()].join(', ') || 'none'}`);
      return 1;
    }
    return await io.spawn(recipe.command, recipe.env);
  } finally {
    await booted.shutdown();
  }
}

export async function runConfig(io: SubIo = realIo): Promise<number> {
  const file = configPath(io.home ?? marcodeHome());
  const seeded = await seedConfigFileSafely(file, {});
  if (seeded.warning) { io.err(`marcode: ${seeded.warning}`); return 1; }
  const editor = io.editor();
  if (!editor) { io.out(file); return 0; }
  return io.spawn(`${editor} "${file}"`, process.env);
}
```
`seedConfigFileSafely(file, {})` writes `{}` only when the file is absent, so an existing config is never touched. For `runMigrate`, add (after reading the real function in step 1):

```ts
// appended to src/tui/subcommands.ts; replace migrateStorage/its args with the real names from step 1
import { resolveWorkspaceDir } from '../host/workspace-dir';
import { migrateStorage } from '../host/migrate-storage';
import { findGitRoot } from './workspace-root';

export async function runMigrate(oldDir: string, cwd: string, io: SubIo = realIo): Promise<number> {
  const dir = await resolveWorkspaceDir(io.home ?? marcodeHome(), await findGitRoot(cwd));
  const result = await migrateStorage(oldDir, dir);
  io.out(JSON.stringify(result));
  return 0;
}
```
and make it return 1 with `io.err(<reason>)` when the real function reports failure; add one test with a temp old dir holding a valid `index.json` and no sessions, expecting exit 0, and one with a missing dir, expecting exit 1.

- [ ] **Step 5: Run to verify it passes**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit:raw --grep "tui subcommands" && yarn check-types && yarn lint
```
Expected: PASS. The `claude` login test depends on `enabledProviders` defaulting to include `claude`, which it does; if the host fails to construct `ClaudeProvider` in CI without the SDK binary, set `config: { enabledProviders: ['claude'] }` explicitly.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui src/test/unit && git commit -m "feat: marcode login, config and migrate subcommands"
```

---

### Task 17: End-to-end tests with a real host

**Files:**
- Create: `src/test/tui/e2e.test.tsx`, `src/test/tui/e2e-harness.tsx`

**Interfaces:**
- Consumes: `bootHost`, `App`, `TuiStoreProvider`, `testRender`, `createHost` (second host for the foreign case), the FakeProvider's scripted replies (`'permission fixture'` raises a Read permission, text containing `rm` raises a Bash permission, anything else replies `ok`).
- Produces: `mountBooted(opts): Promise<{ booted: Booted; frame(): string; press...; type...; destroy(): Promise<void> }>` mounting `App` over a real `bootHost` on a temp `MARCODE_HOME`.

- [ ] **Step 1: Write the e2e harness and tests**

```tsx
// src/test/tui/e2e-harness.tsx
import { testRender } from '@opentui/react/test-utils';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootHost, type Booted } from '../../tui/boot';
import { App } from '../../tui/ui/app';
import { TuiStoreProvider } from '../../tui/ui/store';

export async function mountBooted(opts: { home?: string; cwd?: string; prompt?: string } = {}) {
  const tmp = opts.home ? undefined : await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-e2e-')));
  const home = opts.home ?? path.join(tmp as string, 'home');
  const cwd = opts.cwd ?? (tmp as string);
  const booted: Booted = await bootHost({
    cwd, home, config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
  });
  const setup = await testRender(
    <TuiStoreProvider transport={booted.loopback.transport}>
      <App launchCwd={cwd} prompt={opts.prompt} forceNew={false} loginCommands={{}} onQuit={() => {}} />
    </TuiStoreProvider>,
    { width: 110, height: 32 },
  );
  const settle = async (ms = 150) => { await new Promise((r) => setTimeout(r, ms)); await setup.renderOnce(); };
  await settle();
  return {
    booted, home, settle,
    frame: () => setup.captureCharFrame(),
    press: async (k: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean }) => { setup.mockInput.pressKey(k, mods); await settle(60); },
    type: async (t: string) => { setup.mockInput.typeText(t); await settle(60); },
    destroy: async () => { setup.renderer.destroy(); await booted.shutdown(); if (tmp) { await fs.rm(tmp, { recursive: true, force: true }); } },
  };
}
```
```tsx
// src/test/tui/e2e.test.tsx
import { afterEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';
import { mountBooted } from './e2e-harness';

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
let m: Mounted | undefined;
let other: HostHandle | undefined;
afterEach(async () => { await other?.dispose(); other = undefined; await m?.destroy(); m = undefined; });

test('a prompt argument starts a session and the fake provider answers', async () => {
  m = await mountBooted({ prompt: 'hello fake' });
  await m.settle(600);
  expect(m.frame()).toContain('hello fake');
  expect(m.frame()).toContain('ok');
});

test('a command that needs permission shows the prompt and y lets the turn finish', async () => {
  m = await mountBooted({ prompt: 'please rm the build folder' });
  await m.settle(600);
  expect(m.frame()).toContain('[y] allow');
  await m.press('y');
  await m.settle(400);
  expect(m.frame()).not.toContain('[y] allow');
});

test('a session owned by another host on the same workspace is read-only here', async () => {
  m = await mountBooted();
  const dir = await resolveWorkspaceDir(m.home, m.booted.workspaceRoot);
  other = await createHost({
    workspaceDir: dir, hostKind: 'vscode', workspaceRoots: () => [m!.booted.workspaceRoot], emit: () => {},
    notify: { warn: () => {} }, pollMs: 20,
    config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
  });
  await other.init();
  const s = await other.manager.create('fake', m.booted.workspaceRoot);
  s.send('written elsewhere');
  await new Promise((r) => setTimeout(r, 300));
  await other.manager.persistNow();
  await m.booted.host.manager.syncRoster();
  await m.settle(300);
  await m.press('b', { ctrl: true });
  await m.press('b', { ctrl: true });
  expect(m.frame()).toContain('vscode');
  expect(path.basename(dir).length).toBeGreaterThan(0);
});
```
- [ ] **Step 2: Run, then fix what the real host reveals**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui:raw
```
Expected: the first two PASS once `App`'s launch effect is correct against a real host. For the foreign test, if focusing the foreign row is needed to see the banner, extend it: `Tab`,`Tab`, move the cursor to the foreign row with `j`, `return`, then `expect(m.frame()).toContain('Read-only here')` and assert no `send` reaches the owner's JSONL by `await m.type('x'); await m.press('return')` followed by checking the session file size is unchanged (mirror `two-hosts.test.ts`). Any divergence between the fake-fixture tests and the real host is a bug in the earlier task; fix it there with its own commit (`fix:`), not by loosening this test.

- [ ] **Step 3: Full gate**

```bash
cd /e/Efebia/hiiiid-code && yarn test:tui && yarn test:unit && yarn test:dom && yarn check-types && yarn check-types:tui && yarn lint
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/test/tui && git commit -m "test: TUI end-to-end over a real host, approvals and foreign sessions"
```

---

### Task 18: Build, binaries, docs and the manual smoke checklist

**Files:**
- Create: `scripts/build-tui.mjs`, `docs/tui.md`
- Modify: `package.json` (scripts), `AGENTS.md` (architecture table, Build and Tests paragraphs), `.gitignore` (`bin/`)

**Interfaces:**
- Produces: `yarn build:tui` → `dist/tui.js` (Bun ESM bundle); `yarn build:tui:bin` → `bin/marcode[.exe]` for the current platform.

- [ ] **Step 1: The build script**

```js
// scripts/build-tui.mjs   usage: node scripts/build-tui.mjs [--compile]
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const compile = process.argv.includes('--compile');
const bun = process.platform === 'win32' ? 'bun.exe' : 'bun';
const args = compile
  ? ['build', '--compile', 'src/tui/ui/main.tsx', '--outfile', process.platform === 'win32' ? 'bin/marcode.exe' : 'bin/marcode']
  : ['build', 'src/tui/ui/main.tsx', '--target', 'bun', '--outfile', 'dist/tui.js'];
const res = spawnSync(bun, args, { stdio: 'inherit', shell: false });
process.exit(res.status ?? 1);
```
`package.json` scripts: `"build:tui": "node scripts/build-tui.mjs"`, `"build:tui:bin": "node scripts/build-tui.mjs --compile"`. Add `bin/` to `.gitignore`. `@anthropic-ai/claude-agent-sdk` and the other host dependencies are bundled by Bun; if `bun build` cannot resolve one of the providers' dynamic `import()` calls, mark it `--external` and record it under Deviations (the compiled binary then needs it installed; decide with the user before shipping).

- [ ] **Step 2: Build and smoke the binary**

```bash
cd /e/Efebia/hiiiid-code && yarn build:tui && yarn build:tui:bin && MARCODE_HOME=$(mktemp -d) ./bin/marcode --help
```
Expected: usage text, exit 0 (`bin/marcode.exe` on Windows).

- [ ] **Step 3: Write `docs/tui.md`** covering: what it is, install/run (`marcode`, `marcode "<prompt>"`, `--new`, `login`, `config`, `migrate`), the keymap table from the spec, how it shares sessions with VS Code (leases, read-only foreign sessions, restart for config changes), the Bun runtime requirement and why, and this **manual smoke checklist** (Windows Terminal plus one macOS or Linux terminal): resize narrower than 100 columns and back; paste a multi-line block into the composer; `Ctrl+J` and `Alt+Enter` newline; colours legible on a light theme; `Ctrl+C` while running interrupts, twice while idle quits and the shell prompt is intact; run a session in VS Code on the same folder and watch it appear as `vscode·<pid>` read-only; `Esc` interrupts; an approval answered with `y` and with `n` plus a reason; `marcode login claude` hands over the terminal and returns.

- [ ] **Step 4: Update `AGENTS.md`**: add rows to the architecture table for `src/client-core/`, `src/tui/` (boot, keymap, view models, subcommands) and `src/tui/ui/`; add one line to **Build** (the TUI is a Bun/ESM build, not an esbuild bundle) and to **Tests** (`yarn test:tui`, guarded; pure TUI logic stays on mocha); add the invariant "Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM."

- [ ] **Step 5: Final gates**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui && yarn run compile && yarn test:unit && yarn test:dom && yarn test:tui
```
Expected: all green; `dist/extension.js` unchanged in behavior.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add scripts docs AGENTS.md package.json .gitignore && git commit -m "feat: TUI build, compiled binary, docs and smoke checklist"
```

---

## Deviations

(Record here, as you go, every OpenTUI prop or API name that differed from the docs and was corrected from the installed types, and any `--external` decision from Task 18.)

- Task 4: `testRender` is async as documented and `onInput` is the right prop, but a bare `mockInput.typeText` does not flush React state updates (React act environment is on); wrap it as `await act(async () => { await setup.mockInput.typeText(...) })` with `act` from `react`. A harmless "Root inside a test was not wrapped in act(...)" warning still prints on stderr.
- Task 9: the Task 4 stderr act() warning was not a typing problem. `testRender` sets `IS_REACT_ACT_ENVIRONMENT` true itself but resets it to false on destroy, and the renderer's destroy listener unmounts the React root outside any `act`. The harness re-enables the flag on every `mount` and wraps `renderer.destroy()` in `act`; a bun preload or a module-level flag alone does not silence it. `fromHost`/`press`/`type` run inside `await act(async ...)` then `renderOnce()`.
- Task 9: `mockInput.pressKey` takes `KeyCodes` names (`RETURN`, `ARROW_UP`) or literal characters, not the lowercase `key.name` the app sees (`return`, `up`); the harness `press` maps the lowercase names. `<box>` needs `border` alongside `borderStyle` to draw a frame; `useKeyboard`'s event has `name`/`ctrl`/`meta`/`shift`, matching `KeyInput`.
- Task 10: `<markdown>` requires a `syntaxStyle` prop (`SyntaxStyle.create()` from `@opentui/core`); it renders in the test renderer without tree-sitter assets (inline `**` markers stay literal there). It lays out asynchronously, so a first frame is blank until a later render: tests wait a tick and render once more. `<text>` wrap prop is `wrapMode="word"`. `viewportCulling` works in tests. The scrollbox ref is a `ScrollBoxRenderable`: "scrolled to top" is `scrollTop <= 0` (content that fits the viewport also counts), checked after every render and after `k`/`pageup`; `cursor === 0` was dropped. Scrolling up stops the sticky follow by itself (scrollbox's manual-scroll state); verified by test. `pageup`/`pagedown` use `scrollBy(±0.5, 'viewport')`, `end` uses `scrollTo(MAX_SAFE_INTEGER)`, `j`/`k` use `scrollChildIntoView(rowId)` (each row box carries `id=row.id`).
- Task 11: `<textarea>` defaults are Enter=newline, Alt+Enter=submit, linefeed=newline, so the composer passes `keyBindings` (return/kpenter -> submit, meta+return/kpenter -> newline, linefeed -> newline); the textarea itself does send/newline via `onSubmit`, and the composer's `useKeyboard` only handles Up (history), so exactly one path sends. Content callback is `onContentChange` (no payload; read `ref.plainText`), there is no `onInput`. Ref is a `TextareaRenderable`: `setText`, `gotoBufferEnd`, `plainText`, `cursorOffset`, `logicalCursor.row`; `setText` fires `onContentChange`, so programmatic sets are tracked to avoid resetting the history walk. OpenTUI delivers Ctrl+J as `linefeed` (ctrl=false): keymap composer zone maps it to newline (ctrl+j rule kept), harness `press` aliases `linefeed` to `LINEFEED`. A pending draft is flushed (not dropped) on unmount. Up recalls only when empty, cursor offset 0, or already walking on row 0.
- Task 12: typed characters reach `useKeyboard` with `name` = the lowercase letter, `shift` for capitals and `sequence` = the literal character (space has name `space`, sequence `" "`), so prompts append `key.sequence` through `ui/key-text.ts`; `typeText` delivers several keys inside one act, so text state must use functional updates (the brief's `setText(t + c)` over a stale closure kept only the last character). A lone `escape` is held back by the input parser until its disambiguation timeout, so tests wait ~100ms and render before asserting. `allowOther` adds an "Other…" row after the options (single: Enter/Space opens free text; multi: Space opens it, Enter commits it into the chosen set); Esc in that text returns to the list.

## Self-Review Notes (for the reviewer)

- Spec coverage: client-core + transport (2, 3); toolchain, guards (4); CLI, workspace key (5); boot/in-process host (6); roster, bottom slot, transcript rows, keymap (7, 8); store + visible-set posting (9); transcript scrollback/markdown/tool expand/load-more (10); composer/drafts/newline chords/history/queued (11); approvals and questions (12); foreign banner, status line, empty states (13); launch/new session/cyclers (14); app, lifecycle, signals (15); login/config/migrate (16); e2e incl. foreign (17); binaries, docs, smoke (18). Bun spike gate (1).
- Spec item deliberately deferred and recorded: "effort and permission mode default to your last choice" in the new-session dialog (Task 14, final paragraph); boot warnings shown in the notice line (Task 15); `r` rename in the roster (Task 9).
