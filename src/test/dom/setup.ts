// Load order matters: this file is required (via mocha's --require) after
// `global-jsdom/register`. That package installs `window` as a global before
// this file runs; requiring this file first throws `ReferenceError: window
// is not defined` at the `window.` assignments below.
import { cleanup } from '@testing-library/react';
import { resetHost } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// global-jsdom copies a one-time snapshot of jsdom's window properties onto
// Node's globalThis at registration; it does not keep the two objects in
// sync afterwards, and jsdom itself supplies none of these APIs. So every
// stub below is installed on BOTH objects, because different consumers read
// from different ones:
//   - `pane-group.tsx` writes a bare `new ResizeObserver(...)`, which
//     resolves against `globalThis.ResizeObserver`.
//   - `react-resizable-panels` reads `element.ownerDocument.defaultView`,
//     i.e. the real jsdom `window` (a distinct object from `globalThis`
//     here) — so it needs `window.ResizeObserver`.
// The same split applies to IntersectionObserver and matchMedia: nothing
// exercises them today, but libraries commonly spell them `window.foo(...)`,
// so both objects get the stub to avoid the same failure mode.
class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}

globalThis.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;
window.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
window.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;

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
