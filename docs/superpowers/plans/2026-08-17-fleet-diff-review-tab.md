# Fleet Diff Review Editor Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the fleet diff review surface out of the 300–500px sidebar into an editor-area `WebviewPanel` with its own bundle, and give it the structure and power-user paths the critique gate found missing.

**Architecture:** A second `vscode.WebviewPanel` renders a third esbuild bundle (`dist/review.js`) with its own narrow reducer. `SessionManager`'s single `post` callback becomes a `PostBus` whose clients register a predicate, so the review client receives the roster, statuses and `fleet-diff` but never `session-patch` — leaving the "patches fan out only to visible sessions" invariant exactly where it is.

**Tech Stack:** TypeScript, React 19, Tailwind v4, esbuild, shadcn over Base UI (`@base-ui/react`), mocha (`--ui tdd`) with `tsx/cjs`, jsdom via `global-jsdom`.

**Spec:** [docs/superpowers/specs/2026-08-17-fleet-diff-review-tab-design.md](../specs/2026-08-17-fleet-diff-review-tab-design.md)

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts` imports `vscode`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- **Errors are state, never exceptions.** Nothing rejects across `postMessage`.
- Transcript patches fan out only to visible sessions. `sessions-changed` and `session-status` are ungated.
- The webview loads no remote resources. CSP: `default-src 'none'`; scripts/styles restricted to `webview.cspSource` plus a per-load CSPRNG nonce; `localResourceRoots` pinned to `dist/`.
- **Filenames are kebab-case**, including `.tsx`. Component identifiers stay PascalCase.
- **No raw HTML controls.** Use `Button`, `Input`, `Select`, `DropdownMenu` from `@/components/ui/*`. Compose classNames with `cn` from `@/lib/utils` — never template literals.
- Prefer short Tailwind token utilities (`bg-muted`, `text-muted-foreground`); arbitrary values only for computed values (`min()`, `calc()`, `color-mix()`).
- **Never pass a DOM node to an assertion.** `assert.strictEqual(el === null, true)`, never `assert.strictEqual(el, null)`. The node-valued form allocated 3.5GB in 4 seconds on 2026-08-14.
- DOM tests drive components through the real `StoreProvider` with genuine `HostToWebview` messages. Never mock a store or hand-build state.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after every task.
- **No `Co-Authored-By: Claude` trailer** on any commit.
- Gate commands are pinned with their own `cd` — shell cwd reverts mid-session:
  `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile`

---

### Task 1: `PostBus` — one host, many clients

**Files:**
- Create: `src/host/post-bus.ts`
- Test: `src/test/unit/post-bus.test.ts`

**Interfaces:**
- Produces: `class PostBus { add(client: PostClient): () => void; post(msg: HostToWebview): void }`, `interface PostClient { post(msg: HostToWebview): void; wants(msg: HostToWebview): boolean }`

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { PostBus, REVIEW_WANTS } from '../../host/post-bus';
import type { HostToWebview } from '../../protocol/messages';

suite('PostBus', () => {
  test('delivers only what a client wants', () => {
    const bus = new PostBus();
    const all: HostToWebview[] = [];
    const some: HostToWebview[] = [];
    bus.add({ post: (m) => all.push(m), wants: () => true });
    bus.add({ post: (m) => some.push(m), wants: REVIEW_WANTS });

    bus.post({ t: 'session-status', id: 's1', status: 'idle' } as HostToWebview);
    bus.post({ t: 'session-patch', id: 's1', items: [] } as unknown as HostToWebview);

    assert.strictEqual(all.length, 2);
    assert.strictEqual(some.length, 1);
    assert.strictEqual(some[0].t, 'session-status');
  });

  test('a review client never receives session-patch', () => {
    assert.strictEqual(REVIEW_WANTS({ t: 'session-patch' } as HostToWebview), false);
    assert.strictEqual(REVIEW_WANTS({ t: 'fleet-diff', trees: [] } as HostToWebview), true);
    assert.strictEqual(REVIEW_WANTS({ t: 'sessions-changed' } as unknown as HostToWebview), true);
  });

  test('remove stops delivery', () => {
    const bus = new PostBus();
    const got: HostToWebview[] = [];
    const remove = bus.add({ post: (m) => got.push(m), wants: () => true });
    remove();
    bus.post({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.strictEqual(got.length, 0);
  });

  test('one client throwing does not stop the others', () => {
    const bus = new PostBus();
    const got: HostToWebview[] = [];
    bus.add({ post: () => { throw new Error('disposed webview'); }, wants: () => true });
    bus.add({ post: (m) => got.push(m), wants: () => true });
    bus.post({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.strictEqual(got.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep PostBus`
Expected: FAIL — `Cannot find module '../../host/post-bus'`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { HostToWebview } from '../protocol/messages';

/**
 * One registered surface. `wants` is the whole gate: a client that does not
 * want a message never sees it, so widening the fan-out cannot accidentally
 * widen what a narrow client receives.
 */
export interface PostClient {
  post(msg: HostToWebview): void;
  wants(msg: HostToWebview): boolean;
}

/**
 * What the review tab subscribes to.
 *
 * Deliberately an allow-list, not a deny-list. `session-patch` is gated on the
 * visible set and that gating lives in SessionManager; the review client simply
 * never asks for it, so there is no second place where visibility is decided.
 * A new message type defaults to *not* reaching the review tab, which is the
 * safe direction to fail.
 */
export const REVIEW_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'ready' || msg.t === 'sessions-changed'
  || msg.t === 'session-status' || msg.t === 'fleet-diff';

export class PostBus {
  private readonly clients = new Set<PostClient>();

  add(client: PostClient): () => void {
    this.clients.add(client);
    return () => { this.clients.delete(client); };
  }

  /**
   * A disposed webview can throw from `postMessage`. One dead client must not
   * cost the others their message — errors are state, and a fan-out that
   * aborts halfway is a state nobody can reconstruct.
   */
  post(msg: HostToWebview): void {
    for (const client of this.clients) {
      if (!client.wants(msg)) { continue; }
      try {
        client.post(msg);
      } catch (err) {
        console.error('[hiiiid-code] a webview client failed to receive', msg.t, err);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep PostBus`
Expected: PASS (4 passing)

- [ ] **Step 5: Wire it in `extension.ts`**

Replace the manager construction at `src/extension.ts:106-109`:

```ts
  let provider: PanelViewProvider;
  const bus = new PostBus();
  const manager = new SessionManager(
    store, providers, (msg) => bus.post(msg), undefined, warnAboutProfile, attachments,
  );
  // The sidebar is the client that wants everything. Registered here rather
  // than inside PanelViewProvider so there is one place that says which
  // surfaces exist and what each of them sees.
  bus.add({ post: (msg) => provider.post(msg), wants: () => true });
```

Add the import beside the other host imports:

```ts
import { PostBus, REVIEW_WANTS } from './host/post-bus';
```

`REVIEW_WANTS` is unused until Task 2 — import it there instead if lint flags it.

Also update the `contextSub` line so the editor-context push still reaches only the sidebar (it is a panel-only message):

```ts
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));
```

(unchanged — it already posts directly to the provider, not through the manager.)

- [ ] **Step 6: Run the gates**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn lint && yarn check-types`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/host/post-bus.ts src/test/unit/post-bus.test.ts src/extension.ts
git commit -m "feat: fan host messages out through a PostBus"
```

---

### Task 2: The review panel — host side

**Files:**
- Create: `src/host/webview-html.ts`, `src/host/review-panel.ts`
- Modify: `src/host/panel-view-provider.ts` (extract HTML, intercept `open-review`), `src/protocol/messages.ts` (add `open-review`), `src/extension.ts` (construct, command, serializer), `package.json` (command + keybinding)
- Test: `src/test/unit/webview-html.test.ts`

**Interfaces:**
- Consumes: `PostBus`, `REVIEW_WANTS` from Task 1.
- Produces: `renderWebviewHtml(webview, opts: { scriptName: string; styleName: string; extensionUri: Uri; attachmentBase?: string }): string`; `class ReviewPanel { open(): void; restore(panel: vscode.WebviewPanel): void; dispose(): void }`; wire message `{ t: 'open-review' }`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/webview-html.test.ts` — this file must not import `vscode`, so it passes a minimal stub shaped like the two `Webview` members the renderer uses.

```ts
import * as assert from 'node:assert';
import { renderWebviewHtml, type HtmlWebview } from '../../host/webview-html';

const webview: HtmlWebview = {
  cspSource: 'vscode-webview://x',
  asWebviewUri: (u: { toString(): string }) => ({ toString: () => `wv:${u.toString()}` }),
};

suite('renderWebviewHtml', () => {
  test('pins default-src none and a per-load nonce', () => {
    const a = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });
    const b = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });

    assert.strictEqual(a.includes("default-src 'none'"), true);
    assert.strictEqual(a.includes("script-src 'nonce-"), true);
    // Two loads, two nonces. A reused nonce is a nonce that is not one.
    const nonceOf = (html: string) => /nonce-([A-Za-z0-9_-]+)/.exec(html)?.[1];
    assert.strictEqual(nonceOf(a) === nonceOf(b), false);
  });

  test('loads no remote resources', () => {
    const html = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'dist/review.js' },
      styleUri: { toString: () => 'dist/review.css' },
      title: 'Changes',
    });
    assert.strictEqual(/https?:\/\//.test(html), false);
  });

  test('carries the attachment base only when given one', () => {
    const withBase = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'a.js' }, styleUri: { toString: () => 'a.css' },
      title: 'x', attachmentBase: 'wv:/store',
    });
    const without = renderWebviewHtml(webview, {
      scriptUri: { toString: () => 'a.js' }, styleUri: { toString: () => 'a.css' }, title: 'x',
    });
    assert.strictEqual(withBase.includes('data-attachment-base="wv:/store"'), true);
    assert.strictEqual(without.includes('data-attachment-base=""'), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep renderWebviewHtml`
Expected: FAIL — `Cannot find module '../../host/webview-html'`

- [ ] **Step 3: Write the shared renderer**

`src/host/webview-html.ts`:

```ts
import { randomBytes } from 'node:crypto';

/**
 * The two `vscode.Webview` members this needs, named structurally so the
 * renderer is unit-testable without the extension host. A real `Webview`
 * satisfies it.
 */
export interface HtmlWebview {
  readonly cspSource: string;
  asWebviewUri(uri: never): { toString(): string };
}

export interface WebviewHtmlOptions {
  scriptUri: { toString(): string };
  styleUri: { toString(): string };
  title: string;
  /** Empty when the surface has no attachment store — the review tab has none. */
  attachmentBase?: string;
}

/**
 * One CSP for every surface in this extension.
 *
 * Extracted the moment there was a second webview rather than copied: a
 * hand-copied CSP stays correct exactly until the day one of the two is
 * edited, and the failure is silent in the copy nobody looked at.
 */
export function renderWebviewHtml(webview: HtmlWebview, opts: WebviewHtmlOptions): string {
  const nonce = randomBytes(16).toString('base64url');
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
<link href="${opts.styleUri.toString()}" rel="stylesheet">
<title>${opts.title}</title>
</head>
<body>
<div id="root" data-attachment-base="${opts.attachmentBase ?? ''}"></div>
<script nonce="${nonce}" src="${opts.scriptUri.toString()}"></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep renderWebviewHtml`
Expected: PASS (3 passing)

- [ ] **Step 5: Point `PanelViewProvider` at it**

In `src/host/panel-view-provider.ts`, delete `makeNonce` and the body of `render`, replacing it with:

```ts
  render(webview: vscode.Webview): string {
    return renderWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
      ),
      styleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
      ),
      title: 'HiiiiD Code',
      attachmentBase: this.attachments
        ? webview.asWebviewUri(vscode.Uri.file(this.attachments.baseDir)).toString()
        : '',
    });
  }
```

Import at the top: `import { renderWebviewHtml } from './webview-html';`

- [ ] **Step 6: Add the wire message**

In `src/protocol/messages.ts`, add to the `WebviewToHost` union beside `request-fleet-diff` (line 437):

```ts
  /**
   * Open the review tab. Unaddressed, like `request-fleet-diff`: review is a
   * fleet-wide surface, not a session's.
   *
   * Handled in `PanelViewProvider`, not `MessageRouter` — it needs the
   * `vscode` API, and the router must stay importable outside the extension
   * host. Same interception `open-file` already gets.
   */
  | { t: 'open-review' }
```

- [ ] **Step 7: Write `ReviewPanel`**

`src/host/review-panel.ts`:

```ts
import * as vscode from 'vscode';
import { MessageRouter, type EditorContextHost } from './message-router';
import { PostBus, REVIEW_WANTS } from './post-bus';
import type { SessionManager } from './session-manager';
import { renderWebviewHtml } from './webview-html';
import type { WebviewToHost } from '../protocol/messages';

export const REVIEW_VIEW_TYPE = 'hiiiid-code.review';

/**
 * The fleet diff review tab.
 *
 * An editor tab rather than a slot in the sidebar because the surface is a
 * dense file list and the panel is typically 300-500px: at that width the
 * feature did not render at all. The editor area also means the panes are
 * never replaced, so a session going `awaiting-approval` while review is open
 * stays visible — which is the reason the sidebar placement was wrong twice.
 *
 * At most one. `open()` reveals a live panel instead of making a second, so
 * the command is idempotent and a keybinding cannot litter the editor.
 */
export class ReviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private unregister: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SessionManager,
    private readonly bus: PostBus,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      REVIEW_VIEW_TYPE, 'Changes', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.adopt(panel);
  }

  /** The serializer's entry point: VS Code restored the tab, we re-attach. */
  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, {
      scriptUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'review.js'),
      ),
      styleUri: panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'review.css'),
      ),
      title: 'Changes',
    });

    this.unregister = this.bus.add({
      post: (msg) => { void panel.webview.postMessage(msg); },
      wants: REVIEW_WANTS,
    });

    const router = new MessageRouter(
      this.manager, (m) => { void panel.webview.postMessage(m); },
      this.defaultCwd, this.editor,
    );
    panel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        await router.handle(raw);
      } catch (err) {
        console.error('[hiiiid-code] review message handling failed', err);
      }
    });

    panel.onDidDispose(() => {
      this.unregister?.();
      this.unregister = undefined;
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.unregister?.();
    this.panel?.dispose();
  }
}
```

- [ ] **Step 8: Construct it, register the command and the serializer**

In `src/extension.ts`, after the `provider` construction (line ~151):

```ts
  const review = new ReviewPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);
```

Add to `context.subscriptions.push(...)`:

```ts
    vscode.commands.registerCommand('hiiiidCode.review.open', () => { review.open(); }),
    // Without a serializer VS Code restores the tab as a blank webview, which
    // is worse than not restoring it. The host owns whether the tab exists;
    // the client owns nothing durable, so re-attaching is the whole job.
    vscode.window.registerWebviewPanelSerializer(REVIEW_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { review.restore(panel); },
    }),
    { dispose: () => { review.dispose(); } },
```

Imports:

```ts
import { ReviewPanel, REVIEW_VIEW_TYPE } from './host/review-panel';
```

- [ ] **Step 9: Intercept `open-review` in the panel provider**

In `src/host/panel-view-provider.ts`, extend the constructor with an `onOpenReview: () => void` parameter after `picker`, and add to the message handler beside the `open-file` interception (line 77):

```ts
        if (raw?.t === 'open-review') {
          this.onOpenReview();
          return;
        }
```

Pass it at the `extension.ts` construction site. Because `provider` is declared before `review`, hand it a thunk that reads `review` lazily:

```ts
  provider = new PanelViewProvider(
    context.extensionUri, manager, defaultCwd, editorHost, attachments, picker,
    () => { review.open(); },
  );
```

Move the `const review = ...` line **above** this construction so the closure is not reading a TDZ binding at call time — it is only called on user action, but ordering it correctly costs nothing. `ReviewPanel`'s constructor does not touch `provider`, so there is no cycle.

- [ ] **Step 10: Declare the command in `package.json`**

Under `contributes.commands`:

```json
      {
        "command": "hiiiidCode.review.open",
        "title": "HiiiiD Code: Review fleet changes",
        "category": "HiiiiD Code"
      }
```

Under `contributes.keybindings`:

```json
      {
        "command": "hiiiidCode.review.open",
        "key": "ctrl+alt+d",
        "mac": "cmd+alt+d"
      }
```

- [ ] **Step 11: Run the gates**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn lint && yarn check-types && node esbuild.js`
Expected: all pass. `dist/review.js` does not exist yet — the tab will render blank until Task 3. That is expected and is why this task's deliverable is host-side only.

- [ ] **Step 12: Commit**

```bash
git add src/host/webview-html.ts src/host/review-panel.ts src/host/panel-view-provider.ts src/protocol/messages.ts src/extension.ts package.json src/test/unit/webview-html.test.ts
git commit -m "feat: host a fleet diff review editor tab"
```

---

### Task 3: The review bundle — store, reducer, harness

**Files:**
- Create: `src/review/main.tsx`, `src/review/reducer.ts`, `src/review/store.tsx`, `src/review/review-app.tsx`, `src/review/index.css`, `src/test/dom/review-harness.tsx`, `src/test/dom/review-app.test.tsx`
- Modify: `esbuild.js`

**Interfaces:**
- Produces: `interface ReviewState { ready: boolean; sessions: SessionSummary[]; fleetDiff: TreeDiff[] | undefined; fleetDiffReason: string | undefined; fleetDiffDirty: number }`, `initialReviewState`, `reduceReview(state, msg): ReviewState`, `StoreProvider`, `useStore(): { state: ReviewState; post: (msg: WebviewToHost) => void }`, `renderReview()` / `sendFromHost()` / `posted()` / `resetHost()` from the harness.

- [ ] **Step 1: Write the failing test**

`src/test/dom/review-app.test.tsx`:

```tsx
import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

suite('review app', () => {
  setup(() => { resetHost(); });

  test('posts ready on mount, then requests the fleet diff', () => {
    renderReview();
    assert.strictEqual(posted().some((m) => m.t === 'ready'), true);
    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), true);
  });

  test('holds a loading state until the host answers', () => {
    renderReview();
    sendFromHost({ t: 'ready', sessions: [], layout: { panes: [], orientation: 'horizontal' } } as never);
    assert.strictEqual(screen.getByText('Reading the working trees…').tagName, 'P');
  });

  test('a failed read is a state, not a permanent loading line', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: [], reason: 'git exploded' } as never);
    assert.strictEqual(screen.getByText('Could not read the changes').textContent, 'Could not read the changes');
    assert.strictEqual(screen.getByText('git exploded').textContent, 'git exploded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review app"`
Expected: FAIL — `Cannot find module './review-harness'`

- [ ] **Step 3: Write the reducer**

`src/review/reducer.ts`:

```ts
import type { HostToWebview, SessionSummary, TreeDiff } from '../protocol/messages';

/**
 * Everything the review tab knows.
 *
 * Narrow on purpose. It has no `byId`, no layout and no composer, because it
 * subscribes to no message that carries them (see `REVIEW_WANTS`). The
 * narrowness is what makes the fan-out safe to reason about: a message the
 * client cannot represent is a message it must not have asked for.
 */
export interface ReviewState {
  ready: boolean;
  sessions: SessionSummary[];
  fleetDiff: TreeDiff[] | undefined;
  fleetDiffReason: string | undefined;
  /**
   * Bumped whenever something could have changed a diff. The surface debounces
   * a re-request off it rather than re-reading on every edit.
   */
  fleetDiffDirty: number;
}

export const initialReviewState: ReviewState = {
  ready: false,
  sessions: [],
  fleetDiff: undefined,
  fleetDiffReason: undefined,
  fleetDiffDirty: 0,
};

export function reduceReview(state: ReviewState, msg: HostToWebview): ReviewState {
  switch (msg.t) {
    case 'ready':
      return { ...state, ready: true, sessions: msg.sessions };

    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };

    // A session going idle is the moment its edits have settled. The panel's
    // reducer counts the same thing for the same reason.
    case 'session-status':
      return msg.status === 'idle'
        ? { ...state, fleetDiffDirty: state.fleetDiffDirty + 1 }
        : state;

    case 'fleet-diff':
      return { ...state, fleetDiff: msg.trees, fleetDiffReason: msg.reason };

    // Anything else is a message this client never subscribed to. Ignoring it
    // is the second layer behind REVIEW_WANTS, not a substitute for it.
    default:
      return state;
  }
}
```

- [ ] **Step 4: Write the store**

`src/review/store.tsx`:

```tsx
import {
  createContext, useCallback, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialReviewState, reduceReview, type ReviewState } from './reducer';
import { onHostMessage, postToHost } from '@/vscode-api';
import type { WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: ReviewState;
  post: (msg: WebviewToHost) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceReview, initialReviewState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  // Stable identity, and that stability is load-bearing: `post` is a
  // dependency of the surface's "ask once" and debounced-refresh effects, and
  // a fresh identity each render would re-run them — one git invocation per
  // tree per unrelated re-render.
  const post = useCallback((msg: WebviewToHost) => { postToHost(msg); }, []);

  return (
    <StoreContext.Provider value={{ state, post }}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
```

- [ ] **Step 5: Write the shell**

`src/review/review-app.tsx` — the loading, error and empty states only. The list arrives in Task 4.

```tsx
import { useEffect } from 'react';
import { useStore } from './store';

export function ReviewApp() {
  const { state, post } = useStore();

  // Ask once on mount: this surface is the only thing that wants the fleet
  // diff, so it is the only thing that asks for it.
  useEffect(() => { post({ t: 'request-fleet-diff' }); }, [post]);

  return (
    <section aria-label="Changes across every working tree" className="flex h-screen min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto text-xs">
        {state.fleetDiffReason !== undefined ? (
          <div className="space-y-1 px-2 py-2">
            <p className="font-medium">Could not read the changes</p>
            <p className="text-muted-foreground">{state.fleetDiffReason}</p>
          </div>
        ) : state.fleetDiff === undefined ? (
          // Inherited as-is from the sidebar surface, including its lack of an
          // upper bound: a four-second read reads the same as a forty-
          // millisecond one. Replacing it with something more appealing is
          // tracked in §6 of the followups doc, not done here.
          <p className="px-2 py-2 text-muted-foreground">Reading the working trees…</p>
        ) : (
          <p className="px-2 py-2 text-muted-foreground">Nothing to review</p>
        )}
      </div>
    </section>
  );
}
```

`src/review/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { ReviewApp } from './review-app';
import { StoreProvider } from './store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <ReviewApp />
    </StoreProvider>,
  );
}
```

`src/review/index.css` — one line, so the review bundle gets the same tokens and the same `@theme inline` block:

```css
@import '../webview/index.css';
```

- [ ] **Step 6: Add the third bundle**

In `esbuild.js`, generalize `tailwindPlugin` to take its input and output, since there are now two stylesheets:

```js
const tailwindPlugin = (input, output) => ({
	name: `tailwind:${output}`,

	setup(build) {
		const cliDir = path.dirname(require.resolve('@tailwindcss/cli/package.json'));
		const cli = path.join(cliDir, require('@tailwindcss/cli/package.json').bin.tailwindcss);
		const args = [cli, '-i', input, '-o', output];
		if (production) {
			args.push('--minify');
		}

		build.onEnd(() => new Promise((resolve) => {
			execFile(process.execPath, args, { cwd: __dirname }, (err, _stdout, stderr) => {
				if (err) {
					console.error(`✘ [ERROR] tailwind: ${stderr || err.message}`);
				}
				resolve();
			});
		}));
	},
});
```

Update the webview context's plugin list and add the review context:

```js
	const webviewCtx = await esbuild.context({
		...common,
		entryPoints: ['src/webview/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/webview.js',
		loader: { '.tsx': 'tsx', '.ts': 'ts' },
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
		plugins: [tailwindPlugin('src/webview/index.css', 'dist/webview.css'), ...common.plugins],
	});

	// The review tab. Same alias — `@/components/ui/*` and `@/lib/utils` are
	// shared between the two clients on purpose; only the store, the reducer
	// and the surface itself differ.
	const reviewCtx = await esbuild.context({
		...common,
		entryPoints: ['src/review/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/review.js',
		loader: { '.tsx': 'tsx', '.ts': 'ts' },
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
		plugins: [tailwindPlugin('src/review/index.css', 'dist/review.css'), ...common.plugins],
	});
```

And both branches at the bottom of `main()`:

```js
	if (watch) {
		await Promise.all([hostCtx.watch(), webviewCtx.watch(), reviewCtx.watch()]);
	} else {
		await Promise.all([hostCtx.rebuild(), webviewCtx.rebuild(), reviewCtx.rebuild()]);
		await Promise.all([hostCtx.dispose(), webviewCtx.dispose(), reviewCtx.dispose()]);
	}
```

- [ ] **Step 7: Write the DOM harness**

`src/test/dom/review-harness.tsx`. It reuses the existing `acquireVsCodeApi` stub and message plumbing from `harness.tsx` rather than installing a second one — two stubs would race for the same global.

```tsx
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as ReviewAppModule from '../../review/review-app';
import type * as ReviewStoreModule from '../../review/store';

// Re-exported so a review spec imports one module. `harness.tsx` installs the
// acquireVsCodeApi stub at load time and owns the `sent` array; importing it
// here is what guarantees the stub exists before the review store's
// vscode-api import runs.
export { posted, resetHost, sendFromHost } from './harness';

const { ReviewApp } = require('../../review/review-app') as typeof ReviewAppModule;
const { StoreProvider } = require('../../review/store') as typeof ReviewStoreModule;

/**
 * NEVER hand the returned `container` — or any node queried out of it — to an
 * assertion as a value. See the long warning in `harness.tsx`: the node-valued
 * form allocated 3.5GB in 4 seconds. Compare booleans, strings or counts.
 */
export function renderReview(): RenderResult {
  return render(<StoreProvider><ReviewApp /></StoreProvider>);
}

/** Same assertion warning as `renderReview`. */
export function renderInReviewStore(ui: ReactNode): RenderResult {
  return render(<StoreProvider>{ui}</StoreProvider>);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review app"`
Expected: PASS (3 passing)

- [ ] **Step 9: Run the gates**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn lint && yarn check-types && node esbuild.js`
Expected: all pass, and `dist/review.js` plus `dist/review.css` exist.

- [ ] **Step 10: Commit**

```bash
git add src/review src/test/dom/review-harness.tsx src/test/dom/review-app.test.tsx esbuild.js
git commit -m "feat: a review client bundle with its own narrow reducer"
```

---

### Task 4: Move the surface, empty the sidebar

**Files:**
- Move: `src/webview/components/fleet-diff.tsx` → `src/review/fleet-diff.tsx`; `src/webview/components/fleet-diff-groups.ts` → `src/review/fleet-diff-groups.ts`
- Modify: `src/review/review-app.tsx`, `src/webview/app.tsx`, `src/webview/components/use-is-narrow.ts`, `src/webview/components/session-picker.tsx`
- Delete: `src/webview/components/review-toggle.ts`
- Move: `src/test/dom/fleet-diff.test.tsx` onto the review harness; `src/test/unit/fleet-diff-groups.test.ts` import path

**Interfaces:**
- Consumes: `useStore` from `src/review/store`, `renderReview` from the review harness.
- Produces: `<FleetDiff />` with **no props** — there is no close button, because closing an editor tab is VS Code's job.

- [ ] **Step 1: Write the failing test**

Add to `src/test/dom/review-app.test.tsx`:

```tsx
  test('renders a file row per change, and opens the diff on click', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 0,
        files: [{ path: 'src/a.ts', op: 'modify', insertions: 3, deletions: 1, claimedBy: ['s1'] }],
      }],
    } as never);

    await user.click(screen.getByRole('button', { name: /src\/a\.ts/ }));

    const open = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(open.length, 1);
    assert.strictEqual(JSON.stringify(open[0]).includes('src/a.ts'), true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "renders a file row"`
Expected: FAIL — no button matching `src/a.ts` (the shell renders "Nothing to review")

- [ ] **Step 3: Move the two files**

```bash
git mv src/webview/components/fleet-diff.tsx src/review/fleet-diff.tsx
git mv src/webview/components/fleet-diff-groups.ts src/review/fleet-diff-groups.ts
```

Fix the imports in `src/review/fleet-diff.tsx` — the depth changed, and two of them would now resolve to files that do not exist:

| Was | Now |
|---|---|
| `from '../store'` | `from './store'` |
| `from '../format'` | `from '@/format'` |
| `from './fleet-diff-groups'` | unchanged |
| `from '../../protocol/messages'` | unchanged (same depth) |
| `from './review-toggle'` | **delete the import** |

In `src/review/fleet-diff-groups.ts` the only import is `from '../../protocol/messages'` — unchanged.

- [ ] **Step 4: Strip what the tab makes obsolete**

In `src/review/fleet-diff.tsx`:

- Change the signature to `export function FleetDiff()` — no `onClose`.
- Delete the Escape-key effect, the focus-restoration effect, `rootRef`, and the `XIcon` close `Button` with its import.
- Update the component's doc comment: it no longer "replaces the panes", it is an editor tab. Say why — the sidebar is 300-500px and the list did not render there at all, and an editor tab keeps the panes (and their permission cards) on screen.

Delete the now-unreferenced marker:

```bash
git rm src/webview/components/review-toggle.ts
```

- [ ] **Step 5: Mount it**

In `src/review/review-app.tsx`, replace the placeholder `<p>Nothing to review</p>` branch by rendering `<FleetDiff />` unconditionally and letting it own all three states — move the `request-fleet-diff` mount effect and the 750ms debounced refresh effect into `FleetDiff` where they already live, so `ReviewApp` becomes:

```tsx
import { FleetDiff } from './fleet-diff';

export function ReviewApp() {
  return <FleetDiff />;
}
```

`FleetDiff`'s own root `<section>` gains `h-screen` (it is the whole tab now, not a flex child of the panel body).

- [ ] **Step 6: Delete the sidebar's review path**

In `src/webview/app.tsx`:
- Remove the `FleetDiff` import, `REVIEW_PX` from the `use-is-narrow` import, `canReview`, `reviewOpen`, and the `useState` import if it becomes unused.
- The body becomes `<PaneGroup narrow={narrow} />` unconditionally, dropping the ternary at line 112 and its comment.
- `SessionPicker` loses `canReview` and `reviewing`; `onReview` stays and becomes `() => post({ t: 'open-review' })`.

In `src/webview/components/session-picker.tsx`: the review control becomes a plain `Button` (no `aria-pressed`, no `REVIEW_TOGGLE_ATTR`), always enabled, labelled for what it now does — e.g. `aria-label="Review fleet changes in an editor tab"`. Remove the `REVIEW_PX` comment at line 26.

In `src/webview/components/use-is-narrow.ts`: delete `REVIEW_PX` and its doc comment. Trim `usePanelWidth`'s doc comment where it explains a second threshold — the file is a single-threshold module again. **Do not rename the file**; that is §6 and stays deferred.

- [ ] **Step 7: Migrate the tests**

- `src/test/unit/fleet-diff-groups.test.ts`: update the import to `../../review/fleet-diff-groups`.
- `src/test/dom/fleet-diff.test.tsx`: swap `renderApp`/`renderWithStore` from `./harness` for `renderReview`/`renderInReviewStore` from `./review-harness`, and delete any test asserting the Escape binding, the close button, focus restoration, or `aria-pressed` — all four describe behavior that no longer exists.
- Add one sidebar test asserting the new toggle posts `open-review`:

```tsx
  test('the picker asks the host to open the review tab', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp();
    sendFromHost({ t: 'ready', sessions: [], layout: { panes: [], orientation: 'horizontal' } } as never);
    await user.click(screen.getByRole('button', { name: /Review fleet changes/ }));
    assert.strictEqual(posted().some((m) => m.t === 'open-review'), true);
  });
```

- [ ] **Step 8: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS, including the row-click test from Step 1.

- [ ] **Step 9: Run the gates and the detector**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx src/review/review-app.tsx src/webview/app.tsx src/webview/components/session-picker.tsx
```

Expected: exit 0. Exit 2 is a failing check, not a suggestion — fix before committing.

- [ ] **Step 10: Manual check**

Press F5, open the panel, click the review control. The tab opens beside the editor and lists changes. Reload the window (`Developer: Reload Window`) — the tab comes back with content, not blank.

- [ ] **Step 11: Commit**

```bash
git add -A src/review src/webview src/test
git commit -m "feat: move fleet diff review into its own editor tab"
```

---

### Task 5: Raise the cap from the surface

**Files:**
- Modify: `src/protocol/messages.ts` (`request-fleet-diff` gains `cap`), `src/host/fleet-diff.ts`, `src/host/session-manager.ts`, `src/host/message-router.ts`, `src/review/fleet-diff.tsx`
- Test: `src/test/unit/fleet-diff-cap.test.ts`, `src/test/dom/review-app.test.tsx`

**Interfaces:**
- Consumes: `FILE_CAP` (500) from `src/host/fleet-diff.ts`.
- Produces: `{ t: 'request-fleet-diff'; cap?: number }`; `clampCap(requested: number | undefined): number`; `SessionManager.requestFleetDiff(cap?: number)`; `fleetDiff(cap?: number)`.

- [ ] **Step 1: Write the failing test**

`src/test/unit/fleet-diff-cap.test.ts`:

```ts
import * as assert from 'node:assert';
import { clampCap, FILE_CAP, MAX_FILE_CAP } from '../../host/fleet-diff';

suite('clampCap', () => {
  test('an absent cap is the default', () => {
    assert.strictEqual(clampCap(undefined), FILE_CAP);
  });

  test('a raised cap is honoured up to the ceiling', () => {
    assert.strictEqual(clampCap(1200), 1200);
    assert.strictEqual(clampCap(MAX_FILE_CAP), MAX_FILE_CAP);
  });

  test('the ceiling is hard — an unbounded list cannot be requested', () => {
    assert.strictEqual(clampCap(50_000), MAX_FILE_CAP);
    assert.strictEqual(clampCap(Number.POSITIVE_INFINITY), MAX_FILE_CAP);
  });

  test('nonsense falls back to the default rather than to zero rows', () => {
    assert.strictEqual(clampCap(0), FILE_CAP);
    assert.strictEqual(clampCap(-5), FILE_CAP);
    assert.strictEqual(clampCap(Number.NaN), FILE_CAP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep clampCap`
Expected: FAIL — `clampCap is not a function`

- [ ] **Step 3: Implement the clamp**

In `src/host/fleet-diff.ts`, beside `FILE_CAP` (line 26):

```ts
/**
 * The hard ceiling on a raised cap.
 *
 * The surface can ask for more than `FILE_CAP` — "N more files are not shown"
 * with nothing to press is a named dead end — but it cannot ask for
 * everything. Each file costs a numstat row to parse and a React row to
 * render, and a request with no ceiling is a request the host cannot promise
 * to answer.
 */
export const MAX_FILE_CAP = 2000;

/**
 * A requested cap, made safe. Nonsense (zero, negative, NaN) falls back to the
 * default rather than to zero rows: answering "nothing changed" because a
 * number arrived malformed is the one wrong answer this surface can give.
 */
export function clampCap(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return FILE_CAP;
  }
  return Math.min(Math.floor(requested), MAX_FILE_CAP);
}
```

Thread it through the reader — replace the two `FILE_CAP` uses at lines 159-160:

```ts
  const limit = clampCap(cap);
  const omitted = Math.max(0, files.length - limit);
  return { base, files: files.slice(0, limit), omitted };
```

and add `cap?: number` as the last parameter of the enclosing `treeChanges` signature at line 135.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep clampCap`
Expected: PASS (4 passing)

- [ ] **Step 5: Thread it up**

- `src/protocol/messages.ts`: `| { t: 'request-fleet-diff'; cap?: number }`, with a comment saying the host clamps it to `MAX_FILE_CAP` and that an absent cap means the default.
- `src/host/session-manager.ts`: `async fleetDiff(cap?: number)` passing `cap` to `treeChanges(status.root, cap)` (line 829); `async requestFleetDiff(cap?: number)` passing it to `this.fleetDiff(cap)` (line 909).
- `src/host/message-router.ts` line 340: `await this.manager.requestFleetDiff(msg.cap);`

- [ ] **Step 6: Write the failing DOM test**

Add to `src/test/dom/review-app.test.tsx`:

```tsx
  test('"show more" re-requests with a raised cap', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 340,
        files: [{ path: 'src/a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
      }],
    } as never);

    await user.click(screen.getByRole('button', { name: 'Show 340 more' }));

    const raised = posted().filter((m) => m.t === 'request-fleet-diff' && m.cap !== undefined);
    assert.strictEqual(raised.length, 1);
    assert.strictEqual((raised[0] as { cap?: number }).cap, 1000);
  });
```

- [ ] **Step 7: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "show more"`
Expected: FAIL — no button named "Show 340 more"

- [ ] **Step 8: Make `omitted` a control**

In `src/review/fleet-diff.tsx`, `FleetDiff` holds the current cap and hands `Tree` a way to raise it:

```tsx
  const [cap, setCap] = useState<number | undefined>(undefined);
  const showMore = () => {
    // Doubling from the current effective cap, not jumping to the ceiling: a
    // user with 340 more files wants to see them, not to make the host parse
    // 2000 numstat rows on the way there.
    const next = (cap ?? 500) * 2;
    setCap(next);
    post({ t: 'request-fleet-diff', cap: next });
  };
```

Replace the `tree.omitted > 0` paragraph with:

```tsx
        {tree.omitted > 0 && (
          // Never a dead end. The cap is a rendering decision, and a sentence
          // naming a number the user cannot act on is worse than either
          // showing the rows or not mentioning them.
          <Button variant="outline" size="sm" className="mt-2" onClick={onShowMore}>
            Show {tree.omitted} more
          </Button>
        )}
```

Pass `onShowMore={showMore}` down from `FleetDiff` to `Tree`. The debounced refresh effect must send the current cap too, or a background refresh would silently collapse the list back to 500:

```tsx
    const timer = setTimeout(() => { post({ t: 'request-fleet-diff', cap }); }, 750);
```

- [ ] **Step 9: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS

- [ ] **Step 10: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx
git add -A src/host src/protocol src/review src/test
git commit -m "feat: let the review surface raise the file cap"
```

---

### Task 6: Filter, and contested-only

**Files:**
- Modify: `src/review/fleet-diff-groups.ts`, `src/review/fleet-diff.tsx`
- Test: `src/test/unit/fleet-diff-groups.test.ts`, `src/test/dom/review-filter.test.tsx`

**Interfaces:**
- Consumes: `groupTree(tree): SessionGroup[]`, `SessionGroup { sessionId, files, insertions, deletions }`.
- Produces: `filterTree(tree: TreeDiff, query: string, contestedOnly: boolean): TreeDiff`, `countFiles(trees: TreeDiff[]): number`.

- [ ] **Step 1: Write the failing unit test**

Add to `src/test/unit/fleet-diff-groups.test.ts`:

```ts
import { countFiles, filterTree } from '../../review/fleet-diff-groups';

suite('filterTree', () => {
  const tree = {
    root: '/repo', branch: 'main', sessions: ['s1', 's2'],
    base: { kind: 'head' as const }, omitted: 0,
    files: [
      { path: 'src/webview/app.tsx', op: 'modify' as const, insertions: 1, deletions: 0, claimedBy: ['s1'] },
      { path: 'README.md', op: 'modify' as const, insertions: 2, deletions: 0, claimedBy: ['s1', 's2'] },
    ],
  };

  test('an empty query keeps everything', () => {
    assert.strictEqual(filterTree(tree, '', false).files.length, 2);
  });

  test('matches anywhere in the path, case-insensitively', () => {
    assert.strictEqual(filterTree(tree, 'WEBVIEW', false).files.length, 1);
    assert.strictEqual(filterTree(tree, 'readme', false).files.length, 1);
  });

  test('contested-only keeps files more than one session claimed', () => {
    const only = filterTree(tree, '', true);
    assert.strictEqual(only.files.length, 1);
    assert.strictEqual(only.files[0].path, 'README.md');
  });

  test('the two compose', () => {
    assert.strictEqual(filterTree(tree, 'src', true).files.length, 0);
  });

  test('countFiles counts files, not rows', () => {
    // README.md is claimed twice and will render under two groups. The count
    // answers "what changed", which is a question about files.
    assert.strictEqual(countFiles([tree]), 2);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep filterTree`
Expected: FAIL — `filterTree is not a function`

- [ ] **Step 3: Implement**

Append to `src/review/fleet-diff-groups.ts`:

```ts
/**
 * A tree with only the files the user asked to see.
 *
 * Filtering happens on the tree, before grouping, so an emptied session group
 * disappears rather than rendering as a header over nothing — an empty group
 * reads as "this session did nothing", which under a filter is false.
 *
 * `omitted` is deliberately carried through untouched: it counts files the
 * *host* never sent, and a filter cannot know whether they would have matched.
 */
export function filterTree(tree: TreeDiff, query: string, contestedOnly: boolean): TreeDiff {
  const needle = query.trim().toLowerCase();
  if (needle === '' && !contestedOnly) { return tree; }

  const files = tree.files.filter((file) => {
    if (contestedOnly && file.claimedBy.length < 2) { return false; }
    if (needle === '') { return true; }
    return file.path.toLowerCase().includes(needle);
  });

  return { ...tree, files };
}

/** Files across every tree. Paths are never de-duplicated across trees: the
 * same relative path in two working trees is two different files. */
export function countFiles(trees: TreeDiff[]): number {
  return trees.reduce((total, tree) => total + tree.files.length, 0);
}
```

- [ ] **Step 4: Run it, watch it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "filterTree|countFiles"`
Expected: PASS (5 passing)

- [ ] **Step 5: Write the failing DOM test**

`src/test/dom/review-filter.test.tsx`:

```tsx
import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1', 's2'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'src/app.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'README.md', op: 'modify', insertions: 2, deletions: 0, claimedBy: ['s1', 's2'] },
  ],
}];

suite('review filter', () => {
  setup(() => { resetHost(); });

  test('narrows the rows and says so in the count', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'readme');

    assert.strictEqual(screen.queryAllByRole('button', { name: /src\/app\.tsx/ }).length, 0);
    assert.strictEqual(screen.queryAllByRole('button', { name: /README\.md/ }).length, 1);
    // The count must never let a filter read as an empty fleet.
    assert.strictEqual(screen.getByText(/1 of 2/).textContent?.includes('1 of 2'), true);
  });

  test('an empty result explains itself as a filter, not as a clean fleet', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'zzzz');

    assert.strictEqual(screen.getByText('No file matches this filter.').textContent,
      'No file matches this filter.');
  });

  test('contested-only keeps the file two sessions claimed', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Contested only/ }));

    assert.strictEqual(screen.queryAllByRole('button', { name: /src\/app\.tsx/ }).length, 0);
    assert.strictEqual(screen.queryAllByRole('button', { name: /README\.md/ }).length > 0, true);
  });
});
```

- [ ] **Step 6: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review filter"`
Expected: FAIL — no textbox named `Filter`

- [ ] **Step 7: Build the header controls**

In `src/review/fleet-diff.tsx`, add state and a header row using vendored primitives only:

```tsx
  const [query, setQuery] = useState('');
  const [contestedOnly, setContestedOnly] = useState(false);
  const filtered = (trees ?? []).map((tree) => filterTree(tree, query, contestedOnly));
  const shown = countFiles(filtered);
  const total = countFiles(trees ?? []);
```

Header, beside the existing summary and Refresh control:

```tsx
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter by path"
          placeholder="Filter by path"
          className="h-7 max-w-64"
        />
        <Button
          variant={contestedOnly ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={contestedOnly}
          onClick={() => setContestedOnly((on) => !on)}
        >
          Contested only
        </Button>
```

The count line reads filtered-of-total whenever a filter is active, and the plain summary otherwise:

```tsx
        <span className="min-w-0 truncate text-muted-foreground">
          {shown === total ? summarize(filtered) : `${shown} of ${total} files`}
        </span>
```

And the empty branch distinguishes a filtered-out list from a clean fleet:

```tsx
        ) : shown === 0 && total > 0 ? (
          <p className="px-2 py-2 text-muted-foreground">No file matches this filter.</p>
        ) : (
```

Render `filtered`, not `trees`, in the list below.

- [ ] **Step 8: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS

- [ ] **Step 9: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx src/review/fleet-diff-groups.ts
git add -A src/review src/test
git commit -m "feat: filter review rows by path, and by contested files"
```

---

### Task 7: Hierarchy — indentation, counts, prefixes, collapse

**Files:**
- Modify: `src/review/fleet-diff-groups.ts`, `src/review/fleet-diff.tsx`
- Test: `src/test/unit/fleet-diff-groups.test.ts`, `src/test/dom/review-structure.test.tsx`

**Interfaces:**
- Produces: `commonPrefix(paths: string[]): string`, `stripPrefix(path: string, prefix: string): string`.

- [ ] **Step 1: Write the failing unit test**

Add to `src/test/unit/fleet-diff-groups.test.ts`:

```ts
import { commonPrefix, stripPrefix } from '../../review/fleet-diff-groups';

suite('commonPrefix', () => {
  test('finds the deepest shared directory', () => {
    assert.strictEqual(
      commonPrefix(['src/webview/a.tsx', 'src/webview/b.tsx']), 'src/webview/',
    );
  });

  test('stops at a directory boundary, never mid-segment', () => {
    // 'src/we' is a shared string but not a shared directory. Eliding it would
    // render paths that do not exist.
    assert.strictEqual(commonPrefix(['src/webview/a.tsx', 'src/west/b.tsx']), 'src/');
  });

  test('is empty when nothing is shared', () => {
    assert.strictEqual(commonPrefix(['src/a.ts', 'docs/b.md']), '');
  });

  test('a single file elides its own directory, not its name', () => {
    assert.strictEqual(commonPrefix(['src/webview/a.tsx']), 'src/webview/');
  });

  test('a root-level file has no prefix', () => {
    assert.strictEqual(commonPrefix(['README.md']), '');
  });

  test('stripPrefix leaves the remainder', () => {
    assert.strictEqual(stripPrefix('src/webview/a.tsx', 'src/webview/'), 'a.tsx');
    assert.strictEqual(stripPrefix('README.md', ''), 'README.md');
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep commonPrefix`
Expected: FAIL — `commonPrefix is not a function`

- [ ] **Step 3: Implement**

Append to `src/review/fleet-diff-groups.ts`:

```ts
/**
 * The deepest directory every path shares, with its trailing slash.
 *
 * Directory-boundary only: `src/webview/` and `src/west/` share the string
 * `src/we`, and eliding that would leave rows spelling paths that do not
 * exist. Paths are git's repo-relative POSIX spelling, so `/` is the only
 * separator to consider.
 */
export function commonPrefix(paths: string[]): string {
  if (paths.length === 0) { return ''; }
  let prefix = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
  for (const path of paths.slice(1)) {
    while (prefix !== '' && !path.startsWith(prefix)) {
      // Drop one segment: cut the trailing slash, then back to the previous one.
      prefix = prefix.slice(0, prefix.lastIndexOf('/', prefix.length - 2) + 1);
    }
    if (prefix === '') { return ''; }
  }
  return prefix;
}

export function stripPrefix(path: string, prefix: string): string {
  return prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
```

- [ ] **Step 4: Run it, watch it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep "commonPrefix|stripPrefix"`
Expected: PASS (6 passing)

- [ ] **Step 5: Write the failing DOM test**

`src/test/dom/review-structure.test.tsx`:

```tsx
import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'src/webview/a.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'src/webview/b.tsx', op: 'modify', insertions: 2, deletions: 1, claimedBy: ['s1'] },
  ],
}];

const READY = {
  t: 'ready',
  sessions: [{ id: 's1', title: 'Session A', status: 'idle' }],
  layout: { panes: [], orientation: 'horizontal' },
};

suite('review structure', () => {
  setup(() => { resetHost(); });

  test('nests tree above session above file', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByRole('heading', { level: 3 }).textContent?.includes('repo'), true);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });

  test('names the shared directory once instead of on every row', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('src/webview/').textContent, 'src/webview/');
    assert.strictEqual(screen.queryAllByText('src/webview/').length, 1);
  });

  test('counts the files in a session group', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('2 files').textContent, '2 files');
  });

  test('collapsing a session group hides its rows and keeps its header', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Collapse Session A/ }));

    assert.strictEqual(screen.queryAllByRole('button', { name: /a\.tsx/ }).length, 0);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });
});
```

- [ ] **Step 6: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review structure"`
Expected: FAIL — no text `src/webview/`

- [ ] **Step 7: Restructure the surface**

In `src/review/fleet-diff.tsx`:

- `Tree`'s `h3` becomes `text-sm font-medium`; the branch renders as a muted chip beside it. Add `aria-expanded` collapse chevron `Button` labelled `Collapse {folderName(tree.root)}` / `Expand {folderName(tree.root)}`.
- `Group`'s `h4` keeps `text-xs font-medium`, gains a count badge `{group.files.length} {group.files.length === 1 ? 'file' : 'files'}` and its own collapse chevron labelled `Collapse {title}` / `Expand {title}`.
- Above each group's `<ul>`, when `commonPrefix(group.files.map(f => f.path))` is non-empty, render it once as a muted line; rows then render `stripPrefix(file.path, prefix)` in place of the `dir` + `name` split, keeping the same "directory dims, basename does not" treatment on whatever remains.
- Indentation ladder via padding: tree header `px-2`, group header `pl-4`, rows `pl-6`, with a hairline `border-l border-border` on the group's `<ul>`.
- Session-group headers become `sticky top-8 z-[9] bg-background` (below the tree header's `top-0 z-10`), so attribution does not scroll away.

Collapse state:

```tsx
  // Ephemeral by design. Both this and the opened set describe a reading
  // position in a list that re-reads itself every 750ms while agents work; a
  // restored collapse would be folding groups of a list assembled from a
  // different working tree than the one that was folded. Same reasoning that
  // keeps diff claims and failed model probes off disk.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) { next.add(key); }
    return next;
  });
```

Keys are `tree:${tree.root}` and `${tree.root}::${group.sessionId ?? 'unattributed'}` — the tree root is part of the group key because two trees can hold the same session.

- [ ] **Step 8: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS

- [ ] **Step 9: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx src/review/fleet-diff-groups.ts
git add -A src/review src/test
git commit -m "feat: give the review list a visible hierarchy"
```

---

### Task 8: Keyboard — roving tabindex, next/prev, opened marker

**Files:**
- Create: `src/review/use-roving-rows.ts`
- Modify: `src/review/fleet-diff.tsx`
- Test: `src/test/unit/roving-rows.test.ts`, `src/test/dom/review-keyboard.test.tsx`

**Interfaces:**
- Produces: `nextIndex(current: number, key: string, count: number): number | null`; `useRovingRows(count: number): { active: number; setActive: (i: number) => void; onKeyDown: (e: React.KeyboardEvent) => void }`.

- [ ] **Step 1: Write the failing unit test**

`src/test/unit/roving-rows.test.ts`:

```ts
import * as assert from 'node:assert';
import { nextIndex } from '../../review/use-roving-rows';

suite('nextIndex', () => {
  test('arrows move by one', () => {
    assert.strictEqual(nextIndex(0, 'ArrowDown', 3), 1);
    assert.strictEqual(nextIndex(2, 'ArrowUp', 3), 1);
  });

  test('stops at the ends rather than wrapping', () => {
    // Wrapping in a 500-row list means an ArrowUp at the top silently teleports
    // the user to the bottom of a different session's work.
    assert.strictEqual(nextIndex(0, 'ArrowUp', 3), 0);
    assert.strictEqual(nextIndex(2, 'ArrowDown', 3), 2);
  });

  test('Home and End jump', () => {
    assert.strictEqual(nextIndex(1, 'Home', 3), 0);
    assert.strictEqual(nextIndex(1, 'End', 3), 2);
  });

  test('any other key is not ours', () => {
    assert.strictEqual(nextIndex(1, 'a', 3), null);
    assert.strictEqual(nextIndex(1, 'Enter', 3), null);
  });

  test('an empty list has nowhere to go', () => {
    assert.strictEqual(nextIndex(0, 'ArrowDown', 0), null);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep nextIndex`
Expected: FAIL — `Cannot find module '../../review/use-roving-rows'`

- [ ] **Step 3: Implement**

`src/review/use-roving-rows.ts`:

```ts
import { useCallback, useState } from 'react';

/**
 * Where a key takes the roving focus, or `null` when the key is not ours.
 *
 * Pure, and separated from the hook so the movement rules are unit-testable
 * without a DOM. Clamped rather than wrapping: in a list built to carry 500
 * rows, wrapping means an ArrowUp at the top teleports the reader into a
 * different session's work with no indication it happened.
 */
export function nextIndex(current: number, key: string, count: number): number | null {
  if (count === 0) { return null; }
  switch (key) {
    case 'ArrowDown': return Math.min(current + 1, count - 1);
    case 'ArrowUp': return Math.max(current - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/**
 * One row in the tab order, arrows to move between them.
 *
 * Every row used to be an independent `Button`, so reaching row 400 meant 400
 * Tab presses — the single largest reason the surface scored 1/4 on
 * flexibility and efficiency.
 */
export function useRovingRows(count: number) {
  const [active, setActive] = useState(0);
  const clamped = Math.min(active, Math.max(count - 1, 0));

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const next = nextIndex(clamped, e.key, count);
    if (next === null) { return; }
    e.preventDefault();
    setActive(next);
    // Focus follows the roving index: the row is the thing the user is on, and
    // a visual highlight the screen reader cannot see is not navigation.
    const rows = e.currentTarget.querySelectorAll<HTMLElement>('[data-review-row]');
    rows[next]?.focus();
  }, [clamped, count]);

  return { active: clamped, setActive, onKeyDown };
}
```

- [ ] **Step 4: Run it, watch it pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit --grep nextIndex`
Expected: PASS (5 passing)

- [ ] **Step 5: Write the failing DOM test**

`src/test/dom/review-keyboard.test.tsx`:

```tsx
import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'b.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
  ],
}];

suite('review keyboard', () => {
  setup(() => { resetHost(); });

  test('exactly one row is in the tab order', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    const rows = document.querySelectorAll('[data-review-row]');
    const tabbable = [...rows].filter((r) => r.getAttribute('tabindex') === '0');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(tabbable.length, 1);
  });

  test('ArrowDown moves focus to the next row', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /a\.ts/ }));
    resetHost();
    await user.keyboard('{ArrowDown}');

    assert.strictEqual(document.activeElement?.textContent?.includes('b.ts'), true);
  });

  test('an opened row is marked as read', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /a\.ts/ }));

    assert.strictEqual(posted().some((m) => m.t === 'open-file-diff'), true);
    assert.strictEqual(
      screen.getByRole('button', { name: /a\.ts/ }).getAttribute('data-opened'), 'true',
    );
    assert.strictEqual(
      screen.getByRole('button', { name: /b\.ts/ }).getAttribute('data-opened'), null,
    );
  });

  test('next-file opens without the user finding the row', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    resetHost();

    await user.click(screen.getByRole('button', { name: 'Open the next file' }));

    const opened = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(opened.length, 1);
  });
});
```

- [ ] **Step 6: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review keyboard"`
Expected: FAIL — no `[data-review-row]` elements

- [ ] **Step 7: Wire the surface**

In `src/review/fleet-diff.tsx`:

- Flatten the rendered rows into an ordered array once per render (`{ tree, file }[]`, in render order) so the roving index has something stable to count and the next/prev controls have somewhere to point.
- `useRovingRows(rows.length)`; put `onKeyDown` on the scroll container.
- Each `FileRow` `Button` gets `data-review-row`, `tabIndex={index === active ? 0 : -1}`, `onFocus={() => setActive(index)}`, and `data-opened={opened.has(key) ? 'true' : undefined}`.
- The opened set is keyed `${tree.root}::${file.path}` — the same relative path in two trees is two different files.
- Opening a row (click or Enter, which a `Button` already treats as a click) adds to `opened` and dims the basename via `cn(..., isOpened && 'text-muted-foreground')`.
- Header controls `aria-label="Open the previous file"` / `"Open the next file"` move the roving index and post `open-file-diff` for the row they land on.

- [ ] **Step 8: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS

- [ ] **Step 9: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx src/review/use-roving-rows.ts
git add -A src/review src/test
git commit -m "feat: keyboard navigation and a read marker for review rows"
```

---

### Task 9: What only this panel knows — live status, contested badge

**Files:**
- Modify: `src/review/fleet-diff.tsx`
- Test: `src/test/dom/review-structure.test.tsx`

**Interfaces:**
- Consumes: `state.sessions` (`SessionSummary` carries `status`), `StatusBadge` from `@/components/status-badge`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/dom/review-structure.test.tsx`:

```tsx
  test('a session still working says so on its group', () => {
    renderReview();
    sendFromHost(
      { t: 'ready', sessions: [{ id: 's1', title: 'Session A', status: 'thinking' }],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: TREES } as never,
    );
    // The diff you are reading is still being written. No SCM view can say this.
    assert.strictEqual(screen.getAllByText(/thinking/i).length > 0, true);
  });

  test('a status change after the diff lands still reaches the group', () => {
    renderReview();
    sendFromHost(
      { t: 'ready', sessions: [{ id: 's1', title: 'Session A', status: 'thinking' }],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: TREES } as never,
      { t: 'sessions-changed',
        sessions: [{ id: 's1', title: 'Session A', status: 'idle' }] } as never,
    );
    assert.strictEqual(screen.queryAllByText(/thinking/i).length, 0);
  });

  test('a contested file is named as contested, not buried at the end of the row', () => {
    renderReview();
    sendFromHost(
      { t: 'ready',
        sessions: [
          { id: 's1', title: 'Session A', status: 'idle' },
          { id: 's2', title: 'Session B', status: 'idle' },
        ],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: [{
        ...TREES[0], sessions: ['s1', 's2'],
        files: [{ path: 'shared.ts', op: 'modify', insertions: 1, deletions: 0,
          claimedBy: ['s1', 's2'] }],
      }] } as never,
    );
    assert.strictEqual(screen.getAllByText('Also Session B').length, 1);
  });
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "still working"`
Expected: FAIL — no text matching `thinking`

- [ ] **Step 3: Implement**

In `src/review/fleet-diff.tsx`:

- `Group` looks its session up in `state.sessions` and renders `<StatusBadge status={session.status} />` beside the `h4` when the session is not `idle`. An archived or deleted session renders nothing — there is no live status to claim.
- The contested marker moves off the end of the row into a badge rendered directly after the basename, `variant="outline"` with `border-destructive/50 text-destructive`, reading `Also {names}`. It keeps naming the other sessions rather than counting them: "+1" does not say who to go and read.

Add a note in the component doc comment: the live status is the one thing this surface can say that VS Code's SCM view structurally cannot, and it is why the group header is worth its vertical space.

- [ ] **Step 4: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review structure"`
Expected: PASS (7 passing)

- [ ] **Step 5: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx
git add -A src/review src/test
git commit -m "feat: show live session status and contested files in review"
```

---

### Task 10: Stop reading when nobody is looking

**Files:**
- Modify: `src/protocol/messages.ts`, `src/host/review-panel.ts`, `src/review/reducer.ts`, `src/review/fleet-diff.tsx`
- Test: `src/test/dom/review-visibility.test.tsx`

**Interfaces:**
- Produces: `{ t: 'review-visibility'; visible: boolean }` (host → webview); `ReviewState.visible: boolean`.

- [ ] **Step 1: Write the failing test**

`src/test/dom/review-visibility.test.tsx`:

```tsx
import * as assert from 'node:assert';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [{ path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
}];

const clock = async () => { await new Promise((r) => setTimeout(r, 900)); };

suite('review visibility', () => {
  setup(() => { resetHost(); });

  test('a hidden tab does not re-read the working trees', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    resetHost();

    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    await clock();

    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), false);
  });

  test('becoming visible again reads once', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    resetHost();

    sendFromHost({ t: 'review-visibility', visible: true } as never);
    await clock();

    assert.strictEqual(posted().filter((m) => m.t === 'request-fleet-diff').length, 1);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:dom --grep "review visibility"`
Expected: FAIL — the hidden tab still posts `request-fleet-diff`

- [ ] **Step 3: Add the message**

In `src/protocol/messages.ts`, `HostToWebview`:

```ts
  /**
   * Whether the review tab is on screen.
   *
   * A tab in a background editor group would otherwise keep the 750ms dirty
   * timer running — one git invocation per working tree, for a surface nobody
   * can see. The client stops requesting while hidden and reads once on
   * becoming visible again, which costs one stale frame on re-focus and is the
   * trade this makes deliberately.
   */
  | { t: 'review-visibility'; visible: boolean }
```

- [ ] **Step 4: Emit it**

In `src/host/review-panel.ts`'s `adopt`, after the router wiring:

```ts
    panel.onDidChangeViewState(() => {
      void panel.webview.postMessage({ t: 'review-visibility', visible: panel.visible });
    });
```

`REVIEW_WANTS` does not need widening — this is posted straight at the panel, not through the bus, because it describes *this* panel rather than fleet state.

- [ ] **Step 5: Reduce it**

In `src/review/reducer.ts`, add `visible: boolean` to `ReviewState` (initial `true` — a tab that has never reported is a tab that was just created and revealed), and:

```ts
    case 'review-visibility':
      return { ...state, visible: msg.visible };
```

- [ ] **Step 6: Gate the effects**

In `src/review/fleet-diff.tsx`, the debounced refresh effect returns early when hidden, and a second effect reads once on the hidden→visible edge:

```tsx
  useEffect(() => {
    if (!state.visible || state.fleetDiffDirty === 0) { return; }
    const timer = setTimeout(() => { post({ t: 'request-fleet-diff', cap }); }, 750);
    return () => { clearTimeout(timer); };
  }, [state.visible, state.fleetDiffDirty, cap, post]);
```

Because `fleetDiffDirty` keeps counting while hidden, becoming visible with a non-zero count re-enters this effect and reads once — no separate edge-detection effect is needed, and the `visible` dependency is what makes that true.

- [ ] **Step 7: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom`
Expected: PASS

- [ ] **Step 8: Gates, detector, commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && node esbuild.js
node <impeccable-skill-dir>/scripts/detect.mjs --json src/review/fleet-diff.tsx
git add -A src/host src/protocol src/review src/test
git commit -m "feat: stop re-reading working trees while the review tab is hidden"
```

---

### Task 11: Documentation and the critique gate

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/plans/2026-08-16-fleet-diff-review-followups.md`

- [ ] **Step 1: Update the architecture map**

In `CLAUDE.md`, add to the path table:

| Path | Responsibility |
|---|---|
| `src/host/webview-html.ts` | One CSP and nonce for every webview surface |
| `src/host/post-bus.ts` | Fan-out to registered clients; `REVIEW_WANTS` is the review tab's allow-list |
| `src/host/review-panel.ts` | The review editor tab: creation, restore, transport |
| `src/review/` | The review client: its own reducer, store and surface |

Update the ASCII diagram so `PostBus` sits between `SessionManager` and the two clients, and change the `fleet-diff.tsx` row's path from `src/webview/components/` to `src/review/`.

Add an invariant under **Invariants**:

```markdown
- **The review tab is a second client, not a second source of truth.** It
  registers on the `PostBus` with `REVIEW_WANTS` — an allow-list, so a new
  message type defaults to not reaching it — and never subscribes to
  `session-patch`. Visible-set gating stays in `SessionManager` and is not
  re-decided anywhere else. Its view state (collapse, opened rows) is
  deliberately ephemeral: both describe a reading position in a list that
  re-reads itself while agents work, so a restored one would describe a tree
  nobody checked this launch.
```

- [ ] **Step 2: Mark the followups doc**

At the top of `docs/superpowers/plans/2026-08-16-fleet-diff-review-followups.md`, add:

```markdown
> **§1, §3 and §5 are done** — see
> [the review tab spec](../specs/2026-08-17-fleet-diff-review-tab-design.md) and
> [its plan](2026-08-17-fleet-diff-review-tab.md). §2 dissolved with the move to
> an editor tab: the panes are never replaced, so a permission card can no
> longer be hidden by the review surface. **§4, §6 and §7 remain open.**
```

- [ ] **Step 3: Commit the docs**

```bash
cd /e/Efebia/hiiiid-code && git add CLAUDE.md docs
git commit -m "docs: record the review tab in the architecture map"
```

- [ ] **Step 4: Run the critique gate — two isolated agents**

**The implementer must not run this.** A gate re-scored by whoever fixed its findings is not a gate. The controller dispatches two independent agents over `src/webview` and `src/review`, neither having seen the implementation conversation, and compares against the previous run in `.impeccable/critique/`.

Baseline to beat: **24/40** (2026-08-16). The score is expected to go up.

- [ ] **Step 5: Manual verification in the Extension Development Host**

Press F5 and confirm each, in order:

1. The panel opens at 300px; the review control is present and **enabled** — the width gate is gone.
2. Clicking it opens the "Changes" tab beside the editor.
3. A session going `awaiting-approval` while the tab is open still shows its permission card in the sidebar. (This is §2, dissolved rather than fixed — verify it, do not assume it.)
4. Filter, contested-only, collapse, arrow-key movement, next/prev, and "Show N more" each behave as their tests claim.
5. `Developer: Reload Window` restores the tab with content, not blank.
6. Move the tab to a background editor group, let an agent edit files, return to it: it re-reads once on becoming visible.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: host panel and shared CSP → Task 2; third bundle and narrow reducer → Task 3; fan-out → Task 1; `open-review` interception and the command → Task 2; serializer → Task 2; sidebar deletions → Task 4; hierarchy, prefixes, sticky group headers → Task 7; contested promotion and live status → Task 9; filter, collapse, keyboard, next/prev, opened marker, `omitted` control → Tasks 5–8; ephemeral view state with its written reason → Task 7 Step 7 and Task 11 Step 1; visibility gating → Task 10; testing and gates → every task, plus Task 11.

**Deferred and unchanged, by design:** §4 (refresh acknowledgement and throttle), §6 (remaining smaller items, including the loading-state polish inherited verbatim in Task 3 Step 5), §7 (open design questions).

**Type consistency.** `clampCap` / `FILE_CAP` / `MAX_FILE_CAP` (Task 5) are used under those names in Tasks 5 only. `filterTree` / `countFiles` (Task 6) and `commonPrefix` / `stripPrefix` (Task 7) are consumed in `fleet-diff.tsx` under the same names. `nextIndex` / `useRovingRows` (Task 8) likewise. `REVIEW_WANTS` is defined in Task 1 and consumed in Task 2. `ReviewState.visible` is added in Task 10 and read in the same task.
