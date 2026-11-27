import * as assert from 'node:assert';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { summary } from '../fixtures/protocol';
import { posted, renderHistory, resetHost, sendFromHost } from './history-harness';
import type { MovePanel } from '../../protocol/messages';

const remote = { deviceId: 'd1', deviceName: 'PC-desk', online: true, lastSeenAt: 1, relCwd: '.' };
const panel = (over: Partial<MovePanel> = {}): MovePanel => ({
  id: 'r', mode: 'move', checkouts: [
    { root: '/w/repo', branch: 'main', main: true },
    { root: '/w/repo/.worktrees/feat-x', branch: 'feat/x', main: false },
  ], defaultRoot: '/w/repo', branch: 'main', thread: 'restored', ownerName: 'PC-desk', lastSeenAt: 1, ...over,
});

function open() {
  renderHistory();
  sendFromHost({ t: 'hydrate', sessions: [summary('r', { name: 'fixer', title: 'Fix it', remote })] } as never);
}

suite('history: moving a session here', () => {
  setup(() => { resetHost(); });

  test('Move here… on a remote row asks the host for the panel', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'request-move-panel'), [{ t: 'request-move-panel', id: 'r' }]);
  });

  test('the panel shows the title, the checkouts and the thread line, and moving posts the picked root', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    sendFromHost({ t: 'move-panel', panel: panel() });
    await screen.findByText('Move "fixer" here');
    assert.strictEqual(screen.getByText('The agent thread comes along.').textContent, 'The agent thread comes along.');
    await userEvent.click(screen.getByRole('radio', { name: 'feat-x · feat/x' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move here' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'move-session'), [{ t: 'move-session', id: 'r', target: { root: '/w/repo/.worktrees/feat-x' }, cancelTurn: false }]);
  });

  test('progress disables the action, a failure shows its reason, and done opens the session', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    sendFromHost({ t: 'move-panel', panel: panel() });
    await screen.findByText('Move "fixer" here');
    sendFromHost({ t: 'move-status', id: 'r', status: { state: 'waiting', step: 'reply' } });
    assert.strictEqual(screen.getByText('Waiting for PC-desk to hand it over…').textContent !== '', true);
    assert.strictEqual((screen.getByRole('button', { name: 'Moving…' }) as HTMLButtonElement).disabled, true);
    sendFromHost({ t: 'move-status', id: 'r', status: { state: 'failed', reason: 'Push your changes on PC-desk first: this branch has no upstream.' } });
    assert.strictEqual(screen.getByText('Push your changes on PC-desk first: this branch has no upstream.').textContent !== '', true);
    sendFromHost({ t: 'move-status', id: 'r', status: { state: 'done', sessionId: 'r', thread: 'restored' } });
    await waitFor(() => { assert.strictEqual(screen.queryByText('Move "fixer" here') === null, true); });
    assert.deepStrictEqual(posted().filter((m) => m.t === 'focus-session'), [{ t: 'focus-session', id: 'r' }]);
  });

  test('twenty long checkouts are labelled by folder and branch only', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    const long = 'x'.repeat(180);
    const checkouts = Array.from({ length: 20 }, (_, i) => ({ root: `/very/${long}/tree-${i}`, branch: `b${i}`, main: i === 0 }));
    sendFromHost({ t: 'move-panel', panel: panel({ checkouts, defaultRoot: checkouts[0].root, branch: 'b0' }) });
    await screen.findByText('Move "fixer" here');
    const radios = screen.getAllByRole('radio');
    assert.strictEqual(radios.length, 20);
    assert.strictEqual(radios.every((r, i) => r.getAttribute('aria-label') === `tree-${i} · b${i}`), true);
  });

  test('an unavailable panel shows its reason and only Close', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    sendFromHost({ t: 'move-panel', panel: panel({ mode: 'unavailable', reason: 'PC-desk is offline.' }) });
    await screen.findByText('Can\'t move "fixer"');
    assert.strictEqual(screen.getByText('PC-desk is offline.').textContent, 'PC-desk is offline.');
    assert.strictEqual(screen.queryByRole('button', { name: 'Move here' }) === null, true);
    assert.strictEqual(screen.getAllByRole('button', { name: 'Close' }).length >= 1, true);
  });

  test('focus moves into the dialog once the panel arrives', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Move fixer here' }));
    sendFromHost({ t: 'move-panel', panel: panel() });
    await screen.findByText('Move "fixer" here');
    await waitFor(() => { assert.strictEqual(document.activeElement?.closest('[data-slot="dialog-content"]') !== null, true); });
  });
});
