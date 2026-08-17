import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'src/webview/a.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'src/webview/b.tsx', op: 'modify', insertions: 2, deletions: 1, claimedBy: ['s1'] },
  ],
}];

const READY = {
  t: 'hydrate',
  sessions: [{ id: 's1', title: 'Session A', status: 'idle' }],
  layout: { panes: [], orientation: 'horizontal' },
};

suite('review structure', () => {
  setup(() => { resetHost(); });

  test('nests tree above session above file', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByRole('heading', { level: 3 }).textContent?.includes('repo'), true);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });

  test('names the shared directory once instead of on every row', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('src/webview/').textContent, 'src/webview/');
    assert.strictEqual(screen.queryAllByText('src/webview/').length, 1);
  });

  test('counts the files in a session group', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('2 files').textContent, '2 files');
  });

  test('collapsing a session group hides its rows and keeps its header', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Collapse Session A/ }));

    assert.strictEqual(screen.queryAllByRole('button', { name: /a\.tsx/ }).length, 0);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });

  // jsdom performs no layout, so this cannot verify a rendered pixel — it
  // verifies the relationship the fix depends on: the group header's sticky
  // offset is exactly the tree header's declared height, both read from the
  // same source. A future edit that changes one without the other is a real
  // regression this test cannot catch; only a screenshot can. See the
  // `TREE_HEADER_HEIGHT` comment in fleet-diff.tsx.
  test('the group header sticks exactly below the declared tree header height', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    const treeHeader = screen.getByTestId('tree-header');
    const groupHeader = screen.getByTestId('group-header');
    assert.strictEqual(groupHeader.style.top, treeHeader.style.height);
    assert.notStrictEqual(treeHeader.style.height, '');
  });

  test('widening a filter after collapsing does not re-hide the group it repopulates', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Collapse Session A/ }));
    assert.strictEqual(screen.queryAllByRole('button', { name: /a\.tsx/ }).length, 0);

    const filter = screen.getByLabelText('Filter by path');
    await user.type(filter, 'no-such-file');
    assert.strictEqual(screen.queryByText('Session A') === null, true);

    await user.clear(filter);

    assert.strictEqual(screen.queryAllByRole('button', { name: /a\.tsx/ }).length, 1);
  });

  // 'thinking' is not a real SessionStatus (the type is idle | running |
  // awaiting-approval | error, and `running` renders as "Working" — see
  // src/webview/status.ts); `running` is the substitution that keeps this
  // test's intent — a session that is not idle says so — while staying a
  // status this codebase can actually produce.
  test('a session still working says so on its group', () => {
    renderReview();
    sendFromHost(
      { t: 'hydrate', sessions: [{ id: 's1', title: 'Session A', status: 'running' }],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: TREES } as never,
    );
    // The diff you are reading is still being written. No SCM view can say this.
    assert.strictEqual(screen.getAllByText(/working/i).length > 0, true);
  });

  test('a status change after the diff lands still reaches the group', () => {
    renderReview();
    sendFromHost(
      { t: 'hydrate', sessions: [{ id: 's1', title: 'Session A', status: 'running' }],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: TREES } as never,
      { t: 'sessions-changed',
        sessions: [{ id: 's1', title: 'Session A', status: 'idle' }] } as never,
    );
    assert.strictEqual(screen.queryAllByText(/working/i).length, 0);
  });

  test('a contested file is named as contested, not buried at the end of the row', () => {
    renderReview();
    sendFromHost(
      { t: 'hydrate',
        sessions: [
          { id: 's1', title: 'Session A', status: 'idle' },
          { id: 's2', title: 'Session B', status: 'idle' },
        ],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: [{
        ...TREES[0], sessions: ['s1', 's2'],
        files: [{ path: 'shared.ts', op: 'modify', insertions: 1, deletions: 0,
          claimedBy: ['s1', 's2'] }],
      }] } as never,
    );
    assert.strictEqual(screen.getAllByText('Also Session B').length, 1);
  });

  test('a contested badge carries a title, same as the rename-from span beside it', () => {
    renderReview();
    sendFromHost(
      { t: 'hydrate',
        sessions: [
          { id: 's1', title: 'Session A', status: 'idle' },
          { id: 's2', title: 'Session B', status: 'idle' },
        ],
        layout: { panes: [], orientation: 'horizontal' } } as never,
      { t: 'fleet-diff', trees: [{
        ...TREES[0], sessions: ['s1', 's2'],
        files: [{ path: 'shared.ts', op: 'modify', insertions: 1, deletions: 0,
          claimedBy: ['s1', 's2'] }],
      }] } as never,
    );
    assert.strictEqual(screen.getByText('Also Session B').getAttribute('title'), 'Also Session B');
  });

  test("the group's status region stays mounted at idle so a later transition can still announce", () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    // Nothing visible for an idle session — but the live region itself has
    // to already be in the DOM, or the transition to `running` a moment
    // later would create it with the new text already inside, announcing
    // nothing.
    const region = document.querySelector('[data-testid="group-header"] [aria-live="polite"]');
    assert.strictEqual(region !== null, true);
    assert.strictEqual(region?.textContent, '');

    sendFromHost(
      { t: 'sessions-changed',
        sessions: [{ id: 's1', title: 'Session A', status: 'running' }] } as never,
    );
    const sameRegion = document.querySelector('[data-testid="group-header"] [aria-live="polite"]');
    assert.strictEqual(sameRegion === region, true);
    assert.strictEqual(sameRegion?.textContent?.includes('Working'), true);
  });

  test('the "Contested only" toggle matches the sidebar\'s ghost/secondary on-off pattern', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    const toggle = screen.getByRole('button', { name: /Contested only/ });
    // Off is `ghost` (no `bg-background`, the marker `outline` carries but
    // `ghost` does not), matching `editor-context-toggle.tsx`'s off state —
    // not `outline`, which the sidebar never uses for this on/off pattern.
    assert.strictEqual(toggle.className.includes('bg-background'), false);

    await user.click(toggle);
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'true');
    // On is `secondary`, the same variant the sidebar toggle switches to.
    assert.strictEqual(toggle.className.includes('bg-secondary'), true);
  });

  // `files: []` with no `reason` is not just what a filter empties a tree
  // down to — it is also exactly what SessionManager reports for a *clean*
  // repository a session occupies (one row per repo, clean ones included).
  // With no filter active, that row must keep its header: dropping it would
  // make "this repo is clean" indistinguishable from "this repo was never
  // read", the same implied-answer mistake the empty-fleet copy elsewhere on
  // this surface is careful to avoid.
  test('a clean repository keeps its header when no filter is active', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: [
      ...TREES,
      { root: '/repo-clean', branch: 'main', sessions: ['s1'], base: { kind: 'head' }, omitted: 0, files: [] },
    ] } as never);

    assert.strictEqual(screen.getByText('repo-clean').textContent, 'repo-clean');
  });

  test('an all-clean fleet does not silently render a blank body under "0 changed files"', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: [
      { root: '/repo-clean', branch: 'main', sessions: ['s1'], base: { kind: 'head' }, omitted: 0, files: [] },
    ] } as never);

    assert.strictEqual(screen.getByText('repo-clean').textContent, 'repo-clean');
    assert.strictEqual(screen.queryByText('Nothing to review') === null, true);
  });
});
