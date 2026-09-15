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

    const describedBy = stack2.getAttribute('aria-describedby');
    assert.ok(describedBy, 'a disabled preset must point at its reason');
    const reason = document.getElementById(describedBy!);
    assert.strictEqual(reason?.textContent, 'Needs 2 panes; 3 are open');
  });

  test('save current layout as preset posts save-preset with the entered name', async () => {
    renderApp();
    hydrateTwo();
    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Save current layout/i }));
    fireEvent.change(screen.getByLabelText(/preset name/i), { target: { value: 'My grid' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    const last = posted().at(-1);
    assert.deepStrictEqual(last, { t: 'save-preset', name: 'My grid' });
  });

  test('a saved preset appears in the menu after a layout-changed echo carrying it, and can be deleted', () => {
    renderApp();
    hydrateTwo();
    sendFromHost({
      t: 'layout-changed',
      layout: { root: { kind: 'leaf', sessionId: 's1', size: 100 }, presets: [{ id: 'p1', name: 'My grid', builtin: false, root: { kind: 'leaf', sessionId: null, size: 100 } }] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    // Anchored, not the old bare `/My grid/i`: apply and delete are now both
    // `menuitem`s (see the keyboard-reachability fix in
    // layout-presets-menu.tsx), and an unanchored match would hit both "My
    // grid" (possibly "My grid ✓" when active) and "Delete My grid" once
    // delete is no longer a plain `button` with its own distinct role.
    assert.strictEqual(screen.getByRole('menuitem', { name: /^My grid/i }) !== undefined, true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete My grid' }));
    const last = posted().at(-1);
    assert.deepStrictEqual(last, { t: 'delete-preset', id: 'p1' });
  });
});
