import * as assert from 'assert';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import { resizeTo } from './setup';
import { flattenLeaves, gridDims } from '../../webview/components/layout-tree';
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

function hydrate(layout: PaneLayout, ids: string[], autoGrid: boolean | undefined) {
  sendFromHost({
    t: 'hydrate',
    sessions: ids.map((id) => summary(id)),
    layout,
    snapshots: ids.map((id) => snapshot(id)),
    catalog: catalog(),
    unavailable: [],
    usage: {},
    autoGrid,
  });
}

async function arrive(id: string, existing: string[]) {
  await act(async () => {
    sendFromHost({ t: 'sessions-changed', sessions: [...existing, id].map((i) => summary(i)) });
    sendFromHost({ t: 'session-snapshot', session: snapshot(id) });
  });
}

function lastLayout() {
  const last = posted().filter((m) => m.t === 'set-layout').at(-1);
  if (!last || last.t !== 'set-layout') { throw new Error('no set-layout posted'); }
  return last.layout.root;
}

suite('auto grid', () => {
  setup(() => resetHost());

  test('a full plain grid is regridded with every session kept, and no notice appears', async () => {
    renderApp();
    resizeTo(1400);
    hydrate(layoutOf(['s1', 's2']), ['s1', 's2'], true);
    await arrive('s3', ['s1', 's2']);
    const root = lastLayout();
    assert.deepStrictEqual(flattenLeaves(root).map((l) => l.sessionId).filter(Boolean), ['s1', 's2', 's3']);
    assert.strictEqual(gridDims(root) !== undefined, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
  });

  test('a full custom layout keeps the session placement and offers a rearrange that regrids on accept', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], true);
    await arrive('s4', ['s1', 's2', 's3']);
    const placed = lastLayout();
    assert.strictEqual(gridDims(placed) === undefined, true);
    await userEvent.click(screen.getByRole('button', { name: 'Rearrange' }));
    const root = lastLayout();
    assert.strictEqual(gridDims(root) !== undefined, true);
    const order = (r: LayoutNode) => flattenLeaves(r).map((l) => l.sessionId).filter(Boolean);
    assert.deepStrictEqual(order(root), order(placed));
    assert.strictEqual(order(root).length, 4);
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
  });

  test('keeping the custom layout dismisses the offer without touching the layout', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], true);
    await arrive('s4', ['s1', 's2', 's3']);
    const before = posted().filter((m) => m.t === 'set-layout').length;
    await userEvent.click(screen.getByRole('button', { name: 'Keep layout' }));
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
    assert.strictEqual(posted().filter((m) => m.t === 'set-layout').length, before);
  });

  test('a panel too narrow for two columns offers to expand the sidebar, which asks the host to', async () => {
    renderApp();
    resizeTo(600);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], true);
    await arrive('s4', ['s1', 's2', 's3']);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    assert.strictEqual(posted().some((m) => m.t === 'expand-sidebar'), true);
  });

  test('a panel wide enough for two columns does not offer to expand', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], true);
    await arrive('s4', ['s1', 's2', 's3']);
    assert.strictEqual(screen.queryByRole('button', { name: 'Expand sidebar' }) === null, true);
  });

  test('with autoGrid off a custom layout never offers anything', async () => {
    renderApp();
    resizeTo(1400);
    hydrate({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], false);
    await arrive('s4', ['s1', 's2', 's3']);
    assert.strictEqual(screen.queryByRole('button', { name: 'Rearrange' }) === null, true);
  });
});
