import * as assert from 'assert';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StaleTree } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

const TREE = '/repo/trees/feat-x';
const ABANDONED = '/repo/trees/old-thing';

function hydrateOne() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { cwd: TREE })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { cwd: TREE })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

/** Hydrate, answer the sweep with `trees`, then open the review dialog. */
async function openSweep(trees: StaleTree[]) {
  renderApp();
  hydrateOne();
  sendFromHost({ t: 'stale-trees', trees });
  await userEvent.click(screen.getByRole('button', { name: /^Working trees/ }));
  // `findBy`, not `getBy`: Base UI portals its popup asynchronously.
  await screen.findByRole('dialog');
}

/**
 * Walk a row's `Remove…` trigger through to the destructive confirm item.
 * Nothing is posted until the second click — that is the whole point of the
 * two-step shape, so the tests spell both steps out rather than hiding them.
 */
async function confirmRemoval(name: string) {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^Remove ${name}`) }));
  await userEvent.click(await screen.findByRole('menuitem', { name: `Remove ${name}` }));
}

/** Every row's text, read as strings — never as nodes. See the harness. */
function rowTexts(): string[] {
  return screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
}

function removeButtons() {
  return screen.getAllByRole('button', { name: /^Remove / });
}

suite('StaleTrees', () => {
  test('the panel asks which working trees it still touches', () => {
    renderApp();
    hydrateOne();
    assert.strictEqual(posted().filter((m) => m.t === 'request-stale-trees').length, 1);
  });

  // An entry point that is empty nine times out of ten teaches the user it is
  // empty. This one appears exactly when there is something in it — and it is
  // its own control in the picker row, not a fourth concept filed inside the
  // menu whose trigger says "in split".
  test('no entry point until the host names a tree', () => {
    renderApp();
    hydrateOne();
    assert.strictEqual(screen.queryByRole('button', { name: /^Working trees/ }) === null, true);
  });

  test('the entry point is a picker-row control carrying the count', () => {
    renderApp();
    hydrateOne();
    sendFromHost({
      t: 'stale-trees',
      trees: [
        { path: TREE, branch: 'feat-x', clean: true, sessionId: 'a' },
        { path: ABANDONED, branch: 'old-thing', clean: true },
      ],
    });
    screen.getByRole('button', { name: /^Working trees \(2\)/ });
  });

  test('opening it asks again and renders a row per tree', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    assert.strictEqual(posted().filter((m) => m.t === 'request-stale-trees').length, 2);
    assert.strictEqual(screen.getAllByRole('listitem').length, 1);
  });

  test('one row per tree, each naming its branch', async () => {
    await openSweep([
      { path: TREE, branch: 'feat-x', clean: true, sessionId: 'a' },
      { path: ABANDONED, branch: 'old-thing', clean: true },
    ]);
    const rows = rowTexts();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.some((r) => r.includes('feat-x')), true);
    assert.strictEqual(rows.some((r) => r.includes('old-thing')), true);
  });

  // The distinction the whole sweep exists for: a tree with a session in it
  // still has a pane header offering the same door, and one without does not.
  test('a row says whether a session is still in it', async () => {
    await openSweep([
      { path: TREE, branch: 'feat-x', clean: true, sessionId: 'a' },
      { path: ABANDONED, branch: 'old-thing', clean: true },
    ]);
    const rows = rowTexts();
    const owned = rows.find((r) => r.includes('feat-x')) ?? '';
    const unowned = rows.find((r) => r.includes('old-thing')) ?? '';
    assert.strictEqual(owned.includes('Session a'), true);
    assert.strictEqual(unowned.includes('No session'), true);
  });

  test('a clean row can be removed, and says which path it removes', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    assert.strictEqual(removeButtons()[0].hasAttribute('disabled'), false);
    await confirmRemoval('old-thing');
    const sent = posted().filter((m) => m.t === 'remove-stale-tree');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].t === 'remove-stale-tree' && sent[0].path, ABANDONED);
  });

  // The row's trigger deletes nothing. Everything below this line is the
  // reason the roster nests its own Delete behind a confirm, applied to the
  // one control in this panel that removes a directory from disk.
  test('the row trigger opens a confirmation rather than removing', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    await userEvent.click(screen.getByRole('button', { name: /^Remove old-thing/ }));
    assert.strictEqual(posted().filter((m) => m.t === 'remove-stale-tree').length, 0);
    // The ellipsis is the visible half of that promise.
    assert.strictEqual(removeButtons()[0].textContent?.includes('…'), true);
  });

  // The keyboard path is the one that bites: Base UI focuses a menu's first
  // item when the menu is opened from the keyboard, so Enter-Enter must not
  // be the gesture that deletes a directory.
  test('the confirmation lands on the way out, not on the deletion', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    screen.getByRole('button', { name: /^Remove old-thing/ }).focus();
    await userEvent.keyboard('{Enter}');
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent ?? '');
    assert.deepStrictEqual(items, ['Keep it', 'Remove old-thing']);
    await waitFor(() => {
      if (document.activeElement?.textContent !== 'Keep it') {
        throw new Error(`the confirm landed on ${document.activeElement?.textContent ?? 'nothing'}`);
      }
    });
    assert.strictEqual(posted().filter((m) => m.t === 'remove-stale-tree').length, 0);
  });

  test('a second confirm while the removal is in flight posts nothing', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    await confirmRemoval('old-thing');
    // No sweep has come back yet: the host is still shelling out to git, and
    // the row is exactly as it was.
    assert.strictEqual(removeButtons()[0].hasAttribute('disabled'), true);
    assert.strictEqual(posted().filter((m) => m.t === 'remove-stale-tree').length, 1);
  });

  // Initial focus is independent of the confirm above: neither alone is
  // enough, because Base UI resolves focus to the popup's first tabbable
  // element and the row buttons precede the footer's Close.
  test('opening the dialog does not focus a row control', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    const heading = screen.getByRole('heading', { name: 'Working trees' });
    // `waitFor`, not a bare assert: Base UI moves initial focus in an effect
    // after the popup is in the DOM, so the dialog is queryable a tick before
    // focus has settled.
    await waitFor(() => {
      if (document.activeElement !== heading) {
        throw new Error(`focus is on ${document.activeElement?.tagName ?? 'nothing'}`);
      }
    });
    assert.strictEqual(
      removeButtons().some((b) => b === document.activeElement), false,
      'initial focus landed on a control that deletes a directory',
    );
  });

  test('a dirty row is marked, refused, and explains itself in the flow', async () => {
    await openSweep([{
      path: ABANDONED, branch: 'old-thing', clean: false,
      reason: 'The worktree has uncommitted changes. Commit or discard them before bringing the branch back.',
    }]);
    assert.strictEqual(rowTexts()[0].includes('uncommitted'), true);
    const button = removeButtons()[0];
    assert.strictEqual(button.hasAttribute('disabled'), true);
    // A disabled control carries `disabled:pointer-events-none` and can be
    // neither hovered nor announced, so the reason is rendered, not tooltipped
    // — the same rule BringBackDialog and RelocationCard keep.
    assert.strictEqual(button.getAttribute('title') === null, true);
    screen.getByText(/uncommitted changes/);
    // Disabled, and with no way past it: the confirm never opens, so there is
    // no second click that could reach the removal behind it.
    await userEvent.click(button);
    assert.strictEqual(screen.queryAllByRole('menuitem').length, 0);
    assert.strictEqual(posted().filter((m) => m.t === 'remove-stale-tree').length, 0);
  });

  test('opening re-asks, because a tree goes dirty while a dialog sits open', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    assert.strictEqual(posted().filter((m) => m.t === 'request-stale-trees').length, 2);
  });

  test('a refusal arriving while the dialog is open replaces what it shows', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    sendFromHost({
      t: 'stale-trees',
      trees: [{
        path: ABANDONED, branch: 'old-thing', clean: true,
        reason: 'Could not remove the worktree: it is locked.',
      }],
    });
    screen.getByText(/it is locked/);
    assert.strictEqual(removeButtons()[0].hasAttribute('disabled'), true);
  });

  test('a swept tree simply stops being a row', async () => {
    await openSweep([{ path: ABANDONED, branch: 'old-thing', clean: true }]);
    sendFromHost({ t: 'stale-trees', trees: [] });
    assert.strictEqual(screen.queryAllByRole('listitem').length, 0);
    // Not an empty list with no explanation: the dialog is still open, and
    // the user needs to see that the thing they clicked actually happened.
    within(screen.getByRole('dialog')).getByText(/Nothing left to sweep/);
  });
});
