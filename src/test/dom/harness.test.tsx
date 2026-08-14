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
      usage: {},
    });

    // No await: the assertion runs on the same tick as the dispatch.
    assert.strictEqual(screen.queryByText('Loading…'), null);
  });
});
