import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionCard } from '@/components/permission-card';
import { catalog, layoutOf, permission, snapshot, summary } from '../fixtures/protocol';
import { posted, renderWithStore, sendFromHost } from './harness';

function hydrateWith(pending: { requestId: string; name: string; input: unknown }[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { pending })],
    catalog: catalog(),
  });
}

const LIVE = [{ requestId: 'r1', name: 'Write', input: { file_path: '/tmp/a.txt' } }];

suite('PermissionCard', () => {
  test('a live pending request renders enabled Allow and Deny', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    assert.strictEqual(screen.getByText('Allow Write?').textContent, 'Allow Write?');
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, false);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, false);
  });

  test('clicking Allow posts permission-decision with allow true', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Allow Write'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision',
      id: 'a',
      requestId: 'r1',
      decision: { allow: true },
    });
  });

  test('clicking Deny posts a denial carrying the reason', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Deny Write'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision',
      id: 'a',
      requestId: 'r1',
      decision: { allow: false, reason: 'Denied by user' },
    });
  });

  test('answering disables both buttons with no host round-trip', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Allow Write'));
    const after = posted().length;

    // Nothing was sent back from the host: state.byId still lists r1 as pending.
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, true);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, true);

    await userEvent.click(screen.getByLabelText('Allow Write'));
    assert.strictEqual(posted().length, after, 'a second click must post nothing');
  });

  test('a pending item the host no longer holds renders as stale', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Write — no longer awaiting a response');
    assert.strictEqual(
      (screen.getByLabelText('Allow Write (unavailable)') as HTMLButtonElement).disabled, true,
    );
    assert.strictEqual(
      (screen.getByLabelText('Deny Write (unavailable)') as HTMLButtonElement).disabled, true,
    );
  });

  test('a resolved item renders as a one-line summary with no buttons', () => {
    const item = permission({ state: 'denied', reason: 'nope' });
    renderWithStore(<PermissionCard item={item} sessionId="a" />);
    hydrateWith(LIVE);

    screen.getByText('Write — denied: nope');
    assert.strictEqual(screen.queryByLabelText('Allow Write'), null);
  });

  test('an edit-shaped input renders a diff preview', () => {
    const item = permission({
      name: 'Edit',
      input: { file_path: '/tmp/a.txt', old_string: 'one', new_string: 'two' },
    });
    renderWithStore(<PermissionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', name: 'Edit', input: item.input }]);

    const pre = document.querySelector('pre');
    assert.notStrictEqual(pre, null);
    assert.strictEqual(pre!.textContent, '--- /tmp/a.txt\n- one\n+ two');
  });
});
