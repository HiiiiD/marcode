import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as assert from 'assert';
import type { BringBackPlan } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

const TREE = '/repo/trees/feat-x';

const okPlan: BringBackPlan = {
  ok: true, branch: 'feat-x', worktree: TREE, mainRoot: '/repo',
};

function hydrateInWorktree() {
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

/** Hydrate, answer the header's probe with `plan`, then open the dialog. */
async function openDialog(plan: BringBackPlan) {
  renderApp();
  hydrateInWorktree();
  sendFromHost({ t: 'bring-back-plan', id: 'a', plan });
  await userEvent.click(screen.getByLabelText('More pane actions for Session a'));
  // `findBy`, not `getBy`: Base UI portals its menu asynchronously — every
  // other menu suite here opens one the same way.
  await userEvent.click(await screen.findByRole('menuitem', { name: /Bring branch back/ }));
}

suite('BringBackDialog', () => {
  test('the pane asks whether its directory is a worktree at all', () => {
    renderApp();
    hydrateInWorktree();
    const asked = posted().filter((m) => m.t === 'request-bring-back');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].t === 'request-bring-back' && asked[0].id, 'a');
  });

  test('no door until the host has answered', async () => {
    renderApp();
    hydrateInWorktree();
    // The pane menu itself is always there now (Archive lives in it too) —
    // only the "Bring branch back…" item inside it is gated on the plan.
    await userEvent.click(screen.getByLabelText('More pane actions for Session a'));
    assert.strictEqual(screen.queryByText(/Bring branch back/) === null, true);
  });

  test('no door for a session that is not in a worktree', async () => {
    renderApp();
    hydrateInWorktree();
    sendFromHost({
      t: 'bring-back-plan',
      id: 'a',
      plan: { ok: false, isWorktree: false, reason: 'This directory is the main working tree.' },
    });
    await userEvent.click(screen.getByLabelText('More pane actions for Session a'));
    assert.strictEqual(screen.queryByText(/Bring branch back/) === null, true);
  });

  test('the dialog names both steps and the branch they act on', async () => {
    await openDialog(okPlan);
    // Read as strings, never as nodes: `getByText` compares only an element's
    // own text children, and each step interleaves emphasized spans.
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].includes('Remove the worktree'), true);
    assert.strictEqual(steps[0].includes('feat-x'), true);
    assert.strictEqual(steps[1].includes('Check'), true);
    assert.strictEqual(steps[1].includes('feat-x'), true);
    assert.strictEqual(steps[1].includes('repo'), true);
  });

  test('a refused plan shows its reason and cannot be confirmed', async () => {
    await openDialog({
      ok: false,
      isWorktree: true,
      reason: 'The worktree has uncommitted changes. Commit or discard them before bringing the branch back.',
    });
    screen.getByText(/uncommitted changes/);
    const confirm = screen.getByRole('button', { name: /Bring it back/ });
    assert.strictEqual(confirm.hasAttribute('disabled'), true);
    // The disabled button cannot explain itself, so the flow does — the same
    // rule RelocationCard follows.
    assert.strictEqual(confirm.getAttribute('title') === null, true);
  });

  test('confirming posts bring-back for this session', async () => {
    await openDialog(okPlan);
    await userEvent.click(screen.getByRole('button', { name: /Bring it back/ }));
    const sent = posted().filter((m) => m.t === 'bring-back');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].t === 'bring-back' && sent[0].id, 'a');
  });

  test('opening re-asks, because a plan goes stale while a dialog sits open', async () => {
    await openDialog(okPlan);
    const asked = posted().filter((m) => m.t === 'request-bring-back');
    assert.strictEqual(asked.length, 2);
  });

  test('a refusal arriving while the dialog is open replaces what it shows', async () => {
    await openDialog(okPlan);
    sendFromHost({
      t: 'bring-back-plan',
      id: 'a',
      plan: { ok: false, isWorktree: true, reason: 'The main working tree has uncommitted changes.' },
    });
    screen.getByText(/main working tree has uncommitted changes/);
    assert.strictEqual(
      screen.getByRole('button', { name: /Bring it back/ }).hasAttribute('disabled'),
      true,
    );
  });
});
