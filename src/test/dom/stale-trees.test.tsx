import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
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
  await userEvent.click(screen.getByText(/1 of 1 in split/i));
  // `findBy`, not `getBy`: Base UI portals its menu asynchronously.
  await userEvent.click(await screen.findByRole('menuitem', { name: /Working trees/ }));
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
  // empty. This one appears exactly when there is something in it.
  test('no entry point until the host names a tree', async () => {
    renderApp();
    hydrateOne();
    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    assert.strictEqual(screen.queryByRole('menuitem', { name: /Working trees/ }) === null, true);
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
    const button = removeButtons()[0];
    assert.strictEqual(button.hasAttribute('disabled'), false);
    await userEvent.click(button);
    const sent = posted().filter((m) => m.t === 'remove-stale-tree');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].t === 'remove-stale-tree' && sent[0].path, ABANDONED);
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
