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

// global-jsdom copies a one-time snapshot of jsdom's window properties onto
// Node's globalThis; it does not keep the two in sync afterwards. jsdom has
// no ResizeObserver of its own, so setup.ts's `globalThis.ResizeObserver
// ??= StubObserver` never reaches the real jsdom Window (a distinct object,
// `window` here) — and react-resizable-panels (PaneGroup) reads it off
// `element.ownerDocument.defaultView`, i.e. that real window, not globalThis.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(window as unknown as { ResizeObserver: typeof ResizeObserver })
  .ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;

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
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    }
  });
}

export function renderApp(): RenderResult {
  return render(<StoreProvider><App /></StoreProvider>);
}

export function renderWithStore(ui: ReactNode): RenderResult {
  return render(<StoreProvider>{ui}</StoreProvider>);
}
