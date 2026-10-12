import * as assert from 'assert';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import { resizeTo } from './setup';
import { flattenLeaves, gridDims, gridLayout } from '../../webview/components/layout-tree';
import type { LayoutNode } from '../../webview/components/layout-tree';
import type { PaneLayout } from '../../protocol/messages';

const CUSTOM: LayoutNode = {
  kind: 'split', orientation: 'horizontal', size: 100,
  children: [
    { kind: 'leaf', sessionId: 's1', size: 50 },
    {
      kind: 'split', orientation: 'vertical', size: 50,
      children: [{ kind: 'leaf', sessionId: 's2', size: 50 }, { kind: 'leaf', sessionId: 's3', size: 50 }],
    },
  ],
};

function hydrate(layout: PaneLayout, ids: string[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: ids.map((id) => summary(id)),
    layout,
    snapshots: ids.map((id) => snapshot(id)),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

async function arrive(id: string, existing: string[]) {
  await act(async () => {
    sendFromHost({ t: 'sessions-changed', sessions: [...existing, id].map((i) => summary(i)) });
    sendFromHost({ t: 'session-snapshot', session: snapshot(id) });
  });
}

const layouts = () => posted().flatMap((m) => (m.t === 'set-layout' ? [m.layout.root] : []));
const viewports = () => posted().flatMap((m) => (m.t === 'set-viewport' ? [m] : []));

suite('auto grid', () => {
  setup(() => resetHost());

  test('the panel reports its measured size and smallest useful pane to the host', () => {
    renderApp();
    hydrate(layoutOf(['s1']), ['s1']);
    resizeTo(1400);
    const last = viewports().at(-1);
    assert.strictEqual(last?.viewport.width, 1400);
    assert.deepStrictEqual(last?.minPane, { width: 320, height: 200 });
  });

  test('nothing is reported before the panel has a measured width', () => {
    renderApp();
    hydrate(layoutOf(['s1']), ['s1']);
    assert.strictEqual(viewports().length, 0);
  });

  test('a session the user creates into a full plain grid keeps the old placement', async () => {
    renderApp();
    resizeTo(1400);
    const four = ['s1', 's2', 's3', 's4'];
    hydrate({ root: gridLayout(2, 2, four).root, presets: [] }, four);
    await arrive('s5', four);
    const root = layouts().at(-1) as LayoutNode;
    assert.strictEqual(flattenLeaves(root).filter((l) => l.sessionId).length, 5);
    assert.strictEqual(gridDims(root) === undefined, true);
  });

  test('the host offering a rearrange shows a notice that regrids every pane on accept', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3']);
    await act(async () => { sendFromHost({ t: 'offer-rearrange' }); });
    await userEvent.click(screen.getByRole('button', { name: 'Rearrange' }));
    const root = layouts().at(-1) as LayoutNode;
    assert.strictEqual(gridDims(root) !== undefined, true);
    assert.strictEqual(flattenLeaves(root).filter((l) => l.sessionId).length, 3);
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
  });

  test('keeping the layout dismisses the offer without touching the layout', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3']);
    await act(async () => { sendFromHost({ t: 'offer-rearrange' }); });
    const before = layouts().length;
    await userEvent.click(screen.getByRole('button', { name: 'Keep layout' }));
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
    assert.strictEqual(layouts().length, before);
  });

  test('a panel too narrow for two columns offers to expand the sidebar, which asks the host to', async () => {
    renderApp();
    resizeTo(600);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3']);
    await act(async () => { sendFromHost({ t: 'offer-rearrange' }); });
    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    assert.strictEqual(posted().some((m) => m.t === 'expand-sidebar'), true);
  });

  test('a panel wide enough for two columns does not offer to expand', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3']);
    await act(async () => { sendFromHost({ t: 'offer-rearrange' }); });
    assert.strictEqual(screen.queryByRole('button', { name: 'Expand sidebar' }) === null, true);
  });
});
