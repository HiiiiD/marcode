// Load order matters: this file is required (via mocha's --require) after
// `global-jsdom/register`. That package installs `window` as a global before
// this file runs; requiring this file first throws `ReferenceError: window
// is not defined` at the `window.` assignments below.
import { act, cleanup } from '@testing-library/react';
import { resetHost } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// global-jsdom copies a one-time snapshot of jsdom's window properties onto
// Node's globalThis at registration; it does not keep the two objects in
// sync afterwards, and jsdom itself supplies none of these APIs. So every
// stub below is installed on BOTH objects, because different consumers read
// from different ones:
//   - `use-is-narrow.ts` writes a bare `new ResizeObserver(...)`, which
//     resolves against `globalThis.ResizeObserver`.
//   - `react-resizable-panels` reads `element.ownerDocument.defaultView`,
//     i.e. the real jsdom `window` (a distinct object from `globalThis`
//     here) — so it needs `window.ResizeObserver`.
// The same split applies to IntersectionObserver and matchMedia: nothing
// exercises them today, but libraries commonly spell them `window.foo(...)`,
// so both objects get the stub to avoid the same failure mode.
type StubResizeCallback = (entries: [{ contentRect: { width: number } }]) => void;

// jsdom has no layout engine, so nothing here ever reports a real width.
// `observe()` records the callback per element instead of discarding it, so
// a test can drive it directly through `resizeTo` below to exercise the
// narrow-panel path. Until a test calls `resizeTo`, no callback ever fires —
// `narrow` keeps its `useState(false)` default, exactly as before — so this
// stays a no-op for every suite that doesn't ask for it.
const resizeCallbacks = new Map<Element, StubResizeCallback>();

class StubResizeObserver {
  #callback: StubResizeCallback;

  constructor(callback: StubResizeCallback) { this.#callback = callback; }

  observe(el: Element): void { resizeCallbacks.set(el, this.#callback); }

  unobserve(el: Element): void { resizeCallbacks.delete(el); }

  disconnect(): void {
    for (const [el, callback] of resizeCallbacks) {
      if (callback === this.#callback) { resizeCallbacks.delete(el); }
    }
  }

  takeRecords(): [] { return []; }
}

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}

globalThis.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;
window.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;
window.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;

/**
 * Fires the `[data-narrow-observer]` element's registered `ResizeObserver`
 * callback as if its content-box width changed to `width` — i.e. drives
 * `useIsNarrow` in `App`. Scoped to that one element rather than every
 * observed element: `react-resizable-panels` registers its own
 * `ResizeObserver`s on panel/group elements, and its callback expects a
 * different entry shape than the bare `{ contentRect }` this stub
 * synthesizes; firing those too crashes the library. Wrapped in `act` so
 * the resulting `setState` is flushed before this returns.
 */
export function resizeTo(width: number): void {
  act(() => {
    for (const [el, callback] of resizeCallbacks) {
      if (el.hasAttribute('data-narrow-observer')) {
        callback([{ contentRect: { width } }]);
      }
    }
  });
}

const stubMatchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;

globalThis.matchMedia ??= stubMatchMedia;
window.matchMedia ??= stubMatchMedia;

// `Element.prototype`, `document` and `HTMLElement` methods below are shared
// references between `globalThis` and `window` (both realms point at the
// same jsdom prototype objects), so a single assignment reaches both — no
// `window.` counterpart needed here.
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
