import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionCard } from '@/components/permission-card';
import type { ToolCall } from '../../protocol/messages';
import { catalog, layoutOf, permission, snapshot, summary } from '../fixtures/protocol';
import { posted, renderWithStore, sendFromHost } from './harness';

function hydrateWith(pending: { requestId: string; tool: ToolCall }[]) {
  sendFromHost({
    t: 'hydrate', sessions: [summary('a')], layout: layoutOf(['a']),
    snapshots: [snapshot('a', { pending })], catalog: catalog(), unavailable: [], usage: {},
  });
}

const LIVE = [{ requestId: 'r1', tool: permission().tool }];

suite('PermissionCard', () => {
  test('a live pending request renders enabled Allow and Deny', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    screen.getByText('Edit a.txt?');
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, false);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, false);
  });

  test('clicking Allow posts permission-decision with allow true', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    await userEvent.click(screen.getByLabelText('Allow Write'));
    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision', id: 'a', requestId: 'r1', decision: { allow: true },
    });
  });

  test('clicking Deny posts a denial carrying the reason', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    await userEvent.click(screen.getByLabelText('Deny Write'));
    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision', id: 'a', requestId: 'r1',
      decision: { allow: false, reason: 'Denied by user' },
    });
  });

  test('answering disables both buttons with no host round-trip', async () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    await userEvent.click(screen.getByLabelText('Allow Write'));
    const after = posted().length;
    assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, true);
    assert.strictEqual((screen.getByLabelText('Deny Write') as HTMLButtonElement).disabled, true);
    await userEvent.click(screen.getByLabelText('Allow Write'));
    assert.strictEqual(posted().length, after, 'a second click must post nothing');
  });

  test('a pending item the host no longer holds renders as stale', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith([]);
    screen.getByText('Write — no longer awaiting a response');
    assert.strictEqual((screen.getByLabelText('Allow Write (unavailable)') as HTMLButtonElement).disabled, true);
    assert.strictEqual((screen.getByLabelText('Deny Write (unavailable)') as HTMLButtonElement).disabled, true);
  });

  test('a resolved item is the normal tool row with a cross, and keeps the reason when opened', async () => {
    const item = permission({ state: 'denied', reason: 'nope' });
    renderWithStore(<PermissionCard item={item} sessionId="a" />);
    hydrateWith(LIVE);
    screen.getByText('Write');
    screen.getByLabelText('denied');
    assert.strictEqual(screen.queryByLabelText('Allow Write') === null, true);
    await userEvent.click(screen.getByText('Write'));
    screen.getByText('nope');
  });

  test('an edit-shaped input renders a diff preview', () => {
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/tmp/a.txt', op: 'modify', edits: [{ before: 'one', after: 'two' }] }],
    };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    screen.getByText('/tmp/a.txt');
    const pre = document.querySelector('pre');
    assert.strictEqual(pre === null, false);
    assert.strictEqual(pre!.textContent, '-one+two');
  });

  test('a fallback permission renders its filepath as an openable path, not JSON', async () => {
    const tool: ToolCall = {
      kind: 'other', label: 'Read', raw: { filepath: '/tmp/a.txt', parentDir: '/tmp', followSymlinks: false },
    };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);

    const path = screen.getByTitle('/tmp/a.txt');
    screen.getByText('follow Symlinks');
    screen.getByText('false');
    assert.strictEqual(document.querySelector('pre') === null, true);
    await userEvent.click(path);
    assert.deepStrictEqual(posted().at(-1), { t: 'reveal-file', path: '/tmp/a.txt' });
  });

  test('the live card shows the session folder next to the tool name', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    screen.getByText('tmp');
  });

  test('an mcp-attributed request shows the server badge next to the bare name', () => {
    const tool: ToolCall = { kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    assert.ok(screen.getAllByText('github').length > 0);
    screen.getByText('Call create_pr?');
  });

  test('a command and an edit are titled by their action, not the tool name', () => {
    const command: ToolCall = { kind: 'command', label: 'Bash', command: 'git push --force origin main' };
    renderWithStore(<PermissionCard item={permission({ tool: command })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool: command }]);
    screen.getByText('Run this command?');
  });

  test('a file read is titled by the file', () => {
    const read: ToolCall = { kind: 'file-read', label: 'Read', path: '/home/user/.ssh/config' };
    renderWithStore(<PermissionCard item={permission({ tool: read })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool: read }]);
    screen.getByText('Read config?');
  });

  test('an approved command is the normal command row plus a check', () => {
    const command: ToolCall = { kind: 'command', label: 'Bash', command: 'git push origin main' };
    renderWithStore(<PermissionCard item={permission({ tool: command, state: 'allowed' })} sessionId="a" />);
    screen.getByText('Bash');
    screen.getByText('git push origin main');
    screen.getByLabelText('allowed');
  });

  test('a plan transition is neutral', () => {
    const tool: ToolCall = {
      kind: 'plan', label: 'ExitPlanMode', text: '# Feed',
    };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    screen.getByText('Plan ready');
    screen.getByText(/leave read-only Plan mode/i);
    screen.getByRole('button', { name: 'Keep planning' });
    screen.getByRole('button', { name: 'Start implementation' });
  });

  suite('the backend permission engine metadata', () => {
    const META = {
      title: 'Claude wants to write a.txt', description: 'Creates a file that does not exist yet',
      decisionReason: 'outside allowed directories', blockedPath: '/tmp/a.txt',
    };

    test('every field the provider sent is rendered on the live card', () => {
      renderWithStore(<PermissionCard item={permission({ meta: META })} sessionId="a" />);
      hydrateWith(LIVE);
      screen.getByText('Claude wants to write a.txt');
      screen.getByText('Creates a file that does not exist yet');
      screen.getByText('outside allowed directories');
      assert.ok(screen.getAllByText('/tmp/a.txt').length > 0);
    });

    test('a partial meta renders only what is there', () => {
      const item = permission({ meta: { decisionReason: 'not in the allowlist' } });
      renderWithStore(<PermissionCard item={item} sessionId="a" />);
      hydrateWith(LIVE);
      screen.getByText('not in the allowlist');
      assert.strictEqual(screen.queryByText('Claude wants to write a.txt') === null, true);
    });

    test('no meta leaves the card exactly as it was', () => {
      renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
      hydrateWith(LIVE);
      screen.getByText('Edit a.txt?');
      assert.strictEqual((screen.getByLabelText('Allow Write') as HTMLButtonElement).disabled, false);
    });

    test('displayName names the tool in the heading and both accessible names', () => {
      const item = permission({ meta: { displayName: 'Write file' } });
      renderWithStore(<PermissionCard item={item} sessionId="a" />);
      hydrateWith(LIVE);
      screen.getByText('Allow Write file?');
      assert.strictEqual((screen.getByLabelText('Allow Write file') as HTMLButtonElement).disabled, false);
      assert.strictEqual((screen.getByLabelText('Deny Write file') as HTMLButtonElement).disabled, false);
    });

    test('a settled card still carries the metadata, once the row is opened', async () => {
      const item = permission({ state: 'allowed', meta: META });
      renderWithStore(<PermissionCard item={item} sessionId="a" />);
      hydrateWith([]);
      screen.getByLabelText('allowed');
      await userEvent.click(screen.getByText('Write'));
      screen.getByText(/Claude wants to write a.txt/);
    });
  });

  test('a mid-length edit previews compactly with a reveal', () => {
    const after = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Write', files: [{ path: '/a', op: 'create', edits: [{ after }] }],
    };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    screen.getByText(/more lines/);
  });

  test('the approver sees the whole path, never the shortened tail', () => {
    const full = '/repo/../../etc/passwd';
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Write',
      files: [{ path: full, op: 'create', edits: [{ after: 'x' }] }],
    };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    screen.getByText(full);
  });
});
