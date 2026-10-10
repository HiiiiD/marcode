import { screen } from '@testing-library/react';
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

  test('a finished command renders its command, output and exit', async () => {
    renderApp();
    hydrateWith([shell()]);
    await screen.findByText('ls -la');
    screen.getByText(/file-a/);
    screen.getByText('exit 0');
  });

  test('a running command offers Cancel, which posts cancel-shell', async () => {
    renderApp();
    hydrateWith([shell({ state: 'running', exitCode: undefined })]);
    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }));
    const cancel = posted().find((m) => m.t === 'cancel-shell') as { itemId: string } | undefined;
    assert.strictEqual(cancel?.itemId, 'sh1');
  });

  test('a failed command says so in text', async () => {
    renderApp();
    hydrateWith([shell({ exitCode: 2 })]);
    await screen.findByText('exit 2');
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
