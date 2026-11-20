import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

function hydrateWith(items: TranscriptItem[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { cwd: 'C:\work\my-repo' })],
    layout: layoutOf(['a']),
    snapshots: [snapshot('a', { cwd: 'C:\work\my-repo', items })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('EmptyPane', () => {
  test('a session with no items shows the folder and the hint', () => {
    renderApp();
    hydrateWith([]);

    assert.strictEqual(screen.getByTestId('empty-pane').textContent?.includes('my-repo'), true);
    screen.getByText(/Type \/ for commands/);
  });

  test('it is gone as soon as the first item exists', () => {
    renderApp();
    hydrateWith([{ id: '1', ts: 1, role: 'user', text: 'hello' }]);

    assert.strictEqual(screen.queryByTestId('empty-pane') === null, true);
  });
});
