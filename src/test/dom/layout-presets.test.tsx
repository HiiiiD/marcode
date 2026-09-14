import * as assert from 'assert';
import { screen, fireEvent } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrateTwo() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('s1'), summary('s2')],
    layout: { root: { kind: 'leaf', sessionId: 's1', size: 100 }, presets: [] },
    snapshots: [snapshot('s1')],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('layout presets menu', () => {
  test('applying a preset with room fills it with the currently-visible sessions', () => {
    renderApp();
    hydrateTwo();
    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /2 rows/i }));

    const last = posted().filter((m) => m.t === 'set-layout').at(-1)!;
    assert.strictEqual(last.t, 'set-layout');
    if (last.t !== 'set-layout') { throw new Error('unreachable'); }
    assert.strictEqual(last.layout.root.kind, 'split');
    if (last.layout.root.kind !== 'split') { throw new Error('unreachable'); }
    assert.deepStrictEqual(
      last.layout.root.children.map((c) => (c.kind === 'leaf' ? c.sessionId : undefined)),
      ['s1', null],
    );
  });

  test('a preset with fewer slots than visible sessions is disabled', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('s1'), summary('s2'), summary('s3')],
      layout: layoutOf(['s1', 's2', 's3']),
      snapshots: [snapshot('s1'), snapshot('s2'), snapshot('s3')],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    const stack2 = screen.getByRole('menuitem', { name: /2 rows/i });
    assert.strictEqual(stack2.getAttribute('aria-disabled'), 'true');
  });
});
