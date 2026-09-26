import * as assert from 'assert';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import { flattenLeaves } from '../../webview/components/layout-tree';
import type { PaneLayout } from '../../protocol/messages';

function hydrate(layout: PaneLayout, ids: string[], shown: string[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: ids.map((id) => summary(id)),
    layout,
    snapshots: shown.map((id) => snapshot(id)),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

function lastLayout() {
  const last = posted().filter((m) => m.t === 'set-layout').at(-1);
  if (!last || last.t !== 'set-layout') { throw new Error('no set-layout posted'); }
  return flattenLeaves(last.layout.root).map((l) => l.sessionId);
}

suite('fixed slots', () => {
  setup(() => resetHost());

  test('dropping on the middle of an occupied pane swaps the two sessions', () => {
    renderApp();
    hydrate(layoutOf(['s1', 's2']), ['s1', 's2'], ['s1', 's2']);
    fireEvent.dragStart(screen.getByLabelText('Drag Session s1 to split or reassign a pane'), { dataTransfer: { effectAllowed: '' } });
    const zone = within(screen.getByLabelText('Session: Session s2')).getByTestId('drop-zone-center');
    fireEvent.dragOver(zone);
    fireEvent.drop(zone);
    assert.deepStrictEqual(lastLayout(), ['s2', 's1']);
  });

  test('focusing a pane tells the host which pane is focused',  () => {
    renderApp();
    hydrate(layoutOf(['s1', 's2']), ['s1', 's2'], ['s1', 's2']);
    fireEvent.focusIn(screen.getAllByLabelText('Message')[1]);
    assert.strictEqual(posted().some((m) => m.t === 'focus-pane' && m.sessionId === 's2'), true);
  });

  test('a session arriving with no empty slot splits the last-focused pane along its parent orientation', async () => {
    renderApp();
    hydrate(layoutOf(['s1', 's2'], 'horizontal'), ['s1', 's2'], ['s1', 's2']);
    fireEvent.focusIn(screen.getAllByLabelText('Message')[0]);
    await act(async () => {
      sendFromHost({ t: 'sessions-changed', sessions: [summary('s1'), summary('s2'), summary('s3')] });
      sendFromHost({ t: 'session-snapshot', session: snapshot('s3') });
    });
    assert.deepStrictEqual(lastLayout(), ['s1', 's3', 's2']);
  });

  test('an empty slot offers a hidden roster session and fills itself with it', async () => {
    renderApp();
    const layout: PaneLayout = {
      root: {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [{ kind: 'leaf', sessionId: 's1', size: 50 }, { kind: 'leaf', sessionId: null, size: 50 }],
      },
      presets: [],
    };
    hydrate(layout, ['s1', 's2'], ['s1']);
    const slot = screen.getByRole('group', { name: 'Empty slot' });
    fireEvent.click(within(slot).getByRole('button', { name: /Pick from roster/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Session s2' }));
    assert.deepStrictEqual(lastLayout(), ['s1', 's2']);
  });

  test('Remove slot collapses the split, and is unavailable on a lone root slot', async () => {
    renderApp();
    const layout: PaneLayout = {
      root: {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [{ kind: 'leaf', sessionId: 's1', size: 50 }, { kind: 'leaf', sessionId: null, size: 50 }],
      },
      presets: [],
    };
    hydrate(layout, ['s1'], ['s1']);
    await userEvent.click(within(screen.getByRole('group', { name: 'Empty slot' })).getByRole('button', { name: /Remove slot/i }));
    assert.deepStrictEqual(lastLayout(), ['s1']);
  });
});
