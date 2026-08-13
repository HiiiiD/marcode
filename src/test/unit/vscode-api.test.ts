import * as assert from 'assert';

/**
 * `src/webview/vscode-api.ts` calls `acquireVsCodeApi()` at module scope, and the
 * mocha unit harness runs under plain Node (no `window`, no VS Code webview host).
 * We stub the one global the module needs at import time so it can load, then test
 * only the exported `isHostMessage` guard directly — not `onHostMessage`'s wiring
 * to a real `window` `message` event, which would require faking `MessageEvent`
 * and the DOM event dispatch machinery that Node doesn't provide. This matches the
 * "test the guard as an exported predicate" route for environments without a DOM.
 */
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
});

const { isHostMessage } = require('../../webview/vscode-api') as typeof import('../../webview/vscode-api');

suite('vscode-api isHostMessage guard', () => {
  test('accepts an object with a string t discriminant', () => {
    assert.strictEqual(isHostMessage({ t: 'sessions-changed', sessions: [] }), true);
  });

  test('rejects null', () => {
    assert.strictEqual(isHostMessage(null), false);
  });

  test('rejects a bare string payload', () => {
    assert.strictEqual(isHostMessage('not a message'), false);
  });

  test('rejects an object with no t field', () => {
    assert.strictEqual(isHostMessage({ sessions: [] }), false);
  });

  test('rejects an object whose t field is not a string', () => {
    assert.strictEqual(isHostMessage({ t: 42 }), false);
  });
});
