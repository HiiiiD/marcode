# Agent Manager Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension whose secondary-sidebar panel runs several coding-agent sessions at once, in resizable split panes, with tool approvals in the UI and transcripts that survive a reload.

**Architecture:** The extension host owns all session state; the webview is a rendering client over `postMessage`. Agents sit behind an `AgentProvider` interface — a `FakeProvider` drives development and tests, and the Claude Agent SDK implementation lands last. Transcripts persist as per-session JSONL under `context.storageUri`.

**Tech Stack:** TypeScript, esbuild (two bundles: node/CJS host, browser/IIFE webview), React 19, Tailwind v4, shadcn (`message-scroller`, `resizable`), `@anthropic-ai/claude-agent-sdk`, mocha (unit) + `@vscode/test-cli` (integration).

Spec: [docs/superpowers/specs/2026-08-13-vscode-agent-manager-design.md](../specs/2026-08-13-vscode-agent-manager-design.md)

## Global Constraints

- **Filenames are kebab-case** throughout, including React components (`session-list.tsx`, not `SessionList.tsx`). Component *identifiers* stay PascalCase.
- **`src/protocol/messages.ts` is types-only.** No runtime code, no `import ... from 'vscode'`. It is the only module both bundles import.
- **No module under `src/providers/` or `src/protocol/` may import `vscode`.** Keeps them unit-testable outside the extension host.
- **The webview loads no remote resources.** No CDN scripts, styles, fonts, or images. Everything is bundled into `dist/` and referenced via `webview.asWebviewUri()`.
- **CSP:** `default-src 'none'`; scripts and styles restricted to `webview.cspSource` plus a per-load nonce. `localResourceRoots` pinned to `dist/`.
- **`retainContextWhenHidden` stays off.** Durable state lives in the host.
- **Use shadcn components, never raw HTML controls.** No bare `<select>`, `<button>`, or `<textarea>` in feature code — use `Select`, `Button`, `Textarea`, `DropdownMenu` from `@/components/ui/*`. shadcn's registry is **Base UI**-backed (`@base-ui/react`), not Radix; import parts from the vendored file and do not mix in Radix packages.
- **Use the short Tailwind utilities** — `border-border`, `bg-muted`, `text-muted-foreground`. The `@theme inline` block in `src/webview/index.css` registers every token under the `--color-*` namespace, so `[var(--…)]` arbitrary values are never needed and must not appear in component code.
- **Every protocol message addressed to a session carries an explicit `SessionId`.** There is no implicit "current session" on the wire.
- **Errors are state, never exceptions across `postMessage`.** A failing provider puts a session into `error` with a transcript item; it never rejects into the message handler.
- **Extension host target:** VS Code `^1.125.0`, Node 22 (`@types/node` 24.x is already a devDependency).
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/extension.ts` | `activate()`: construct manager + store, register the webview view |
| `src/protocol/messages.ts` | Shared wire types. Types only. |
| `src/providers/types.ts` | `AgentProvider`, `AgentRun`, `AgentEvent`, `ModelInfo` |
| `src/providers/fake/fake-provider.ts` | Scripted provider for tests and the walking skeleton |
| `src/providers/claude/claude-provider.ts` | Claude Agent SDK adapter |
| `src/providers/claude/map-events.ts` | `SDKMessage` → `AgentEvent` |
| `src/host/transcript-store.ts` | `index.json` + per-session JSONL; append, load, page |
| `src/host/agent-session.ts` | One conversation: transcript, status, pending approvals |
| `src/host/session-manager.ts` | Roster; create/close/delete; patch fan-out to visible set |
| `src/host/panel-view-provider.ts` | `WebviewViewProvider`; HTML + nonce; protocol translation |
| `src/webview/main.tsx` | React root |
| `src/webview/vscode-api.ts` | `acquireVsCodeApi` wrapper, typed post/subscribe |
| `src/webview/store.tsx` | Client state: sessions, layout, catalog; reducer over `HostToWebview` |
| `src/webview/components/*.tsx` | Panes, transcript, composer, permission card, roster |
| `src/webview/components/ui/*.tsx` | Vendored shadcn primitives |

---

## Parallelization

Tasks are numbered for reading order, not execution order. The host chain and the webview chain are independent until Task 13, so they can run concurrently.

```
T1 (build + shell) ──┬─→ T9 (vendor ui) ──────────────┐
                     │                                 │
T2 (provider seam) ──┴─→ T3 (protocol) ─┬─→ T4 ─→ T5 ─┼─→ T6 ─→ T7 ──┐
                     │                  │              │              │
                     │                  └─→ T8 ────────┼─→ T10 ─→ T11 ┤
                     │                                 │        └→ T12┤
                     └─→ T14a (claude adapter) ────────┴──────────────┴─→ T13 ─→ T14b ─→ T15
```

| Wave | Run concurrently | Why they don't collide |
|---|---|---|
| 1 | **T1**, **T2** | T1 owns build config + `src/host/` + `src/webview/`; T2 owns `src/providers/` |
| 2 | **T3**, **T9** | `src/protocol/` vs `src/webview/components/ui/` |
| 3 | **T4**, **T8** | `src/host/transcript-store.ts` vs `src/webview/reducer.ts` |
| 4 | **T5**, **T10**, **T14a** | host / webview components / `src/providers/claude/` |
| 5 | **T6**, **T11** | `src/host/session-manager.ts` vs `src/webview/components/` |
| 6 | **T7**, **T12** | `src/host/message-router.ts` vs `permission-card.tsx` |
| 7 | **T13** | alone — it reconciles `main.tsx` and `extension.ts` |
| 8 | **T14b** | wiring only |
| 9 | **T15** | docs and packaging |

Nine waves instead of fifteen serial tasks.

**Split Task 14 to make wave 4 work.** It is the longest task and mostly self-contained:

- **T14a** — Steps 1–6: install the SDK, read the `.d.ts`, write `map-events.ts` + its tests, write `claude-provider.ts`. Touches only `src/providers/claude/`, `src/test/unit/`, and adds one dependency.
- **T14b** — Steps 7–8: register the provider in `extension.ts` and mark it external in `esbuild.js`. Must follow T13.

**Files with more than one writer — never edit these in two concurrent tasks:**

| File | Written by | Rule |
|---|---|---|
| `package.json` | T1, T9, T14a, T15 | Dependency adds only; T1 owns `contributes`, T15 owns `walkthroughs` |
| `esbuild.js` | T1, T9, T14b | T1 creates both configs; T9 adds `alias`; T14b adds `external` |
| `src/extension.ts` | T1, T7, T13, T14b | Serial by construction — these are in different waves |
| `src/webview/main.tsx` | T1, T8, T10, T13 | T13 writes the final version; earlier ones are scaffolding |

Everything in `package.json` outside `contributes` is an append, so concurrent dependency adds resolve trivially even when git reports a conflict.

If running each wave in its own worktree, merge the wave before starting the next — the dependency edges above assume the previous wave is on disk.

---

## Task 1: Webview renders in the sidebar

Proves the gating constraint from the spec — a React webview a user can drag into the secondary sidebar — and lays the build pipeline every later task depends on.

**Files:**
- Modify: `package.json` (deps, `contributes`, scripts)
- Modify: `esbuild.js` (add webview bundle)
- Modify: `tsconfig.json` (JSX, DOM lib, path alias)
- Modify: `.vscode-test.mjs` (integration glob)
- Modify: `src/extension.ts`
- Create: `src/host/panel-view-provider.ts`
- Create: `src/webview/main.tsx`, `src/webview/index.css`
- Create: `src/test/integration/extension.test.ts` (replaces `src/test/extension.test.ts`)

**Interfaces:**
- Produces: `class PanelViewProvider implements vscode.WebviewViewProvider` with `static readonly viewType = 'hiiiid-code.panel'` and `resolveWebviewView(view: vscode.WebviewView): void`.

- [ ] **Step 1: Install dependencies**

```bash
yarn add react react-dom
yarn add -D @types/react @types/react-dom tailwindcss @tailwindcss/cli mocha
```

- [ ] **Step 2: Add the view container and view to `package.json`**

Replace the `contributes` block and add scripts. `activationEvents` stays `[]` — the view contribution activates the extension on its own.

```json
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "hiiiid-code",
          "title": "HiiiiD Code",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "hiiiid-code": [
        {
          "id": "hiiiid-code.panel",
          "name": "Sessions",
          "type": "webview"
        }
      ]
    }
  },
```

Extend the ESLint file glob in `eslint.config.mjs` to cover `.tsx`, or `src/webview/main.tsx` and every later component is silently unlinted while `yarn run lint` still reports green:

```js
    files: ["**/*.ts", "**/*.tsx"],
```

Add to `scripts`:

```json
    "build:css": "tailwindcss -i src/webview/index.css -o dist/webview.css",
    "watch:css": "tailwindcss -i src/webview/index.css -o dist/webview.css --watch",
    "test:unit": "tsc -p . --outDir out && mocha \"out/test/unit/**/*.test.js\"",
```

Change `compile` and `package` to build CSS too, and add `watch:css` to the watch set:

```json
    "compile": "yarn run check-types && yarn run lint && node esbuild.js && yarn run build:css",
    "package": "yarn run check-types && yarn run lint && node esbuild.js --production && yarn run build:css",
```

Create `media/icon.svg` — a 24×24 monochrome SVG using `currentColor` (VS Code recolors activity-bar icons):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <rect x="3" y="4" width="18" height="13" rx="2"/>
  <path d="M8 20h8M12 17v3"/>
</svg>
```

- [ ] **Step 3: Add the webview bundle to `esbuild.js`**

Extract the existing config into a host config and add a webview config. Replace the body of `main()`:

```js
async function main() {
	const common = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	};

	const hostCtx = await esbuild.context({
		...common,
		entryPoints: ['src/extension.ts'],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
	});

	const webviewCtx = await esbuild.context({
		...common,
		entryPoints: ['src/webview/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/webview.js',
		loader: { '.tsx': 'tsx', '.ts': 'ts' },
	});

	if (watch) {
		await Promise.all([hostCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([hostCtx.rebuild(), webviewCtx.rebuild()]);
		await Promise.all([hostCtx.dispose(), webviewCtx.dispose()]);
	}
}
```

- [ ] **Step 4: Update `tsconfig.json`**

One config type-checks both bundles. `DOM` in the host's scope is a mild imprecision accepted to avoid a second `tsc` invocation in `check-types`.

```json
{
    "compilerOptions": {
        "module": "Node16",
        "target": "ES2022",
        "lib": ["ES2022", "DOM", "DOM.Iterable"],
        "types": ["node", "mocha"],
        "jsx": "react-jsx",
        "baseUrl": ".",
        "paths": { "@/*": ["src/webview/*"] },
        "sourceMap": true,
        "rootDir": "src",
        "strict": true
    }
}
```

- [ ] **Step 5: Write `src/webview/index.css`**

Two layers. `:root` points shadcn's token names at VS Code's theme variables, and `@theme inline` registers those tokens with Tailwind under the `--color-*` namespace.

**The `@theme inline` block is what makes `bg-background`, `border-border`, `text-muted-foreground` exist as utilities.** Without it, Tailwind knows nothing about these names and the only way to reach them is the long `border-[var(--border)]` arbitrary-value form. Register them once here and use the short utilities everywhere — no `[var(--…)]` in component code.

shadcn's own guide wraps the `:root` values in `hsl()`; ours are already complete colors coming from VS Code, so they are referenced as-is.

```css
@import "tailwindcss";

:root {
  --background: var(--vscode-sideBar-background);
  --foreground: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  --card: var(--vscode-editorWidget-background);
  --card-foreground: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
  --popover: var(--vscode-editorWidget-background);
  --popover-foreground: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
  --primary: var(--vscode-button-background);
  --primary-foreground: var(--vscode-button-foreground);
  --secondary: var(--vscode-button-secondaryBackground);
  --secondary-foreground: var(--vscode-button-secondaryForeground);
  --muted: var(--vscode-editorWidget-background);
  --muted-foreground: var(--vscode-descriptionForeground);
  --accent: var(--vscode-list-hoverBackground);
  --accent-foreground: var(--vscode-foreground);
  --destructive: var(--vscode-errorForeground);
  --destructive-foreground: var(--vscode-editor-background);
  --border: var(--vscode-panel-border, var(--vscode-editorWidget-border));
  --input: var(--vscode-input-background);
  --ring: var(--vscode-focusBorder);
  --radius: 4px;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);
}

body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
```

Verify the registration before building any component on it. After Step 10's `yarn run compile`, run:

```bash
grep -c "\-\-color-border" dist/webview.css
```

Expected: at least 1. If the count is 0, `@theme inline` did not take effect and every short utility will silently render unstyled.

- [ ] **Step 6: Write `src/webview/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';

function App() {
  return <div className="p-3 text-sm">HiiiiD Code panel ready.</div>;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
```

- [ ] **Step 7: Write `src/host/panel-view-provider.ts`**

```ts
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hiiiid-code.panel';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.render(view.webview);
  }

  private render(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>HiiiiD Code</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64url');
}
```

A CSP nonce must be unpredictable, so it comes from `node:crypto`, not `Math.random()`. The extension host is Node, so this is a plain import. Every later webview change inherits this function unchanged.

- [ ] **Step 8: Rewrite `src/extension.ts`**

```ts
import * as vscode from 'vscode';
import { PanelViewProvider } from './host/panel-view-provider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new PanelViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
  );
}

export function deactivate() {}
```

- [ ] **Step 9: Move the integration test and add CSP assertions**

Delete `src/test/extension.test.ts`. Create `src/test/integration/extension.test.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension', () => {
  test('activates and registers the panel view', async () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.hiiiid-code');
    assert.ok(ext, 'extension should be found');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('view container is contributed to the activity bar', () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.hiiiid-code');
    const containers = ext!.packageJSON.contributes.viewsContainers.activitybar;
    assert.strictEqual(containers.length, 1);
    assert.strictEqual(containers[0].id, 'hiiiid-code');
  });
});
```

Add CSP assertions against the HTML `PanelViewProvider` actually renders — every later webview change inherits this template, and without a test nothing catches an accidental loosening. Drive the real provider with a minimal `vscode.Webview` stub supplying `cspSource` and `asWebviewUri`, and assert:

- the CSP contains `default-src 'none'`
- the CSP contains neither `unsafe-inline` nor `unsafe-eval`
- the nonce in the `<meta>` CSP matches the nonce on the `<script>` tag
- two renders produce different nonces

Assert on the provider's real output, not on a re-implementation of the template — a test that rebuilds the string it is checking verifies nothing.

Update `.vscode-test.mjs`:

```js
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
});
```

- [ ] **Step 10: Build and verify**

```bash
yarn run compile
```

Expected: no type errors, `dist/extension.js`, `dist/webview.js`, and `dist/webview.css` all present.

```bash
yarn test
```

Expected: PASS, 2 passing.

- [ ] **Step 11: Manually verify sidebar placement**

Press F5 to launch the Extension Development Host. Confirm:
1. A "HiiiiD Code" icon appears in the activity bar.
2. Clicking it shows "HiiiiD Code panel ready." styled with the current theme's colors.
3. Dragging the "HiiiiD Code" container from the activity bar into the secondary sidebar (View → Appearance → Secondary Side Bar, `Ctrl+Alt+B`) works, and it stays there after reloading the window.

Point 3 is the gating requirement. If it fails, stop and report before continuing.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: render a React webview in a draggable sidebar view container"
```

---

## Task 2: Provider seam and FakeProvider

The interface every agent implements, plus a scripted implementation that unblocks all host and UI work.

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/fake/fake-provider.ts`
- Create: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Produces: `AgentProvider`, `AgentRun`, `AgentEvent`, `ModelInfo`, `StartOptions`, `ToolDecision`, `EffortLevel`, `PermissionMode` from `src/providers/types.ts`.
- Produces: `class FakeProvider implements AgentProvider` with `constructor(script: (text: string) => AgentEvent[])`; `FakeProvider.prototype.start(opts: StartOptions): AgentRun`.

- [ ] **Step 1: Write `src/providers/types.ts`**

```ts
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * 'default'     — prompt on anything that falls through to a prompt
 * 'acceptEdits' — auto-accept file edits, still prompt for everything else
 * 'plan'        — read-only planning
 * 'dontAsk'     — deny anything not already permitted
 * 'bypass'      — allow everything
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypass';

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Absent when the model has no effort control. */
  effort?: { levels: EffortLevel[]; default: EffortLevel };
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** Provider-opaque. Never parsed by callers. */
  resumeToken?: string;
}

export type ToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; reason?: string };

export type AgentEvent =
  | { kind: 'session'; resumeToken: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown }
  | { kind: 'permission'; id: string; name: string; input: unknown }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

export interface AgentRun {
  send(text: string): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): ModelInfo[];
  start(opts: StartOptions): AgentRun;
}
```

- [ ] **Step 2: Write the failing test**

`src/test/unit/fake-provider.test.ts`:

```ts
import * as assert from 'assert';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent } from '../../providers/types';

async function drain(run: { events: AsyncIterable<AgentEvent> }, count: number) {
  const out: AgentEvent[] = [];
  for await (const ev of run.events) {
    out.push(ev);
    if (out.length === count) { break; }
  }
  return out;
}

suite('FakeProvider', () => {
  test('emits the scripted events for a sent message', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'hi' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('hello');

    const events = await drain(run, 3);
    assert.deepStrictEqual(events[0], { kind: 'session', resumeToken: 'fake-session-1' });
    assert.deepStrictEqual(events[1], { kind: 'text', delta: 'hi' });
    assert.deepStrictEqual(events[2], { kind: 'turn-end', reason: 'done' });
    await run.dispose();
  });

  test('respondToTool resolves a pending permission', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'p1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('run ls');
    await drain(run, 2);

    run.respondToTool('p1', { allow: true });
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: true });
    await run.dispose();
  });

  test('interrupt emits turn-end with reason interrupted', async () => {
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'working' }]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('go');
    await drain(run, 2);

    await run.interrupt();
    const [ev] = await drain(run, 1);
    assert.deepStrictEqual(ev, { kind: 'turn-end', reason: 'interrupted' });
    await run.dispose();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../providers/fake/fake-provider`.

- [ ] **Step 4: Write `src/providers/fake/fake-provider.ts`**

The queue is an async-iterable push channel — the same shape the real provider uses, so `AgentSession` is exercised against realistic backpressure.

```ts
import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, ModelInfo, StartOptions, ToolDecision,
} from '../types';

class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const next = this.queue.shift();
        if (next) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

export class FakeProvider implements AgentProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  /** Records every decision passed to respondToTool, for assertions. */
  readonly decisions = new Map<string, ToolDecision>();
  private sessionCounter = 0;

  constructor(private readonly script: (text: string) => AgentEvent[]) {}

  listModels(): ModelInfo[] {
    return [
      {
        id: 'fake-large',
        displayName: 'Fake Large',
        effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
      },
      { id: 'fake-small', displayName: 'Fake Small' },
    ];
  }

  start(_opts: StartOptions): AgentRun {
    const channel = new EventChannel();
    const resumeToken = `fake-session-${++this.sessionCounter}`;
    let started = false;

    return {
      events: channel,
      send: (text: string) => {
        if (!started) {
          started = true;
          channel.push({ kind: 'session', resumeToken });
        }
        for (const ev of this.script(text)) { channel.push(ev); }
      },
      respondToTool: (id, decision) => { this.decisions.set(id, decision); },
      setEffort: (_effort: EffortLevel) => { /* recorded by tests via lastEffort if needed */ },
      interrupt: async () => { channel.push({ kind: 'turn-end', reason: 'interrupted' }); },
      dispose: async () => { channel.close(); },
    };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 3 passing.

- [ ] **Step 6: Commit**

```bash
git add src/providers src/test/unit
git commit -m "feat: add AgentProvider seam and a scripted FakeProvider"
```

---

## Task 3: Protocol types

The shared wire contract. Types only — a mismatch between bundles becomes a compile error.

**Files:**
- Create: `src/protocol/messages.ts`
- Create: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Produces: `SessionId`, `TranscriptItem`, `TranscriptPatch`, `SessionState`, `SessionSummary`, `SessionSnapshot`, `ProviderInfo`, `PaneLayout`, `PermissionRequest`, `WebviewToHost`, `HostToWebview`.

- [ ] **Step 1: Write `src/protocol/messages.ts`**

```ts
import type {
  EffortLevel, ModelInfo, PermissionMode, ToolDecision,
} from '../providers/types';

export type { EffortLevel, ModelInfo, PermissionMode, ToolDecision };

export type SessionId = string;
export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

interface ItemBase { id: string; ts: number }

export type TranscriptItem =
  | (ItemBase & { role: 'user'; text: string })
  | (ItemBase & { role: 'assistant'; text: string; thinking?: string })
  | (ItemBase & {
      role: 'tool'; toolId: string; name: string; input: unknown;
      state: 'running' | 'ok' | 'error'; output?: unknown;
    })
  | (ItemBase & {
      role: 'permission'; requestId: string; name: string; input: unknown;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
    })
  | (ItemBase & { role: 'error'; message: string });

export type TranscriptPatch =
  | { op: 'append'; item: TranscriptItem }
  | { op: 'delta'; itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem };

export interface PermissionRequest {
  requestId: string;
  name: string;
  input: unknown;
}

export interface SessionState {
  id: SessionId;
  providerId: string;
  model: string;
  effort?: EffortLevel;
  title: string;
  cwd: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  resumeToken?: string;
  usage: { inputTokens: number; outputTokens: number };
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SessionSummary = SessionState;

export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ModelInfo[];
}

export interface PaneLayout {
  orientation: 'vertical' | 'horizontal';
  panes: { sessionId: SessionId; size: number }[];
}

export type WebviewToHost =
  | { t: 'ready' }
  | { t: 'create-session'; providerId: string; cwd: string; model?: string; effort?: EffortLevel }
  | { t: 'set-visible'; sessionIds: SessionId[] }
  | { t: 'set-layout'; layout: PaneLayout }
  | { t: 'close-session'; id: SessionId }
  | { t: 'delete-session'; id: SessionId }
  | { t: 'send'; id: SessionId; text: string }
  | { t: 'interrupt'; id: SessionId }
  | { t: 'set-effort'; id: SessionId; effort: EffortLevel }
  | { t: 'set-permission-mode'; id: SessionId; mode: PermissionMode }
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
  | { t: 'load-more'; id: SessionId; beforeItemId: string };

export type HostToWebview =
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[] }
  | { t: 'session-snapshot'; session: SessionSnapshot }
  | { t: 'session-patch'; id: SessionId; patch: TranscriptPatch }
  | { t: 'session-prepend'; id: SessionId; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session-status'; id: SessionId; status: SessionStatus }
  | { t: 'sessions-changed'; sessions: SessionSummary[] };
```

- [ ] **Step 2: Write a type-level test**

`src/test/unit/protocol.test.ts` — exhaustiveness checks that fail to compile if a variant is added without handling.

```ts
import * as assert from 'assert';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

function assertNever(x: never): never {
  throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

function describeInbound(m: WebviewToHost): string {
  switch (m.t) {
    case 'ready': return 'ready';
    case 'create-session': return 'create-session';
    case 'set-visible': return 'set-visible';
    case 'set-layout': return 'set-layout';
    case 'close-session': return 'close-session';
    case 'delete-session': return 'delete-session';
    case 'send': return 'send';
    case 'interrupt': return 'interrupt';
    case 'set-effort': return 'set-effort';
    case 'set-permission-mode': return 'set-permission-mode';
    case 'permission-decision': return 'permission-decision';
    case 'load-more': return 'load-more';
    default: return assertNever(m);
  }
}

function describeOutbound(m: HostToWebview): string {
  switch (m.t) {
    case 'hydrate': return 'hydrate';
    case 'session-snapshot': return 'session-snapshot';
    case 'session-patch': return 'session-patch';
    case 'session-prepend': return 'session-prepend';
    case 'session-status': return 'session-status';
    case 'sessions-changed': return 'sessions-changed';
    default: return assertNever(m);
  }
}

suite('protocol', () => {
  test('inbound variants are exhaustively handled', () => {
    assert.strictEqual(describeInbound({ t: 'ready' }), 'ready');
    assert.strictEqual(describeInbound({ t: 'send', id: 's1', text: 'hi' }), 'send');
  });

  test('outbound variants are exhaustively handled', () => {
    assert.strictEqual(
      describeOutbound({ t: 'session-status', id: 's1', status: 'idle' }),
      'session-status',
    );
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `yarn test:unit`
Expected: PASS, 5 passing total.

- [ ] **Step 4: Verify the types-only constraint**

Run: `grep -n "vscode" src/protocol/messages.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/protocol src/test/unit/protocol.test.ts
git commit -m "feat: define the host/webview protocol types"
```

---

## Task 4: TranscriptStore

Durable transcripts. Node `fs/promises` against a directory path — no `vscode` import, so it tests against a temp dir.

**Deliberate simplification, and a deviation from the spec.** The spec describes a live session holding a bounded in-memory window with older items paged from disk. This implementation loads a session's whole JSONL into memory on first access and serves both `tail` and `before` from that cache. A single conversation's transcript is bounded at a few megabytes, so the simpler path is honest for v1; the escape hatch if files grow is backward chunked reads with a line-offset index, and the `tail`/`before` signatures do not change.

**Files:**
- Create: `src/host/transcript-store.ts`
- Create: `src/test/unit/transcript-store.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem`, `SessionState`, `PaneLayout` from `src/protocol/messages`.
- Produces: `class TranscriptStore` with `constructor(rootDir: string)`, and methods `readIndex(): Promise<StoredIndex>`, `writeIndex(index: StoredIndex): Promise<void>`, `append(id: SessionId, item: TranscriptItem): void`, `flush(id?: SessionId): Promise<void>`, `tail(id: SessionId, limit?: number): Promise<{ items: TranscriptItem[]; hasMore: boolean }>`, `before(id: SessionId, beforeItemId: string, limit?: number): Promise<{ items: TranscriptItem[]; hasMore: boolean }>`, `replace(id: SessionId, item: TranscriptItem): void`, `remove(id: SessionId): Promise<void>`.
- Produces: `interface StoredIndex { sessions: SessionState[]; layout: PaneLayout }`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/transcript-store.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TranscriptStore } from '../../host/transcript-store';
import type { TranscriptItem } from '../../protocol/messages';

function item(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'user', text };
}

suite('TranscriptStore', () => {
  let dir: string;
  let store: TranscriptStore;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-store-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips appended items through disk', async () => {
    store.append('s1', item('a', 'one'));
    store.append('s1', item('b', 'two'));
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items, hasMore } = await fresh.tail('s1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, 'a');
    assert.strictEqual(items[1].id, 'b');
    assert.strictEqual(hasMore, false);
  });

  test('tail returns the last N items and reports more history', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.tail('s1', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i7', 'i8', 'i9']);
    assert.strictEqual(hasMore, true);
  });

  test('before pages backward from an item id', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.before('s1', 'i7', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i4', 'i5', 'i6']);
    assert.strictEqual(hasMore, true);

    const rest = await store.before('s1', 'i4', 10);
    assert.deepStrictEqual(rest.items.map((i) => i.id), ['i0', 'i1', 'i2', 'i3']);
    assert.strictEqual(rest.hasMore, false);
  });

  test('replace updates an item in place and survives reload', async () => {
    store.append('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'pending',
    });
    await store.flush();

    store.replace('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'allowed',
    });
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as { state: string }).state, 'allowed');
  });

  test('tail on an unknown session returns empty rather than throwing', async () => {
    const { items, hasMore } = await store.tail('missing');
    assert.deepStrictEqual(items, []);
    assert.strictEqual(hasMore, false);
  });

  test('index round-trips', async () => {
    await store.writeIndex({
      sessions: [{
        id: 's1', providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
        status: 'idle', permissionMode: 'default',
        usage: { inputTokens: 0, outputTokens: 0 },
        archived: false, createdAt: 1, updatedAt: 1,
      }],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
    });

    const fresh = new TranscriptStore(dir);
    const index = await fresh.readIndex();
    assert.strictEqual(index.sessions.length, 1);
    assert.strictEqual(index.sessions[0].id, 's1');
    assert.strictEqual(index.layout.panes[0].sessionId, 's1');
  });

  test('readIndex on a fresh directory returns an empty index', async () => {
    const index = await store.readIndex();
    assert.deepStrictEqual(index.sessions, []);
    assert.deepStrictEqual(index.layout, { orientation: 'vertical', panes: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../host/transcript-store`.

- [ ] **Step 3: Write `src/host/transcript-store.ts`**

`replace` rewrites the file because a settled tool or permission item mutates one already-written line. Rewrites are rare relative to appends and bounded by one conversation.

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import type { PaneLayout, SessionId, SessionState, TranscriptItem } from '../protocol/messages';

export interface StoredIndex {
  sessions: SessionState[];
  layout: PaneLayout;
}

const EMPTY_INDEX: StoredIndex = {
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
};

export class TranscriptStore {
  private cache = new Map<SessionId, TranscriptItem[]>();
  private pending = new Map<SessionId, TranscriptItem[]>();
  private dirty = new Set<SessionId>();

  constructor(private readonly rootDir: string) {}

  private sessionFile(id: SessionId): string {
    return path.join(this.rootDir, 'sessions', `${id}.jsonl`);
  }

  private async ensureLoaded(id: SessionId): Promise<TranscriptItem[]> {
    const cached = this.cache.get(id);
    if (cached) { return cached; }

    let items: TranscriptItem[] = [];
    try {
      const raw = await fs.readFile(this.sessionFile(id), 'utf8');
      items = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TranscriptItem);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
    }
    this.cache.set(id, items);
    return items;
  }

  append(id: SessionId, item: TranscriptItem): void {
    const cached = this.cache.get(id);
    if (cached) { cached.push(item); }
    const queue = this.pending.get(id) ?? [];
    queue.push(item);
    this.pending.set(id, queue);
  }

  replace(id: SessionId, item: TranscriptItem): void {
    const cached = this.cache.get(id);
    if (cached) {
      const at = cached.findIndex((i) => i.id === item.id);
      if (at >= 0) { cached[at] = item; } else { cached.push(item); }
    }
    const queue = this.pending.get(id);
    if (queue) {
      const at = queue.findIndex((i) => i.id === item.id);
      if (at >= 0) { queue[at] = item; return; }
    }
    this.dirty.add(id);
  }

  async flush(id?: SessionId): Promise<void> {
    const ids = id ? [id] : new Set([...this.pending.keys(), ...this.dirty]);
    await fs.mkdir(path.join(this.rootDir, 'sessions'), { recursive: true });

    for (const sessionId of ids) {
      if (this.dirty.has(sessionId)) {
        const items = await this.ensureLoaded(sessionId);
        const queued = this.pending.get(sessionId) ?? [];
        for (const q of queued) {
          if (!items.some((i) => i.id === q.id)) { items.push(q); }
        }
        const body = items.map((i) => JSON.stringify(i)).join('\n');
        await fs.writeFile(this.sessionFile(sessionId), body ? `${body}\n` : '', 'utf8');
        this.dirty.delete(sessionId);
        this.pending.delete(sessionId);
        continue;
      }

      const queued = this.pending.get(sessionId);
      if (!queued || queued.length === 0) { continue; }
      const body = queued.map((i) => JSON.stringify(i)).join('\n');
      await fs.appendFile(this.sessionFile(sessionId), `${body}\n`, 'utf8');
      this.pending.delete(sessionId);
    }
  }

  async tail(
    id: SessionId,
    limit = 100,
  ): Promise<{ items: TranscriptItem[]; hasMore: boolean }> {
    const items = await this.ensureLoaded(id);
    const start = Math.max(0, items.length - limit);
    return { items: items.slice(start), hasMore: start > 0 };
  }

  async before(
    id: SessionId,
    beforeItemId: string,
    limit = 100,
  ): Promise<{ items: TranscriptItem[]; hasMore: boolean }> {
    const items = await this.ensureLoaded(id);
    const at = items.findIndex((i) => i.id === beforeItemId);
    if (at <= 0) { return { items: [], hasMore: false }; }
    const start = Math.max(0, at - limit);
    return { items: items.slice(start, at), hasMore: start > 0 };
  }

  async remove(id: SessionId): Promise<void> {
    this.cache.delete(id);
    this.pending.delete(id);
    this.dirty.delete(id);
    await fs.rm(this.sessionFile(id), { force: true });
  }

  async readIndex(): Promise<StoredIndex> {
    try {
      const raw = await fs.readFile(path.join(this.rootDir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredIndex>;
      return {
        sessions: parsed.sessions ?? [],
        layout: parsed.layout ?? EMPTY_INDEX.layout,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { ...EMPTY_INDEX }; }
      throw err;
    }
  }

  async writeIndex(index: StoredIndex): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(
      path.join(this.rootDir, 'index.json'),
      JSON.stringify(index, null, 2),
      'utf8',
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 12 passing total.

- [ ] **Step 5: Commit**

```bash
git add src/host/transcript-store.ts src/test/unit/transcript-store.test.ts
git commit -m "feat: persist transcripts as per-session JSONL with paged reads"
```

---

## Task 5: AgentSession

One conversation. Consumes provider events, coalesces deltas, parks approvals, emits patches.

**Files:**
- Create: `src/host/agent-session.ts`
- Create: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, `AgentRun`, `ToolDecision`, `EffortLevel`, `PermissionMode` (Task 2); `TranscriptStore` (Task 4); protocol types (Task 3).
- Produces: `class AgentSession` with `constructor(state: SessionState, provider: AgentProvider, store: TranscriptStore, sink: SessionSink)`, methods `send(text: string): void`, `interrupt(): Promise<void>`, `setEffort(effort: EffortLevel): void`, `setPermissionMode(mode: PermissionMode): void`, `respondToPermission(requestId: string, decision: ToolDecision): void`, `snapshot(): Promise<SessionSnapshot>`, `loadMore(beforeItemId: string): Promise<{ items: TranscriptItem[]; hasMore: boolean }>`, `dispose(): Promise<void>`; readonly getter `state: SessionState`.
- Produces: `interface SessionSink { patch(id: SessionId, patch: TranscriptPatch): void; status(id: SessionId, status: SessionStatus): void; changed(): void }`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/agent-session.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { SessionId, SessionState, SessionStatus, TranscriptPatch } from '../../protocol/messages';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-session-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('coalesces text deltas into one assistant item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    const snap = await session.snapshot();
    const assistant = snap.items.filter((i) => i.role === 'assistant');
    assert.strictEqual(assistant.length, 1);
    assert.strictEqual((assistant[0] as { text: string }).text, 'Hello');

    const deltas = sink.patches.filter((p) => p.patch.op === 'delta');
    assert.strictEqual(deltas.length, 2, 'each delta is streamed separately');
    await session.dispose();
  });

  test('appends the user message and derives the title from it', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('Refactor the auth module');
    await settle();

    assert.strictEqual(session.state.title, 'Refactor the auth module');
    const snap = await session.snapshot();
    assert.strictEqual(snap.items[0].role, 'user');
    await session.dispose();
  });

  test('a permission event parks the session and respondToPermission settles it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval');
    let snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 1);
    assert.strictEqual(snap.pending[0].requestId, 'r1');

    session.respondToPermission('r1', { allow: true });
    await settle();

    assert.deepStrictEqual(provider.decisions.get('r1'), { allow: true });
    snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 0);
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { state: string }).state, 'allowed');
    await session.dispose();
  });

  test('tool-start then tool-end replaces the tool item in place', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'Read', input: { path: 'a.ts' } },
      { kind: 'tool-end', id: 't1', ok: true, output: 'contents' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('read a.ts');
    await settle();

    const snap = await session.snapshot();
    const tools = snap.items.filter((i) => i.role === 'tool');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual((tools[0] as { state: string }).state, 'ok');
    assert.ok(sink.patches.some((p) => p.patch.op === 'replace'));
    await session.dispose();
  });

  test('turn-end with error moves the session to error and appends an error item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'turn-end', reason: 'error', error: 'spawn failed' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'spawn failed');
    await session.dispose();
  });

  test('dispose denies outstanding permissions so the provider can unwind', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: {} },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    await session.dispose();
    assert.deepStrictEqual(provider.decisions.get('r1'), {
      allow: false, reason: 'Session closed',
    });
  });

  test('records the resume token from the session event', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    assert.strictEqual(session.state.resumeToken, 'fake-session-1');
    await session.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../host/agent-session`.

- [ ] **Step 3: Write `src/host/agent-session.ts`**

```ts
import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, PermissionMode, ToolDecision,
} from '../providers/types';
import type {
  PermissionRequest, SessionId, SessionSnapshot, SessionState, SessionStatus,
  TranscriptItem, TranscriptPatch,
} from '../protocol/messages';
import type { TranscriptStore } from './transcript-store';

export interface SessionSink {
  patch(id: SessionId, patch: TranscriptPatch): void;
  status(id: SessionId, status: SessionStatus): void;
  changed(): void;
}

const TITLE_MAX = 60;
let counter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class AgentSession {
  private run: AgentRun;
  private pending = new Map<string, PermissionRequest>();
  private openAssistantId: string | undefined;
  private toolItems = new Map<string, TranscriptItem>();
  private permissionItems = new Map<string, TranscriptItem>();
  private pumping: Promise<void>;
  private disposed = false;

  constructor(
    private readonly _state: SessionState,
    private readonly provider: AgentProvider,
    private readonly store: TranscriptStore,
    private readonly sink: SessionSink,
  ) {
    this.run = provider.start({
      cwd: _state.cwd,
      model: _state.model,
      effort: _state.effort,
      permissionMode: _state.permissionMode,
      resumeToken: _state.resumeToken,
    });
    this.pumping = this.pump();
  }

  get state(): SessionState { return this._state; }

  send(text: string): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    const item: TranscriptItem = { id: nextId('u'), ts: Date.now(), role: 'user', text };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    this.run.send(text);
  }

  async interrupt(): Promise<void> { await this.run.interrupt(); }

  setEffort(effort: EffortLevel): void {
    this._state.effort = effort;
    this._state.updatedAt = Date.now();
    this.run.setEffort(effort);
    this.sink.changed();
  }

  setPermissionMode(mode: PermissionMode): void {
    this._state.permissionMode = mode;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }

  respondToPermission(requestId: string, decision: ToolDecision): void {
    if (!this.pending.delete(requestId)) { return; }
    this.run.respondToTool(requestId, decision);

    const existing = this.permissionItems.get(requestId);
    if (existing && existing.role === 'permission') {
      const settled: TranscriptItem = {
        ...existing,
        state: decision.allow ? 'allowed' : 'denied',
        reason: decision.allow ? undefined : decision.reason,
      };
      this.replaceItem(settled);
      this.permissionItems.set(requestId, settled);
    }
    this.setStatus(this.pending.size > 0 ? 'awaiting-approval' : 'running');
  }

  async snapshot(): Promise<SessionSnapshot> {
    await this.store.flush(this._state.id);
    const { items, hasMore } = await this.store.tail(this._state.id);
    return { ...this._state, items, hasMore, pending: [...this.pending.values()] };
  }

  async loadMore(beforeItemId: string) {
    return this.store.before(this._state.id, beforeItemId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const requestId of [...this.pending.keys()]) {
      this.pending.delete(requestId);
      this.run.respondToTool(requestId, { allow: false, reason: 'Session closed' });
    }
    await this.run.dispose();
    await this.pumping;
    await this.store.flush(this._state.id);
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.run.events) { this.handle(event); }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.kind) {
      case 'session':
        this._state.resumeToken = event.resumeToken;
        this.sink.changed();
        return;

      case 'text':
      case 'thinking': {
        const field = event.kind === 'text' ? 'text' : 'thinking';
        if (!this.openAssistantId) {
          const item: TranscriptItem = {
            id: nextId('a'), ts: Date.now(), role: 'assistant', text: '',
          };
          this.openAssistantId = item.id;
          this.appendItem(item);
        }
        this.mergeDelta(this.openAssistantId, field, event.delta);
        return;
      }

      case 'tool-start': {
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, name: event.name, input: event.input, state: 'running',
        };
        this.toolItems.set(event.id, item);
        this.closeAssistant();
        this.appendItem(item);
        return;
      }

      case 'tool-end': {
        const existing = this.toolItems.get(event.id);
        if (!existing || existing.role !== 'tool') { return; }
        const settled: TranscriptItem = {
          ...existing, state: event.ok ? 'ok' : 'error', output: event.output,
        };
        this.toolItems.set(event.id, settled);
        this.replaceItem(settled);
        return;
      }

      case 'permission': {
        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, name: event.name, input: event.input, state: 'pending',
        };
        this.permissionItems.set(event.id, item);
        this.pending.set(event.id, {
          requestId: event.id, name: event.name, input: event.input,
        });
        this.closeAssistant();
        this.appendItem(item);
        this.setStatus('awaiting-approval');
        return;
      }

      case 'usage':
        this._state.usage = {
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        };
        this.sink.changed();
        return;

      case 'turn-end':
        this.closeAssistant();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          this.setStatus('idle');
          void this.store.flush(this._state.id);
        }
        return;
    }
  }

  private fail(message: string): void {
    this.appendItem({ id: nextId('e'), ts: Date.now(), role: 'error', message });
    this.setStatus('error');
    void this.store.flush(this._state.id);
  }

  private appendItem(item: TranscriptItem): void {
    this.store.append(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'append', item });
  }

  private replaceItem(item: TranscriptItem): void {
    this.store.replace(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'replace', item });
  }

  private pendingAssistant: { text?: string; thinking?: string } | undefined;

  /** Accumulates streamed deltas into the open assistant item. */
  private mergeDelta(itemId: string, field: 'text' | 'thinking', delta: string): void {
    const current = this.pendingAssistant ?? {};
    current[field] = (current[field] ?? '') + delta;
    this.pendingAssistant = current;
    this.store.replace(this._state.id, {
      id: itemId, ts: Date.now(), role: 'assistant',
      text: current.text ?? '', thinking: current.thinking,
    });
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'delta', itemId, field, delta });
  }

  /** Ends the current assistant item so the next delta starts a new one. */
  private closeAssistant(): void {
    this.openAssistantId = undefined;
    this.pendingAssistant = undefined;
  }

  private setStatus(status: SessionStatus): void {
    if (this._state.status === status) { return; }
    this._state.status = status;
    this._state.updatedAt = Date.now();
    this.sink.status(this._state.id, status);
    this.sink.changed();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 19 passing total.

- [ ] **Step 5: Commit**

```bash
git add src/host/agent-session.ts src/test/unit/agent-session.test.ts
git commit -m "feat: add AgentSession with delta coalescing and parked approvals"
```

---

## Task 6: SessionManager

The roster, and the fan-out rule: patches go only to visible sessions.

**Files:**
- Create: `src/host/session-manager.ts`
- Create: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `AgentSession`, `SessionSink` (Task 5); `TranscriptStore`, `StoredIndex` (Task 4); `AgentProvider` (Task 2).
- Produces: `class SessionManager` with `constructor(store: TranscriptStore, providers: Map<string, AgentProvider>, emit: (msg: HostToWebview) => void)`, methods `init(): Promise<void>`, `catalog(): ProviderInfo[]`, `summaries(): SessionSummary[]`, `layout(): PaneLayout`, `setLayout(layout: PaneLayout): void`, `create(providerId: string, cwd: string, model?: string, effort?: EffortLevel): Promise<AgentSession>`, `get(id: SessionId): AgentSession | undefined`, `open(id: SessionId): Promise<AgentSession>`, `setVisible(ids: SessionId[]): Promise<void>`, `close(id: SessionId): Promise<void>`, `remove(id: SessionId): Promise<void>`, `dispose(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/session-manager.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('SessionManager', () => {
  let dir: string;
  let store: TranscriptStore;
  let sent: HostToWebview[];
  let providers: Map<string, AgentProvider>;
  let manager: SessionManager;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-manager-'));
    store = new TranscriptStore(dir);
    sent = [];
    providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    manager = new SessionManager(store, providers, (m) => sent.push(m));
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('create adds a session and announces the roster', async () => {
    const session = await manager.create('fake', '/tmp');
    assert.strictEqual(manager.summaries().length, 1);
    assert.strictEqual(manager.get(session.state.id), session);
    assert.ok(sent.some((m) => m.t === 'sessions-changed'));
  });

  test('patches reach visible sessions only', async () => {
    const a = await manager.create('fake', '/tmp');
    const b = await manager.create('fake', '/tmp');
    await manager.setVisible([a.state.id]);
    sent.length = 0;

    a.send('hello');
    b.send('hello');
    await settle();

    const patched = sent.filter((m) => m.t === 'session-patch') as
      Extract<HostToWebview, { t: 'session-patch' }>[];
    assert.ok(patched.length > 0);
    assert.ok(patched.every((m) => m.id === a.state.id),
      'no patch should be emitted for the hidden session');
  });

  test('status is announced for hidden sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    await manager.setVisible([]);
    sent.length = 0;

    a.send('hello');
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-status' && m.id === a.state.id));
  });

  test('setVisible emits a snapshot for newly visible sessions', async () => {
    const a = await manager.create('fake', '/tmp');
    a.send('hello');
    await settle();
    sent.length = 0;

    await manager.setVisible([a.state.id]);
    const snaps = sent.filter((m) => m.t === 'session-snapshot');
    assert.strictEqual(snaps.length, 1);
  });

  test('close archives and keeps the transcript; remove deletes it', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    a.send('hello');
    await settle();

    await manager.close(id);
    assert.strictEqual(manager.get(id), undefined, 'closed session is not live');
    const summary = manager.summaries().find((s) => s.id === id);
    assert.strictEqual(summary?.archived, true);
    const kept = await store.tail(id);
    assert.ok(kept.items.length > 0, 'transcript survives close');

    await manager.remove(id);
    assert.strictEqual(manager.summaries().find((s) => s.id === id), undefined);
    const gone = await store.tail(id);
    assert.strictEqual(gone.items.length, 0);
  });

  test('init restores sessions and layout from the index', async () => {
    const a = await manager.create('fake', '/tmp');
    manager.setLayout({
      orientation: 'horizontal',
      panes: [{ sessionId: a.state.id, size: 100 }],
    });
    await manager.dispose();

    const fresh = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await fresh.init();
    assert.strictEqual(fresh.summaries().length, 1);
    assert.strictEqual(fresh.layout().orientation, 'horizontal');
    assert.strictEqual(fresh.get(a.state.id), undefined,
      'restored sessions are not live until opened');
    await fresh.dispose();
  });

  test('open revives an archived session as live', async () => {
    const a = await manager.create('fake', '/tmp');
    const id = a.state.id;
    await manager.close(id);

    const revived = await manager.open(id);
    assert.strictEqual(revived.state.archived, false);
    assert.strictEqual(manager.get(id), revived);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../host/session-manager`.

- [ ] **Step 3: Write `src/host/session-manager.ts`**

```ts
import { AgentSession, type SessionSink } from './agent-session';
import type { StoredIndex, TranscriptStore } from './transcript-store';
import type { AgentProvider, EffortLevel } from '../providers/types';
import type {
  HostToWebview, PaneLayout, ProviderInfo, SessionId, SessionState,
  SessionStatus, SessionSummary, TranscriptPatch,
} from '../protocol/messages';

let counter = 0;
function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class SessionManager implements SessionSink {
  private live = new Map<SessionId, AgentSession>();
  private meta = new Map<SessionId, SessionState>();
  private visible = new Set<SessionId>();
  private paneLayout: PaneLayout = { orientation: 'vertical', panes: [] };
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: TranscriptStore,
    private readonly providers: Map<string, AgentProvider>,
    private readonly emit: (msg: HostToWebview) => void,
  ) {}

  async init(): Promise<void> {
    const index = await this.store.readIndex();
    for (const state of index.sessions) {
      this.meta.set(state.id, { ...state, status: 'idle' });
    }
    this.paneLayout = index.layout;
  }

  catalog(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id, displayName: p.displayName, models: p.listModels(),
    }));
  }

  summaries(): SessionSummary[] {
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  layout(): PaneLayout { return this.paneLayout; }

  setLayout(layout: PaneLayout): void {
    this.paneLayout = layout;
    this.schedulePersist();
  }

  async create(
    providerId: string, cwd: string, model?: string, effort?: EffortLevel,
  ): Promise<AgentSession> {
    const provider = this.providers.get(providerId);
    if (!provider) { throw new Error(`Unknown provider: ${providerId}`); }

    const models = provider.listModels();
    const chosen = models.find((m) => m.id === model) ?? models[0];
    const resolvedEffort = chosen.effort
      ? (effort && chosen.effort.levels.includes(effort) ? effort : chosen.effort.default)
      : undefined;

    const now = Date.now();
    const state: SessionState = {
      id: newSessionId(), providerId, model: chosen.id, effort: resolvedEffort,
      title: 'Untitled', cwd, status: 'idle', permissionMode: 'default',
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
    };

    const session = new AgentSession(state, provider, this.store, this);
    this.meta.set(state.id, state);
    this.live.set(state.id, session);
    this.changed();
    return session;
  }

  get(id: SessionId): AgentSession | undefined { return this.live.get(id); }

  async open(id: SessionId): Promise<AgentSession> {
    const existing = this.live.get(id);
    if (existing) { return existing; }

    const state = this.meta.get(id);
    if (!state) { throw new Error(`Unknown session: ${id}`); }
    const provider = this.providers.get(state.providerId);
    if (!provider) { throw new Error(`Unknown provider: ${state.providerId}`); }

    state.archived = false;
    state.status = 'idle';
    const session = new AgentSession(state, provider, this.store, this);
    this.live.set(id, session);
    this.changed();
    return session;
  }

  async setVisible(ids: SessionId[]): Promise<void> {
    const next = new Set(ids);
    const added = ids.filter((id) => !this.visible.has(id));
    this.visible = next;

    for (const id of added) {
      const session = this.live.get(id);
      if (session) {
        this.emit({ t: 'session-snapshot', session: await session.snapshot() });
        continue;
      }
      const state = this.meta.get(id);
      if (!state) { continue; }
      const { items, hasMore } = await this.store.tail(id);
      this.emit({
        t: 'session-snapshot',
        session: { ...state, items, hasMore, pending: [] },
      });
    }
  }

  async close(id: SessionId): Promise<void> {
    const session = this.live.get(id);
    if (session) {
      await session.dispose();
      this.live.delete(id);
    }
    const state = this.meta.get(id);
    if (state) {
      state.archived = true;
      state.status = 'idle';
      state.updatedAt = Date.now();
    }
    this.visible.delete(id);
    this.changed();
  }

  async remove(id: SessionId): Promise<void> {
    await this.close(id);
    this.meta.delete(id);
    await this.store.remove(id);
    this.paneLayout = {
      ...this.paneLayout,
      panes: this.paneLayout.panes.filter((p) => p.sessionId !== id),
    };
    this.changed();
  }

  async dispose(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    await Promise.all([...this.live.values()].map((s) => s.dispose()));
    this.live.clear();
    await this.persist();
  }

  // --- SessionSink ---

  patch(id: SessionId, patch: TranscriptPatch): void {
    if (!this.visible.has(id)) { return; }
    this.emit({ t: 'session-patch', id, patch });
  }

  status(id: SessionId, status: SessionStatus): void {
    this.emit({ t: 'session-status', id, status });
  }

  changed(): void {
    this.emit({ t: 'sessions-changed', sessions: this.summaries() });
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    this.persistTimer = setTimeout(() => { void this.persist(); }, 500);
  }

  private async persist(): Promise<void> {
    const index: StoredIndex = {
      sessions: [...this.meta.values()],
      layout: this.paneLayout,
    };
    await this.store.writeIndex(index);
    await this.store.flush();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 26 passing total.

- [ ] **Step 5: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: add SessionManager with visible-only patch fan-out"
```

---

## Task 7: Wire the protocol through PanelViewProvider

Connects the host to the webview and hydrates on `ready`.

**Files:**
- Modify: `src/host/panel-view-provider.ts`
- Modify: `src/extension.ts`
- Create: `src/test/unit/message-router.test.ts`
- Create: `src/host/message-router.ts`

**Interfaces:**
- Produces: `class MessageRouter` with `constructor(manager: SessionManager, emit: (msg: HostToWebview) => void)` and `handle(msg: WebviewToHost): Promise<void>`.
- Modifies: `PanelViewProvider` constructor becomes `constructor(extensionUri: vscode.Uri, manager: SessionManager)`.

Routing logic is extracted from the view provider so it can be unit-tested without VS Code.

- [ ] **Step 1: Write the failing test**

`src/test/unit/message-router.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview } from '../../protocol/messages';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('MessageRouter', () => {
  let dir: string;
  let sent: HostToWebview[];
  let manager: SessionManager;
  let router: MessageRouter;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-router-'));
    sent = [];
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [
        { kind: 'text', delta: 'ok' },
        { kind: 'turn-end', reason: 'done' },
      ])],
    ]);
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
    router = new MessageRouter(manager, (m) => sent.push(m));
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('ready produces a hydrate carrying the catalog', async () => {
    await router.handle({ t: 'ready' });
    const hydrate = sent.find((m) => m.t === 'hydrate') as
      Extract<HostToWebview, { t: 'hydrate' }>;
    assert.ok(hydrate);
    assert.strictEqual(hydrate.catalog.length, 1);
    assert.strictEqual(hydrate.catalog[0].id, 'fake');
    assert.deepStrictEqual(hydrate.sessions, []);
  });

  test('create-session then send drives a turn', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    await router.handle({ t: 'set-visible', sessionIds: [id] });
    sent.length = 0;

    await router.handle({ t: 'send', id, text: 'hello' });
    await settle();

    assert.ok(sent.some((m) => m.t === 'session-patch' && m.id === id));
  });

  test('load-more emits session-prepend', async () => {
    await router.handle({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
    const id = manager.summaries()[0].id;
    for (let i = 0; i < 5; i++) {
      await router.handle({ t: 'send', id, text: `msg ${i}` });
      await settle();
    }
    const session = manager.get(id)!;
    const snap = await session.snapshot();
    sent.length = 0;

    await router.handle({ t: 'load-more', id, beforeItemId: snap.items[1].id });
    const prepend = sent.find((m) => m.t === 'session-prepend');
    assert.ok(prepend);
  });

  test('an unknown session id is ignored rather than thrown', async () => {
    await router.handle({ t: 'send', id: 'nope', text: 'hi' });
    await router.handle({ t: 'interrupt', id: 'nope' });
    assert.ok(true, 'no exception escaped the router');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../host/message-router`.

- [ ] **Step 3: Write `src/host/message-router.ts`**

```ts
import type { SessionManager } from './session-manager';
import type { HostToWebview, SessionSnapshot, WebviewToHost } from '../protocol/messages';

export class MessageRouter {
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
  ) {}

  async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.t) {
      case 'ready': {
        const layout = this.manager.layout();
        const snapshots: SessionSnapshot[] = [];
        for (const pane of layout.panes) {
          const session = this.manager.get(pane.sessionId);
          if (session) { snapshots.push(await session.snapshot()); }
        }
        this.emit({
          t: 'hydrate',
          sessions: this.manager.summaries(),
          layout,
          snapshots,
          catalog: this.manager.catalog(),
        });
        return;
      }

      case 'create-session': {
        const session = await this.manager.create(
          msg.providerId, msg.cwd, msg.model, msg.effort,
        );
        this.emit({ t: 'session-snapshot', session: await session.snapshot() });
        return;
      }

      case 'set-visible':
        await this.manager.setVisible(msg.sessionIds);
        return;

      case 'set-layout':
        this.manager.setLayout(msg.layout);
        return;

      case 'close-session':
        await this.manager.close(msg.id);
        return;

      case 'delete-session':
        await this.manager.remove(msg.id);
        return;

      case 'send': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.send(msg.text);
        return;
      }

      case 'interrupt':
        await this.manager.get(msg.id)?.interrupt();
        return;

      case 'set-effort':
        this.manager.get(msg.id)?.setEffort(msg.effort);
        return;

      case 'set-permission-mode':
        this.manager.get(msg.id)?.setPermissionMode(msg.mode);
        return;

      case 'permission-decision':
        this.manager.get(msg.id)?.respondToPermission(msg.requestId, msg.decision);
        return;

      case 'load-more': {
        const session = this.manager.get(msg.id);
        if (!session) { return; }
        const { items, hasMore } = await session.loadMore(msg.beforeItemId);
        this.emit({ t: 'session-prepend', id: msg.id, items, hasMore });
        return;
      }
    }
  }

  /** Sending to an archived session revives it. Unknown ids are ignored. */
  private async reopen(id: string) {
    try {
      return await this.manager.open(id);
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Update `src/host/panel-view-provider.ts`**

Add the manager and router wiring. Replace the class body's constructor and `resolveWebviewView`, keeping `render` and `makeNonce` from Task 1:

```ts
import * as vscode from 'vscode';
import { MessageRouter } from './message-router';
import type { SessionManager } from './session-manager';
import type { HostToWebview, WebviewToHost } from '../protocol/messages';

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hiiiid-code.panel';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
  ) {}

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.render(view.webview);

    const router = new MessageRouter(this.manager, (m) => this.post(m));
    view.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] message handling failed', err);
      }
    });

    view.onDidDispose(() => { this.view = undefined; });
  }

  // render() and makeNonce() unchanged from Task 1
}
```

- [ ] **Step 5: Update `src/extension.ts`**

```ts
import * as vscode from 'vscode';
import { PanelViewProvider } from './host/panel-view-provider';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
import { FakeProvider } from './providers/fake/fake-provider';
import type { AgentProvider } from './providers/types';

export async function activate(context: vscode.ExtensionContext) {
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);

  const providers = new Map<string, AgentProvider>();
  providers.set('fake', new FakeProvider(() => [
    { kind: 'text', delta: 'This is the fake provider. ' },
    { kind: 'turn-end', reason: 'done' },
  ]));

  let provider: PanelViewProvider;
  const manager = new SessionManager(store, providers, (msg) => provider.post(msg));
  await manager.init();

  provider = new PanelViewProvider(context.extensionUri, manager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    { dispose: () => { void manager.dispose(); } },
  );
}

export function deactivate() {}
```

- [ ] **Step 6: Run the tests**

Run: `yarn test:unit && yarn test`
Expected: unit PASS 30 passing; integration PASS 2 passing.

- [ ] **Step 7: Commit**

```bash
git add src/host src/extension.ts src/test/unit/message-router.test.ts
git commit -m "feat: route protocol messages between the webview and session manager"
```

---

## Task 8: Webview state layer

The client side of the protocol: typed transport plus a reducer over `HostToWebview`.

**Files:**
- Create: `src/webview/vscode-api.ts`
- Create: `src/webview/store.tsx`
- Modify: `src/webview/main.tsx`
- Create: `src/test/unit/webview-reducer.test.ts`
- Create: `src/webview/reducer.ts`

**Interfaces:**
- Produces: `src/webview/reducer.ts` exporting `interface ClientState { sessions: SessionSummary[]; layout: PaneLayout; catalog: ProviderInfo[]; byId: Record<SessionId, PaneState>; ready: boolean }`, `interface PaneState { summary: SessionSummary; items: TranscriptItem[]; hasMore: boolean; pending: PermissionRequest[] }`, `const initialState: ClientState`, `function reduce(state: ClientState, msg: HostToWebview): ClientState`.
- Produces: `src/webview/vscode-api.ts` exporting `function postToHost(msg: WebviewToHost): void` and `function onHostMessage(fn: (msg: HostToWebview) => void): () => void`.
- Produces: `src/webview/store.tsx` exporting `<StoreProvider>` and `useStore(): { state: ClientState; post: (m: WebviewToHost) => void }`.

The reducer lives in its own module, free of React, so it is unit-testable in the mocha harness.

- [ ] **Step 1: Write the failing test**

`src/test/unit/webview-reducer.test.ts`:

```ts
import * as assert from 'assert';
import { initialState, reduce } from '../../webview/reducer';
import type { SessionSnapshot, SessionSummary } from '../../protocol/messages';

function summary(id: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
    status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

function snapshot(id: string): SessionSnapshot {
  return { ...summary(id), items: [], hasMore: false, pending: [] };
}

suite('webview reducer', () => {
  test('hydrate populates sessions, layout, catalog and panes', () => {
    const next = reduce(initialState, {
      t: 'hydrate',
      sessions: [summary('s1')],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
      snapshots: [snapshot('s1')],
      catalog: [{ id: 'fake', displayName: 'Fake', models: [] }],
    });

    assert.strictEqual(next.ready, true);
    assert.strictEqual(next.sessions.length, 1);
    assert.strictEqual(next.layout.panes.length, 1);
    assert.ok(next.byId['s1']);
  });

  test('append patch adds an item', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 1, role: 'assistant', text: '' } },
    });
    assert.strictEqual(state.byId['s1'].items.length, 1);
  });

  test('delta patch appends to the targeted item only', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 1, role: 'assistant', text: 'He' } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'delta', itemId: 'a1', field: 'text', delta: 'llo' },
    });

    const item = state.byId['s1'].items[0] as { text: string };
    assert.strictEqual(item.text, 'Hello');
  });

  test('replace patch swaps an item in place, preserving order', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: {
        id: 't1', ts: 1, role: 'tool', toolId: 'x', name: 'Read',
        input: {}, state: 'running',
      } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 2, role: 'assistant', text: 'after' } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'replace', item: {
        id: 't1', ts: 1, role: 'tool', toolId: 'x', name: 'Read',
        input: {}, state: 'ok', output: 'done',
      } },
    });

    assert.strictEqual(state.byId['s1'].items[0].id, 't1');
    assert.strictEqual((state.byId['s1'].items[0] as { state: string }).state, 'ok');
    assert.strictEqual(state.byId['s1'].items[1].id, 'a1');
  });

  test('session-prepend puts history in front and updates hasMore', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'b', ts: 2, role: 'user', text: 'second' } },
    });
    state = reduce(state, {
      t: 'session-prepend', id: 's1', hasMore: false,
      items: [{ id: 'a', ts: 1, role: 'user', text: 'first' }],
    });

    assert.deepStrictEqual(state.byId['s1'].items.map((i) => i.id), ['a', 'b']);
    assert.strictEqual(state.byId['s1'].hasMore, false);
  });

  test('a patch for an unknown session is ignored', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 'ghost',
      patch: { op: 'append', item: { id: 'x', ts: 1, role: 'user', text: 'hi' } },
    });
    assert.deepStrictEqual(state.byId, {});
  });

  test('session-status updates both the pane and the roster entry', () => {
    let state = reduce(initialState, {
      t: 'sessions-changed', sessions: [summary('s1')],
    });
    state = reduce(state, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, { t: 'session-status', id: 's1', status: 'running' });

    assert.strictEqual(state.sessions[0].status, 'running');
    assert.strictEqual(state.byId['s1'].summary.status, 'running');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../webview/reducer`.

- [ ] **Step 3: Write `src/webview/reducer.ts`**

```ts
import type {
  HostToWebview, PaneLayout, PermissionRequest, ProviderInfo, SessionId,
  SessionSummary, TranscriptItem,
} from '../protocol/messages';

export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
}

export interface ClientState {
  ready: boolean;
  sessions: SessionSummary[];
  layout: PaneLayout;
  catalog: ProviderInfo[];
  byId: Record<SessionId, PaneState>;
}

export const initialState: ClientState = {
  ready: false,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
  catalog: [],
  byId: {},
};

export function reduce(state: ClientState, msg: HostToWebview): ClientState {
  switch (msg.t) {
    case 'hydrate': {
      const byId: Record<SessionId, PaneState> = {};
      for (const s of msg.snapshots) {
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
        };
      }
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, byId,
      };
    }

    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };

    case 'session-snapshot': {
      const s = msg.session;
      return {
        ...state,
        byId: {
          ...state.byId,
          [s.id]: { summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending },
        },
      };
    }

    case 'session-status': {
      const sessions = state.sessions.map((s) =>
        s.id === msg.id ? { ...s, status: msg.status } : s);
      const pane = state.byId[msg.id];
      if (!pane) { return { ...state, sessions }; }
      return {
        ...state,
        sessions,
        byId: {
          ...state.byId,
          [msg.id]: { ...pane, summary: { ...pane.summary, status: msg.status } },
        },
      };
    }

    case 'session-prepend': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: {
          ...state.byId,
          [msg.id]: { ...pane, items: [...msg.items, ...pane.items], hasMore: msg.hasMore },
        },
      };
    }

    case 'session-patch': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: applyPatch(pane, msg.patch) },
      };
    }
  }
}

type Patch = Extract<HostToWebview, { t: 'session-patch' }>['patch'];

function applyPatch(pane: PaneState, patch: Patch): PaneState {
  switch (patch.op) {
    case 'append':
      return {
        ...pane,
        items: [...pane.items, patch.item],
        pending: patch.item.role === 'permission' && patch.item.state === 'pending'
          ? [...pane.pending, {
              requestId: patch.item.requestId,
              name: patch.item.name,
              input: patch.item.input,
            }]
          : pane.pending,
      };

    case 'replace': {
      const items = pane.items.map((i) => (i.id === patch.item.id ? patch.item : i));
      const pending = patch.item.role === 'permission' && patch.item.state !== 'pending'
        ? pane.pending.filter((p) => p.requestId !== patch.item.requestId)
        : pane.pending;
      return { ...pane, items, pending };
    }

    case 'delta': {
      const items = pane.items.map((i) => {
        if (i.id !== patch.itemId || i.role !== 'assistant') { return i; }
        return { ...i, [patch.field]: (i[patch.field] ?? '') + patch.delta };
      });
      return { ...pane, items };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 37 passing total.

- [ ] **Step 5: Write `src/webview/vscode-api.ts`**

```ts
import type { HostToWebview, WebviewToHost } from '../protocol/messages';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToHost(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export function onHostMessage(fn: (msg: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<HostToWebview>) => fn(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
```

- [ ] **Step 6: Write `src/webview/store.tsx`**

```tsx
import {
  createContext, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialState, reduce, type ClientState } from './reducer';
import { onHostMessage, postToHost } from './vscode-api';
import type { WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: ClientState;
  post: (msg: WebviewToHost) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  return (
    <StoreContext.Provider value={{ state, post: postToHost }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
```

- [ ] **Step 7: Update `src/webview/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { StoreProvider, useStore } from './store';

function App() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="p-3 text-sm">
      {state.sessions.length} session(s), {state.catalog.length} provider(s)
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}
```

- [ ] **Step 8: Verify end to end**

Run: `yarn run compile`, then F5. The panel should read "0 session(s), 1 provider(s)" — proving `ready` → `hydrate` completes a full round trip.

- [ ] **Step 9: Commit**

```bash
git add src/webview src/test/unit/webview-reducer.test.ts
git commit -m "feat: add the webview transport and protocol reducer"
```

---

## Task 9: Vendor shadcn primitives

Bring in every primitive the UI tasks build on. shadcn's registry is **Base UI**-backed — `add` pulls `@base-ui/react` as a peer dependency. Do not add Radix packages alongside it.

**Files:**
- Create: `components.json`
- Create: `src/webview/components/ui/*` (vendored)
- Create: `src/webview/lib/utils.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `MessageScrollerProvider`, `MessageScroller`, `MessageScrollerViewport`, `MessageScrollerContent`, `MessageScrollerItem`, `MessageScrollerButton`, `useMessageScrollerVisibility` from `@/components/ui/message-scroller`.
- Produces: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` from `@/components/ui/resizable`.
- Produces: `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectGroup`, `SelectItem` from `@/components/ui/select`.
- Produces: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuCheckboxItem`, `DropdownMenuItem`, `DropdownMenuSeparator` from `@/components/ui/dropdown-menu`.
- Produces: `Button` from `@/components/ui/button`, `Textarea` from `@/components/ui/textarea`.
- Produces: `cn(...inputs: ClassValue[]): string` from `@/lib/utils`.

- [ ] **Step 1: Install runtime dependencies**

```bash
yarn add react-resizable-panels clsx tailwind-merge
yarn add -D @types/node
```

- [ ] **Step 2: Create `components.json`**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/webview/index.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  }
}
```

- [ ] **Step 3: Create `src/webview/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Add the components**

```bash
npx shadcn@latest add message-scroller resizable select dropdown-menu button textarea
```

**If the CLI fails** (it targets framework presets and may not recognise a bare esbuild project), fall back to copying the component source manually from its docs page — e.g. `https://ui.shadcn.com/docs/components/base/message-scroller`, `https://ui.shadcn.com/docs/components/base/select`. Save each to `src/webview/components/ui/<name>.tsx` in kebab-case, and install the Base UI peer dependency yourself:

```bash
yarn add @base-ui/react
```

Do not hand-write substitutes — `message-scroller`'s scroll behaviour is the whole reason for the dependency, and re-implementing `select` loses keyboard and screen-reader support.

- [ ] **Step 4b: Record the real exported names**

Base UI-backed components can differ from the Radix-era API this plan was written against. Read each vendored file and confirm the exports match the Interfaces block above:

```bash
grep -hn "^export" src/webview/components/ui/*.tsx
```

If a name differs (for example `DropdownMenuCheckboxItem` absent, or `Select` taking `items` rather than children), note the real signature and use it in Tasks 10–13 — the vendored source is authoritative over this plan.

- [ ] **Step 5: Verify the import alias resolves**

Add a temporary check to `src/webview/main.tsx`:

```tsx
import { cn } from '@/lib/utils';
console.log(cn('a', 'b'));
```

Run: `yarn run check-types && node esbuild.js`
Expected: no errors. esbuild must be told about the alias — add to **both** configs in `esbuild.js`:

```js
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
```

Then remove the temporary lines from `main.tsx`.

- [ ] **Step 6: Confirm no remote resources were introduced**

Run: `grep -rnE "https?://" src/webview/components/ui/ || echo "clean"`
Expected: only comments or docs URLs. Any `fetch`, `<link>`, or font import to a remote host must be removed — the CSP will block it at runtime.

- [ ] **Step 7: Commit**

```bash
git add components.json src/webview/lib src/webview/components/ui package.json yarn.lock esbuild.js
git commit -m "chore: vendor shadcn message-scroller and resizable primitives"
```

---

## Task 10: Transcript rendering

Renders a session's items with correct scroll behaviour under streaming.

**Files:**
- Create: `src/webview/components/transcript.tsx`
- Create: `src/webview/components/transcript-item.tsx`
- Create: `src/webview/components/tool-card.tsx`
- Modify: `src/webview/main.tsx`

**Interfaces:**
- Consumes: `PaneState` (Task 8), `MessageScroller*` (Task 9).
- Produces: `function Transcript({ pane, onLoadMore }: { pane: PaneState; onLoadMore: (beforeItemId: string) => void }): JSX.Element`.
- Produces: `function TranscriptItemView({ item }: { item: TranscriptItem }): JSX.Element`.

- [ ] **Step 1: Write `src/webview/components/tool-card.tsx`**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

function summarize(input: unknown): string {
  if (input === null || input === undefined) { return ''; }
  if (typeof input === 'string') { return input; }
  const text = JSON.stringify(input);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const dot = item.state === 'running' ? '○' : item.state === 'ok' ? '●' : '✕';

  return (
    <div className="my-1 rounded border border-border text-xs">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1 font-normal"
      >
        <span aria-hidden>{dot}</span>
        <span className="font-medium">{item.name}</span>
        <span className="truncate text-muted-foreground">{summarize(item.input)}</span>
      </Button>
      {open && (
        <pre className="overflow-x-auto border-t border-border px-2 py-1">
{JSON.stringify({ input: item.input, output: item.output }, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `src/webview/components/transcript-item.tsx`**

The permission case renders nothing here — Task 12 supplies `PermissionCard` and wires it in.

```tsx
import { ToolCard } from './tool-card';
import type { TranscriptItem } from '../../protocol/messages';

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.role) {
    case 'user':
      return (
        <div className="my-2 rounded bg-muted px-2 py-1 whitespace-pre-wrap">
          {item.text}
        </div>
      );

    case 'assistant':
      return (
        <div className="my-2 whitespace-pre-wrap">
          {item.thinking && (
            <div className="mb-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              {item.thinking}
            </div>
          )}
          {item.text}
        </div>
      );

    case 'tool':
      return <ToolCard item={item} />;

    case 'error':
      return (
        <div className="my-2 rounded border border-destructive px-2 py-1 text-xs text-destructive">
          {item.message}
        </div>
      );

    case 'permission':
      return null;
  }
}
```

- [ ] **Step 3: Write `src/webview/components/transcript.tsx`**

`scrollAnchor` on user messages is what makes `defaultScrollPosition="last-anchor"` land at the start of the last turn.

```tsx
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { TranscriptItemView } from './transcript-item';
import type { PaneState } from '../reducer';

export function Transcript({
  pane, onLoadMore,
}: {
  pane: PaneState;
  onLoadMore: (beforeItemId: string) => void;
}) {
  const first = pane.items[0];

  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
      preserveScrollOnPrepend
    >
      <MessageScroller className="h-full">
        <MessageScrollerViewport className="px-2">
          <MessageScrollerContent>
            {pane.hasMore && first && (
              <Button
                variant="outline"
                onClick={() => onLoadMore(first.id)}
                className="my-2 h-auto w-full py-1 text-xs"
              >
                Load earlier messages
              </Button>
            )}
            {pane.items.map((item) => (
              <MessageScrollerItem
                key={item.id}
                messageId={item.id}
                scrollAnchor={item.role === 'user'}
              >
                <TranscriptItemView item={item} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
```

- [ ] **Step 4: Render one session in `main.tsx` to verify**

Temporarily render the first pane so streaming can be observed:

```tsx
function App() {
  const { state, post } = useStore();
  if (!state.ready) { return <div className="p-3 text-sm">Loading…</div>; }

  const first = state.sessions[0];
  if (!first) {
    return (
      <Button
        className="m-3"
        onClick={() => post({ t: 'create-session', providerId: 'fake', cwd: '/tmp' })}
      >
        New session
      </Button>
    );
  }

  const pane = state.byId[first.id];
  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-hidden">
        {pane && <Transcript pane={pane} onLoadMore={(beforeItemId) =>
          post({ t: 'load-more', id: first.id, beforeItemId })} />}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="m-2"
        onClick={() => post({ t: 'send', id: first.id, text: 'hello' })}
      >
        Send test message
      </Button>
    </div>
  );
}
```

Add the matching imports, and post `set-visible` after creating a session so patches flow:

```tsx
  onClick={() => {
    post({ t: 'create-session', providerId: 'fake', cwd: '/tmp' });
  }}
```

then in `App`, keep the visible set in sync:

```tsx
  useEffect(() => {
    post({ t: 'set-visible', sessionIds: first ? [first.id] : [] });
  }, [first?.id]);
```

- [ ] **Step 5: Verify manually**

Run `yarn run compile`, press F5, create a session, send a test message. Expected: the user message appears, the fake provider's text follows, and the view scrolls to the live edge. Scroll up mid-stream and confirm the view does *not* jump back down.

- [ ] **Step 6: Commit**

```bash
git add src/webview
git commit -m "feat: render session transcripts with streaming-aware scrolling"
```

---

## Task 11: Composer, interrupt, effort

**Files:**
- Create: `src/webview/components/composer.tsx`
- Create: `src/webview/components/session-header.tsx`

**Interfaces:**
- Produces: `function Composer({ pane }: { pane: PaneState }): JSX.Element`.
- Produces: `function SessionHeader({ pane, models }: { pane: PaneState; models: ModelInfo[] }): JSX.Element`.

- [ ] **Step 1: Write `src/webview/components/composer.tsx`**

Effort is only rendered when the session's model declares it — the capability check the spec requires.

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { EffortLevel, ModelInfo, PermissionMode } from '../../protocol/messages';

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'ask',
  acceptEdits: 'auto-edits',
  plan: 'plan',
  dontAsk: 'deny',
  bypass: 'bypass',
};

/**
 * The `items` prop is what lets the trigger render the *label* of the selected
 * option. Without it Base UI's SelectValue falls back to the raw value, so the
 * trigger would read "acceptEdits" rather than "auto-edits".
 */
const MODE_ITEMS = (Object.keys(MODE_LABEL) as PermissionMode[])
  .map((value) => ({ value, label: MODE_LABEL[value] }));

export function Composer({ pane, model }: { pane: PaneState; model: ModelInfo | undefined }) {
  const { post } = useStore();
  const [text, setText] = useState('');
  const running = pane.summary.status === 'running'
    || pane.summary.status === 'awaiting-approval';

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) { return; }
    post({ t: 'send', id: pane.summary.id, text: trimmed });
    setText('');
  };

  return (
    <div className="border-t border-border p-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
        rows={3}
        placeholder="Message the agent…"
        className="resize-none text-sm"
      />
      <div className="mt-1 flex items-center gap-2 text-xs">
        {running ? (
          <Button variant="outline" size="sm" onClick={() =>
            post({ t: 'interrupt', id: pane.summary.id })}>
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={submit}>Send</Button>
        )}

        {model?.effort && (
          <Select
            items={model.effort.levels.map((level) => ({ value: level, label: level }))}
            value={pane.summary.effort ?? model.effort.default}
            onValueChange={(value: string) => post({
              t: 'set-effort', id: pane.summary.id, effort: value as EffortLevel,
            })}
          >
            <SelectTrigger className="h-7 w-24" aria-label="Effort">
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
          onValueChange={(value: string) => post({
            t: 'set-permission-mode', id: pane.summary.id, mode: value as PermissionMode,
          })}
        >
          <SelectTrigger className="h-7 w-28" aria-label="Permission mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
```

`MODE_LABEL` is typed `Record<PermissionMode, string>`, so if Task 14 Step 1 changes the union, this fails to compile rather than silently offering a mode the SDK rejects.

**Every `Select` in this codebase passes `items`.** It is what makes the closed trigger show the human label instead of the raw value. If Step 4b found the vendored `Select` does not accept `items`, use the render-function form instead — `<SelectValue>{(value: string) => MODE_LABEL[value as PermissionMode]}</SelectValue>` — and apply the same treatment anywhere a label differs from its value.
```

- [ ] **Step 2: Write `src/webview/components/session-header.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { SessionStatus } from '../../protocol/messages';

const DOT: Record<SessionStatus, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-primary animate-pulse',
  'awaiting-approval': 'bg-destructive',
  error: 'bg-destructive',
};

export function SessionHeader({ pane }: { pane: PaneState }) {
  const { post } = useStore();
  const s = pane.summary;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} aria-hidden />
      <span className="truncate font-medium" title={s.title}>{s.title}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {s.model}{s.effort ? ` · ${s.effort}` : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close session"
        onClick={() => post({ t: 'close-session', id: s.id })}
        className="h-5 w-5 shrink-0"
      >
        ×
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Wire both into `main.tsx`**

Replace the temporary test button with the real header and composer around `Transcript`. Look up the model from the catalog:

```tsx
  const provider = state.catalog.find((p) => p.id === pane.summary.providerId);
  const model = provider?.models.find((m) => m.id === pane.summary.model);
```

- [ ] **Step 4: Verify manually**

F5, create a session, type and press Enter. Expected:

1. The message sends; Send becomes Stop while running.
2. The effort dropdown appears for `fake-large` and is absent for `fake-small`.
3. **The permission-mode trigger reads `ask`, and selecting auto-edits leaves it reading `auto-edits` — never `default` or `acceptEdits`.** A raw value in the closed trigger means `items` was not honoured; switch to the `SelectValue` render-function form.
4. Both dropdowns are keyboard-navigable — Tab to focus, Enter/Space to open, arrows to move, Enter to pick.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components src/webview/main.tsx
git commit -m "feat: add the composer with interrupt, effort and permission-mode controls"
```

---

## Task 12: Permission cards

**Files:**
- Create: `src/webview/components/permission-card.tsx`
- Modify: `src/webview/components/transcript-item.tsx`

**Interfaces:**
- Produces: `function PermissionCard({ item, sessionId }: { item: Extract<TranscriptItem, { role: 'permission' }>; sessionId: SessionId }): JSX.Element`.

- [ ] **Step 1: Write `src/webview/components/permission-card.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

function diffPreview(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) { return undefined; }
  const record = input as Record<string, unknown>;
  const path = typeof record.file_path === 'string' ? record.file_path : undefined;
  if (!path) { return undefined; }
  const oldText = typeof record.old_string === 'string' ? record.old_string : undefined;
  const newText = typeof record.new_string === 'string' ? record.new_string
    : typeof record.content === 'string' ? record.content : undefined;
  if (oldText === undefined && newText === undefined) { return undefined; }

  const lines = [`--- ${path}`];
  if (oldText !== undefined) {
    lines.push(...oldText.split('\n').map((l) => `- ${l}`));
  }
  if (newText !== undefined) {
    lines.push(...newText.split('\n').map((l) => `+ ${l}`));
  }
  return lines.join('\n');
}

export function PermissionCard({
  item, sessionId,
}: {
  item: PermissionItem;
  sessionId: SessionId;
}) {
  const { post } = useStore();
  const diff = diffPreview(item.input);

  if (item.state !== 'pending') {
    return (
      <div className="my-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground">
        {item.name} — {item.state}
        {item.reason ? `: ${item.reason}` : ''}
      </div>
    );
  }

  const decide = (allow: boolean) => post({
    t: 'permission-decision',
    id: sessionId,
    requestId: item.requestId,
    decision: allow ? { allow: true } : { allow: false, reason: 'Denied by user' },
  });

  return (
    <div className="my-2 rounded border-2 border-destructive p-2 text-xs">
      <div className="mb-1 font-medium">Allow {item.name}?</div>
      <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1">
{diff ?? JSON.stringify(item.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide(true)}>Allow</Button>
        <Button variant="outline" size="sm" onClick={() => decide(false)}>Deny</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `transcript-item.tsx`**

`TranscriptItemView` now needs the session id. Change its signature and the `permission` branch:

```tsx
export function TranscriptItemView({
  item, sessionId,
}: {
  item: TranscriptItem;
  sessionId: SessionId;
}) {
  // ...
    case 'permission':
      return <PermissionCard item={item} sessionId={sessionId} />;
}
```

Update the call site in `transcript.tsx`:

```tsx
                <TranscriptItemView item={item} sessionId={pane.summary.id} />
```

- [ ] **Step 3: Verify with a scripted permission**

Temporarily change the `FakeProvider` script in `src/extension.ts`:

```ts
  providers.set('fake', new FakeProvider((text) => text.includes('rm')
    ? [{ kind: 'permission', id: `p-${Date.now()}`, name: 'Bash', input: { command: text } }]
    : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]));
```

F5, send "rm -rf /tmp/x". Expected: an Allow/Deny card renders, the header dot turns to the awaiting-approval colour, and clicking Allow settles the card to "allowed". Keep this script — it is useful for the remaining tasks.

- [ ] **Step 4: Commit**

```bash
git add src/webview src/extension.ts
git commit -m "feat: approve or deny tool calls from the transcript"
```

---

## Task 13: Split panes and roster

**Files:**
- Create: `src/webview/components/pane-group.tsx`
- Create: `src/webview/components/session-picker.tsx`
- Modify: `src/webview/main.tsx`

**Interfaces:**
- Consumes: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` (Task 9).
- Produces: `function PaneGroup(): JSX.Element` — reads layout from the store, renders one pane per entry.
- Produces: `function SessionPicker(): JSX.Element` — roster dropdown plus new/open/delete.

- [ ] **Step 1: Write `src/webview/components/pane-group.tsx`**

The `ResizeObserver` guard implements the responsive rule: below 500px, force vertical and restore the stored orientation when widened.

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable';
import { SessionHeader } from './session-header';
import { Transcript } from './transcript';
import { Composer } from './composer';
import { useStore } from '../store';

const NARROW_PX = 500;

export function PaneGroup() {
  const { state, post } = useStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < NARROW_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const panes = state.layout.panes.filter((p) => state.byId[p.sessionId]);
  const orientation = narrow ? 'vertical' : state.layout.orientation;

  if (panes.length === 0) {
    return (
      <div ref={rootRef} className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        No open sessions.
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full">
      <ResizablePanelGroup
        orientation={orientation}
        onLayoutChange={(sizes: number[]) => post({
          t: 'set-layout',
          layout: {
            orientation: state.layout.orientation,
            panes: panes.map((p, i) => ({ sessionId: p.sessionId, size: sizes[i] ?? p.size })),
          },
        })}
      >
        {panes.map((pane, index) => {
          const paneState = state.byId[pane.sessionId];
          const provider = state.catalog.find((p) => p.id === paneState.summary.providerId);
          const model = provider?.models.find((m) => m.id === paneState.summary.model);
          return (
            <>
              {index > 0 && <ResizableHandle key={`h-${pane.sessionId}`} withHandle />}
              <ResizablePanel
                key={pane.sessionId}
                defaultSize={pane.size}
                minSize={15}
                collapsible
              >
                <div className="flex h-full flex-col">
                  <SessionHeader pane={paneState} />
                  <div className="min-h-0 flex-1">
                    <Transcript
                      pane={paneState}
                      onLoadMore={(beforeItemId) => post({
                        t: 'load-more', id: pane.sessionId, beforeItemId,
                      })}
                    />
                  </div>
                  <Composer pane={paneState} model={model} />
                </div>
              </ResizablePanel>
            </>
          );
        })}
      </ResizablePanelGroup>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/webview/components/session-picker.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';
import type { SessionId } from '../../protocol/messages';

export function SessionPicker() {
  const { state, post } = useStore();
  const open = new Set(state.layout.panes.map((p) => p.sessionId));

  const setPanes = (ids: SessionId[]) => {
    const size = ids.length > 0 ? 100 / ids.length : 100;
    post({
      t: 'set-layout',
      layout: {
        orientation: state.layout.orientation,
        panes: ids.map((sessionId) => ({ sessionId, size })),
      },
    });
    post({ t: 'set-visible', sessionIds: ids });
  };

  const toggle = (id: SessionId) => {
    setPanes(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]);
  };

  const providerId = state.catalog[0]?.id;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start" />}
        >
          Sessions ({open.size}/{state.sessions.length})
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {state.sessions.length === 0 && (
            <DropdownMenuItem disabled>No sessions yet</DropdownMenuItem>
          )}
          {state.sessions.map((s) => (
            <DropdownMenuCheckboxItem
              key={s.id}
              checked={open.has(s.id)}
              onCheckedChange={() => toggle(s.id)}
            >
              <span className="truncate">{s.title}</span>
              {s.archived && (
                <span className="ml-auto pl-2 text-muted-foreground">archived</span>
              )}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          {state.sessions.map((s) => (
            <DropdownMenuItem
              key={`del-${s.id}`}
              variant="destructive"
              onClick={() => post({ t: 'delete-session', id: s.id })}
            >
              Delete “{s.title}”
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        size="icon"
        aria-label="Toggle split orientation"
        className="h-7 w-7 shrink-0"
        onClick={() => post({
          t: 'set-layout',
          layout: {
            ...state.layout,
            orientation: state.layout.orientation === 'vertical' ? 'horizontal' : 'vertical',
          },
        })}
      >
        {state.layout.orientation === 'vertical' ? '⬍' : '⬌'}
      </Button>

      <Button
        size="sm"
        className="shrink-0"
        disabled={!providerId}
        onClick={() => providerId && post({ t: 'create-session', providerId, cwd: '' })}
      >
        + New
      </Button>
    </div>
  );
}
```

A `DropdownMenu` with checkbox items, not a `Select`: opening panes is inherently multi-select, and a `Select` can only hold one value. The trigger shows `open/total` so the roster state is legible without opening it.

Base UI composes a trigger with another component via a `render` prop rather than Radix's `asChild`. If Step 4b showed the vendored `dropdown-menu` uses `asChild`, swap to `<DropdownMenuTrigger asChild><Button …>…</Button></DropdownMenuTrigger>`. Likewise, drop `variant="destructive"` from `DropdownMenuItem` if the vendored version has no such prop and use `className="text-destructive"`.
```

- [ ] **Step 3: Make new sessions open into a pane**

In `main.tsx`, when `sessions-changed` introduces a session not in the layout, add it. Simplest correct approach — an effect that reconciles:

```tsx
  useEffect(() => {
    const known = new Set(state.layout.panes.map((p) => p.sessionId));
    const missing = Object.keys(state.byId).filter((id) => !known.has(id));
    if (missing.length === 0) { return; }
    const ids = [...state.layout.panes.map((p) => p.sessionId), ...missing];
    const size = 100 / ids.length;
    post({
      t: 'set-layout',
      layout: {
        orientation: state.layout.orientation,
        panes: ids.map((sessionId) => ({ sessionId, size })),
      },
    });
    post({ t: 'set-visible', sessionIds: ids });
  }, [Object.keys(state.byId).join(','), state.layout.panes.length]);
```

Final `App`:

```tsx
function App() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="flex h-screen flex-col">
      <SessionPicker />
      <div className="min-h-0 flex-1"><PaneGroup /></div>
    </div>
  );
}
```

- [ ] **Step 4: Use the workspace folder as the default cwd**

`cwd: ''` in the picker is wrong — resolve it host-side. In `message-router.ts`, the `create-session` case must not import `vscode`, so resolve it in `extension.ts` instead by passing a default into `SessionManager.create`. Simplest: in `MessageRouter`, replace `msg.cwd` with `msg.cwd || this.defaultCwd`, and add a third constructor parameter:

```ts
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly defaultCwd: string,
  ) {}
```

Pass it from `PanelViewProvider`, which receives it from `extension.ts`:

```ts
const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
```

Update `PanelViewProvider`'s constructor to `(extensionUri, manager, defaultCwd)` and the `MessageRouter` construction accordingly. Update `message-router.test.ts` to pass `'/tmp'` as the third argument.

- [ ] **Step 5: Verify manually**

F5. Expected:
1. "+ New" twice creates two panes, split vertically.
2. Dragging the handle resizes; the split survives a window reload.
3. The orientation toggle switches to side-by-side when the sidebar is wide.
4. Narrowing the sidebar below ~500px forces stacking; widening restores the chosen orientation.
5. Closing a pane's session removes the pane and leaves the session in the picker marked `[archived]`.

- [ ] **Step 6: Run all tests**

Run: `yarn test:unit && yarn test`
Expected: unit PASS 37 passing; integration PASS 2 passing.

- [ ] **Step 7: Commit**

```bash
git add src/webview src/host src/extension.ts src/test/unit/message-router.test.ts
git commit -m "feat: add resizable split panes and the session roster"
```

---

## Task 14: Claude provider

Deliberately last in reading order — everything above is already proven against `FakeProvider`.

**Splits for parallel execution** (see Parallelization above): **T14a** is Steps 1–6 and touches only `src/providers/claude/`, so it can run during wave 4. **T14b** is Steps 7–8, which edit `extension.ts` and `esbuild.js`, and must follow Task 13.

**Files:**
- Create: `src/providers/claude/map-events.ts`
- Create: `src/providers/claude/claude-provider.ts`
- Create: `src/test/unit/map-events.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `function mapEvent(msg: SDKMessage): AgentEvent[]` from `map-events.ts`.
- Produces: `class ClaudeProvider implements AgentProvider` with `constructor()`.

- [ ] **Step 1: Install and read the actual type definitions**

```bash
yarn add @anthropic-ai/claude-agent-sdk
```

Then read the installed types — **do not rely on this plan's recollection of the SDK surface**:

```bash
find node_modules/@anthropic-ai/claude-agent-sdk -name "*.d.ts" | head
```

Read the file and write down, in `src/providers/claude/map-events.ts` as a header comment, the exact:
- `Options` fields for `cwd`, `model`, `resume`, `permissionMode`, `canUseTool`, `includePartialMessages`, `stderr`
- the `PermissionMode` union members
- the `SDKMessage` variants and the shape of `SDKUserMessage`
- the `Query` interface (`interrupt`, `setPermissionMode`, and whether anything sets effort)

**Pin the permission modes especially carefully.** The published reference lists `'default' | 'dontAsk' | 'plan' | 'bypassPermissions'` and does *not* mention `acceptEdits`, yet auto-accept-edits is a mode Claude Code exposes interactively (shift+tab). Our union carries all five. Read the `.d.ts` and record the real union in the header comment, then reconcile:

- If `acceptEdits` exists under that or another name, map ours to it.
- If it genuinely does not exist in the SDK, drop `acceptEdits` from `PermissionMode` in `src/providers/types.ts` **and** remove its `<option>` from `composer.tsx` — do not leave a UI control that silently maps to `'default'`.

Same rule for every other member. **The `.d.ts` wins over this plan.** Any change to our union must update `src/providers/types.ts`, the `PERMISSION_MODE` table in Step 6, and `composer.tsx` together.

If the SDK exposes no way to set effort, `setEffort` stores the value and applies it on the next `send` — record that in the header comment and implement accordingly. No protocol change is needed either way.

- [ ] **Step 2: Write the failing test**

`src/test/unit/map-events.test.ts` — adjust the literal message shapes to the real `SDKMessage` variants found in Step 1 before running.

```ts
import * as assert from 'assert';
import { mapEvent } from '../../providers/claude/map-events';

suite('mapEvent', () => {
  test('system init yields a session event carrying the session id', () => {
    const events = mapEvent({
      type: 'system', subtype: 'init', session_id: 'abc123',
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'session', resumeToken: 'abc123' }]);
  });

  test('assistant text blocks become text events', () => {
    const events = mapEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'text', delta: 'Hello' }]);
  });

  test('assistant tool_use blocks become tool-start events', () => {
    const events = mapEvent({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
  });

  test('user tool_result blocks become tool-end events', () => {
    const events = mapEvent({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-end', id: 'toolu_1', ok: true, output: 'ok' },
    ]);
  });

  test('a successful result yields usage and turn-end', () => {
    const events = mapEvent({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'usage', inputTokens: 10, outputTokens: 20 },
      { kind: 'turn-end', reason: 'done' },
    ]);
  });

  test('an error result yields turn-end with the error', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', error: 'boom',
    } as never);
    assert.strictEqual(events.at(-1)?.kind, 'turn-end');
    assert.deepStrictEqual(
      events.at(-1),
      { kind: 'turn-end', reason: 'error', error: 'boom' },
    );
  });

  test('unrecognised messages produce no events', () => {
    assert.deepStrictEqual(mapEvent({ type: 'stream_event' } as never), []);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test:unit`
Expected: FAIL — cannot find module `../../providers/claude/map-events`.

- [ ] **Step 4: Write `src/providers/claude/map-events.ts`**

Defensive narrowing throughout — the SDK union is wider than what we map, and unknown variants must be dropped, never thrown on.

```ts
// SDK surface verified against node_modules/@anthropic-ai/claude-agent-sdk on
// <DATE>. Record here the exact Options fields, PermissionMode members, and
// SDKMessage variants read in Step 1, and update this comment whenever the
// dependency is upgraded.
import type { AgentEvent } from '../types';

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocks(msg: unknown): Block[] {
  const message = (msg as { message?: { content?: unknown } }).message;
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
}

export function mapEvent(msg: unknown): AgentEvent[] {
  const type = (msg as { type?: string }).type;

  if (type === 'system') {
    const sessionId = (msg as { session_id?: string }).session_id;
    return sessionId ? [{ kind: 'session', resumeToken: sessionId }] : [];
  }

  if (type === 'assistant') {
    const out: AgentEvent[] = [];
    for (const block of blocks(msg)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'text', delta: block.text });
      } else if (block.type === 'thinking' && typeof block.text === 'string') {
        out.push({ kind: 'thinking', delta: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({
          kind: 'tool-start', id: block.id, name: block.name, input: block.input,
        });
      }
    }
    return out;
  }

  if (type === 'user') {
    const out: AgentEvent[] = [];
    for (const block of blocks(msg)) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        out.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          output: block.content,
        });
      }
    }
    return out;
  }

  if (type === 'result') {
    const out: AgentEvent[] = [];
    const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (usage) {
      out.push({
        kind: 'usage',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      });
    }
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype === 'success') {
      out.push({ kind: 'turn-end', reason: 'done' });
    } else {
      const error = (msg as { error?: string }).error;
      out.push({ kind: 'turn-end', reason: 'error', error: error ?? subtype ?? 'Agent error' });
    }
    return out;
  }

  return [];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit`
Expected: PASS, 44 passing total. If a shape assertion fails, correct the *test* to the real SDK shape from Step 1 and re-run — the `.d.ts` is authoritative.

- [ ] **Step 6: Write `src/providers/claude/claude-provider.ts`**

`canUseTool` is the bridge: it parks its `resolve` and emits a `permission` event, exactly as `FakeProvider` does. Adjust the `query`/`Options` call shape to what Step 1 found.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mapEvent } from './map-events';
import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, ModelInfo, PermissionMode,
  StartOptions, ToolDecision,
} from '../types';

const MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5', displayName: 'Opus 5',
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
  },
  {
    id: 'claude-sonnet-5', displayName: 'Sonnet 5',
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
  },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
];

/**
 * Ours -> the SDK's. Every value on the right is corrected in Step 1 against
 * the installed .d.ts — these are the plan's best guess, not verified fact.
 */
const PERMISSION_MODE: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypass: 'bypassPermissions',
};

class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const next = this.queue.shift();
        if (next !== undefined) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined as never, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude';

  listModels(): ModelInfo[] { return MODELS; }

  start(opts: StartOptions): AgentRun {
    const events = new Channel<AgentEvent>();
    const prompts = new Channel<unknown>();
    const approvals = new Map<string, (decision: ToolDecision) => void>();
    let permissionCounter = 0;
    let effort = opts.effort;

    const session = query({
      prompt: prompts as AsyncIterable<never>,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        resume: opts.resumeToken,
        permissionMode: PERMISSION_MODE[opts.permissionMode],
        canUseTool: async (request: { tool_name?: string; name?: string; input?: unknown }) => {
          const id = `perm-${++permissionCounter}`;
          events.push({
            kind: 'permission',
            id,
            name: request.tool_name ?? request.name ?? 'tool',
            input: request.input,
          });
          const decision = await new Promise<ToolDecision>((resolve) => {
            approvals.set(id, resolve);
          });
          return decision.allow
            ? { behavior: 'allow', updatedInput: decision.updatedInput ?? request.input }
            : { behavior: 'deny', message: decision.reason ?? 'Denied by user' };
        },
        stderr: (data: string) => { console.error('[claude]', data); },
      },
    } as never) as AsyncIterable<unknown> & { interrupt?: () => Promise<unknown> };

    const pump = (async () => {
      try {
        for await (const msg of session) {
          for (const event of mapEvent(msg)) { events.push(event); }
        }
      } catch (err) {
        events.push({
          kind: 'turn-end',
          reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return {
      events,
      send: (text: string) => {
        prompts.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: opts.resumeToken ?? '',
        });
      },
      respondToTool: (id, decision) => {
        const resolve = approvals.get(id);
        if (resolve) { approvals.delete(id); resolve(decision); }
      },
      setEffort: (next: EffortLevel) => { effort = next; void effort; },
      interrupt: async () => { await session.interrupt?.(); },
      dispose: async () => {
        for (const [, resolve] of approvals) {
          resolve({ allow: false, reason: 'Session closed' });
        }
        approvals.clear();
        prompts.close();
        events.close();
        await pump;
      },
    };
  }
}
```

The `send` payload shape and the `canUseTool` return shape must match Step 1's findings — correct them if the `.d.ts` differs.

- [ ] **Step 7: Register the provider**

In `src/extension.ts`, add alongside the fake one:

```ts
import { ClaudeProvider } from './providers/claude/claude-provider';
// ...
  providers.set('claude', new ClaudeProvider());
```

Order matters — `SessionPicker` uses `state.catalog[0]` for the New button, so register Claude first.

- [ ] **Step 8: Exclude the SDK from the host bundle**

The SDK spawns the `claude` CLI and reads files at runtime; bundling it can break those paths. Add to the host config in `esbuild.js`:

```js
		external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
```

Since it is now resolved at runtime, it must ship with the extension. Remove `node_modules/**` from `.vscodeignore` **only if** packaging fails to find it; first try `vsce package` and check the resulting `.vsix` contains the SDK.

- [ ] **Step 9: Verify manually**

Ensure the `claude` CLI is authenticated (`claude` in a terminal once). F5, create a Claude session, send "list the files in this folder".

Expected: text streams in; a permission card appears for the first tool call; approving it runs the tool and its result renders in the collapsed tool card; Stop interrupts a long run. If auth is missing, expect a red error item — confirm the message is legible rather than a raw stack trace, and improve `map-events.ts`'s error text if not.

- [ ] **Step 10: Run all tests**

Run: `yarn test:unit && yarn test`
Expected: unit PASS 44 passing; integration PASS 2 passing.

- [ ] **Step 11: Commit**

```bash
git add src package.json yarn.lock esbuild.js
git commit -m "feat: add the Claude Agent SDK provider"
```

---

## Task 15: First-run guidance and packaging

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Create: `media/walkthrough-sidebar.md`

**Interfaces:**
- Produces: a `contributes.walkthroughs` entry explaining the secondary-sidebar drag.

- [ ] **Step 1: Add the walkthrough to `package.json`**

```json
    "walkthroughs": [
      {
        "id": "hiiiid-code.setup",
        "title": "Set up the HiiiiD Code panel",
        "description": "Move the HiiiiD Code panel into the secondary sidebar",
        "steps": [
          {
            "id": "move-to-secondary",
            "title": "Move HiiiiD Code to the secondary sidebar",
            "description": "VS Code extensions cannot place a view in the secondary sidebar directly. Open the secondary sidebar with Ctrl+Alt+B, then drag the HiiiiD Code icon from the activity bar into it. VS Code remembers the location.",
            "media": { "markdown": "media/walkthrough-sidebar.md", "altText": "Drag HiiiiD Code to the secondary sidebar" }
          }
        ]
      }
    ]
```

- [ ] **Step 2: Write `media/walkthrough-sidebar.md`**

```markdown
## Move HiiiiD Code to the secondary sidebar

1. Open the secondary sidebar — **View → Appearance → Secondary Side Bar**, or `Ctrl+Alt+B`.
2. Drag the **HiiiiD Code** icon from the activity bar into the secondary sidebar.
3. Widen it by dragging its inner edge — split panes need the room.

VS Code stores this per profile and workspace, so it only has to be done once.
```

- [ ] **Step 3: Rewrite `README.md`**

Replace the template contents with: what the extension does, the secondary-sidebar setup step, a note that the `claude` CLI must be authenticated, and a list of what v1 does not do (Codex/OpenCode providers, retention, virtualized scrolling).

- [ ] **Step 4: Verify packaging**

```bash
yarn run package
npx @vscode/vsce package --no-dependencies
```

Expected: a `.vsix` is produced with no errors. Inspect it:

```bash
npx @vscode/vsce ls
```

Confirm `dist/extension.js`, `dist/webview.js`, `dist/webview.css`, `media/`, and the Claude SDK are present, and that `src/` is not.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md media
git commit -m "docs: add first-run walkthrough for secondary-sidebar placement"
```

---

## Self-Review Notes

Checked against the spec, section by section.

**Covered:** placement constraint (Tasks 1, 15) · host-owned architecture (Tasks 5–7) · module layout and kebab-case (all) · provider seam with model/effort capability data (Tasks 2, 14) · fixed model, mutable effort (Tasks 2, 6, 11) · session state (Task 5) · JSONL persistence, lazy paged loads, close-vs-delete (Tasks 4, 6) · full protocol (Task 3) · host-as-source-of-truth and visible-only fan-out (Tasks 6, 8) · split panes with responsive orientation guard and host-side layout persistence (Task 13) · MessageScroller with `last-anchor` and prepend paging (Tasks 9, 10) · permission cards with diff preview (Task 12) · two-bundle build, CSP with nonce, theme-token bridge (Tasks 1, 9) · all four error classes (Tasks 5, 12, 14) · the full testing plan (Tasks 2–8, 14).

**Deliberate deviations from the spec, both stated where they occur:**
1. `TranscriptStore` caches a whole session file rather than a bounded in-memory window (Task 4). Simpler, bounded by one conversation, same public signatures if it needs to change.
2. `PermissionMode` is `'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypass'`, a superset of the spec's `'default' | 'acceptEdits' | 'bypass'` — `plan` and `dontAsk` come from the SDK's documented union. `acceptEdits` (auto-accept edits, still prompt for the rest) is kept because it is the mode a chat UI most wants, even though the published reference omits it; Task 14 Step 1 either maps it or removes it from both the type and the UI.

**Not covered, by design:** compress-on-archive and retention remain the spec's open questions.

**Known soft spot:** Task 14 depends on an SDK surface this plan could not fully verify, which is why it is last, why Step 1 is a read-the-types step, and why Step 5 says the `.d.ts` wins over the test. Every module before it is proven against `FakeProvider`, so a wrong guess there costs one task, not the plan.
