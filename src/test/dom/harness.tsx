import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as AppModule from '@/app';
import type * as StoreModule from '@/store';
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

// require(), not a static `import`: a static import of '@/app' or '@/store'
// is evaluated by the module loader ahead of the assignment above — even
// under tsx's CJS transform — so vscode-api.ts would call the real,
// undefined acquireVsCodeApi() before this file's stub exists. require()
// runs in place, at this point in the file, after the stub is installed.
const { App } = require('@/app') as typeof AppModule;
const { StoreProvider } = require('@/store') as typeof StoreModule;

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
  return [...sent];
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
 *
 * `window.MessageEvent`, not the bare `MessageEvent`: Node 22 has its own
 * native `MessageEvent` global from a different realm than jsdom's, and
 * jsdom's `dispatchEvent` rejects an event constructed from the wrong realm.
 */
export function sendFromHost(...msgs: HostToWebview[]): void {
  act(() => {
    for (const data of msgs) {
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    }
  });
}

/**
 * NEVER hand the returned `container` — or any node queried out of it — to an
 * assertion as a value:
 *
 *     assert.strictEqual(container.querySelector('div'), null);   // NO
 *     assert.strictEqual(container.querySelector('div') === null, true);   // yes
 *
 * A failing `assert` builds its message by running `util.inspect` on the actual
 * value. A jsdom element reaches its parents, its `ownerDocument` and that
 * document's `window`, so inspecting a single div walks the whole graph: the
 * first form above allocated 3.5GB in 4 seconds and took a machine down on
 * 2026-08-14. It only misbehaves while the test is red — i.e. exactly when you
 * are running it. Compare booleans, strings or counts. `screen.getByX` is safe;
 * it throws its own message rather than passing the node to `assert`.
 */
export function renderApp(): RenderResult {
  return render(<StoreProvider><App /></StoreProvider>);
}

/** Same assertion warning as `renderApp` — never assert on a node. */
export function renderWithStore(ui: ReactNode): RenderResult {
  return render(<StoreProvider>{ui}</StoreProvider>);
}
