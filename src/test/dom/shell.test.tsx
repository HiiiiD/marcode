import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as assert from 'assert';
import type { ShellItem } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

const shell = (over: Partial<ShellItem> = {}): ShellItem => ({
  id: 'sh1', ts: 1, role: 'shell', command: 'ls -la', state: 'done', output: 'file-a\nfile-b\n', exitCode: 0, ...over,
});

function hydrateWith(items: ShellItem[]) {
  sendFromHost({
    t: 'hydrate', sessions: [summary('a')], layout: layoutOf(['a']),
    snapshots: [snapshot('a', { items })],
    catalog: catalog(), unavailable: [], usage: {},
  });
}

suite('shell commands', () => {
  test('a bang line posts run-shell and not send', async () => {
    renderApp();
    hydrateWith([]);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    await userEvent.type(box, '!git status{Enter}');
    assert.strictEqual(posted().filter((m) => m.t === 'run-shell').length, 1);
    assert.strictEqual(posted().filter((m) => m.t === 'send').length, 0);
    const run = posted().find((m) => m.t === 'run-shell') as { command: string };
    assert.strictEqual(run.command, 'git status');
  });

  test('a finished command renders as a Bash card with its output shown', async () => {
    renderApp();
    hydrateWith([shell()]);
    await screen.findByText('Bash');
    assert.strictEqual(screen.getAllByText('ls -la').length > 0, true);
    screen.getByText(/file-a/);
  });

  test('a running command streams its output inside the card', async () => {
    renderApp();
    hydrateWith([shell({ state: 'running', exitCode: undefined, output: 'tick-1' })]);
    await screen.findByText(/tick-1/);
  });

  test('a running command is pinned above the composer with a Cancel that posts cancel-shell', async () => {
    renderApp();
    hydrateWith([shell({ state: 'running', exitCode: undefined })]);
    const region = await screen.findByRole('region', { name: 'Running shell command' });
    await userEvent.click(within(region).getByRole('button', { name: /cancel/i }));
    const cancel = posted().find((m) => m.t === 'cancel-shell') as { itemId: string } | undefined;
    assert.strictEqual(cancel?.itemId, 'sh1');
  });

  test('a finished command is not pinned', async () => {
    renderApp();
    hydrateWith([shell()]);
    await screen.findByText('Bash');
    assert.strictEqual(screen.queryByRole('region', { name: 'Running shell command' }) === null, true);
  });

  test('a failed command is marked failed and shows its exit code', async () => {
    renderApp();
    hydrateWith([shell({ exitCode: 2 })]);
    await screen.findByText('failed');
    screen.getByText(/\[exit 2\]/);
  });

  test('a bang the parser rejects does not claim to be a shell command', async () => {
    renderApp();
    hydrateWith([]);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    await userEvent.type(box, '! cat .env');
    assert.strictEqual(screen.queryByText(/nothing goes to the model/) === null, true);
  });

  test('typing a bang shows the shell hint', async () => {
    renderApp();
    hydrateWith([]);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    await userEvent.type(box, '!l');
    await screen.findByText(/nothing goes to the model/);
  });
});
