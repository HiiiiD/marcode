import * as assert from 'assert';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import type { LayoutNode } from '../../protocol/messages';

/**
 * A freshly created session reaches the client the same way it does in
 * production: `sessions-changed` adds it to the roster, `session-snapshot`
 * gives it a `byId` entry — no `layout-changed` from the host, since these
 * tests exercise the CLIENT's own reconcile-driven placement, not an
 * explicit host-side layout push.
 */
function arrive(id: string) {
  sendFromHost({ t: 'sessions-changed', sessions: [...arrivedSoFar, summary(id)] });
  sendFromHost({ t: 'session-snapshot', session: snapshot(id) });
  arrivedSoFar.push(summary(id));
}
let arrivedSoFar: ReturnType<typeof summary>[] = [];

function hydrateWithEmptySlot() {
  arrivedSoFar = [summary('a')];
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: {
      root: {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [
          { kind: 'leaf', sessionId: 'a', size: 50 },
          { kind: 'leaf', sessionId: null, size: 50 },
        ],
      },
      presets: [],
    },
    snapshots: [snapshot('a')],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('pending slot', () => {
  setup(() => resetHost());

  test('an empty slot\'s own New button fills that exact slot, not a new top-level pane', async () => {
    renderApp();
    hydrateWithEmptySlot();

    await userEvent.click(within(screen.getByRole('group', { name: 'Empty slot' })).getByRole('button', { name: /^New session$/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-large', effort: 'medium', mode: 'default',
    });

    await act(async () => arrive('b'));

    const last = posted().filter((m) => m.t === 'set-layout').at(-1) as { layout: { root: LayoutNode } };
    assert.deepStrictEqual(last.layout.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });

  test('the toolbar\'s New fills an existing empty slot instead of appending a sibling', async () => {
    renderApp();
    hydrateWithEmptySlot();

    await userEvent.click(screen.getAllByRole('button', { name: 'New session' })[0]);

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-large', effort: 'medium', mode: 'default',
    });

    await act(async () => arrive('b'));

    const last = posted().filter((m) => m.t === 'set-layout').at(-1) as { layout: { root: LayoutNode } };
    assert.deepStrictEqual(last.layout.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });

  test('a stale pending slot (filled by someone else first) falls back to the ordinary append', async () => {
    renderApp();
    hydrateWithEmptySlot();

    await userEvent.click(within(screen.getByRole('group', { name: 'Empty slot' })).getByRole('button', { name: /^New session$/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));

    // Something else — another client, a drag, a preset — fills the slot
    // before the session this click asked for ever arrives.
    sendFromHost({
      t: 'layout-changed',
      layout: { presets: [], root: { kind: 'leaf', sessionId: 'a', size: 100 } },
    });

    await act(async () => arrive('b'));

    const last = posted().filter((m) => m.t === 'set-layout').at(-1) as { layout: { root: LayoutNode } };
    // No slot left to fill — falls through to reconcile's overflow split,
    // whose new slot is transient.
    assert.deepStrictEqual(last.layout.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50, transient: true },
      ],
    });
  });
});
