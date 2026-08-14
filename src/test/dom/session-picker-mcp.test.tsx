import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSnapshot } from '../../protocol/messages';

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1', providerId: 'claude', model: 'claude-opus-5', title: 'hiiiid-code',
    cwd: '/work/hiiiid-code', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1, includeEditorContext: true,
    items: [], hasMore: false, pending: [], mcpServers: [], ...over,
  };
}

function hydrate(snap: SessionSnapshot) {
  sendFromHost({
    t: 'hydrate',
    sessions: [snap],
    layout: { orientation: 'vertical', panes: [{ sessionId: snap.id, size: 100 }] },
    catalog: [{ id: 'claude', displayName: 'Claude', models: [] }],
    snapshots: [snap],
    usage: {},
  });
}

suite('roster MCP group', () => {
  setup(() => { resetHost(); });

  test('no group and no trigger warning when there are no servers', async () => {
    renderApp();
    hydrate(snapshot());

    assert.strictEqual(screen.queryByText(/MCP:/), null);
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.strictEqual(screen.queryByText(/MCP servers/i), null);
  });

  test('healthy servers are listed but do not warn on the trigger', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
    });

    assert.strictEqual(screen.queryByText(/MCP:/), null, 'silent when healthy');
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(await screen.findByText('github'));
    assert.ok(screen.getByText('12 tools'));
  });

  test('a failed server warns on the trigger and explains itself in the list', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'stripe', state: 'failed', error: 'spawn ENOENT' }],
    });

    assert.ok(screen.getByText('MCP: failed'));
    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(await screen.findByText('spawn ENOENT'));
  });

  test('needs-auth offers no button, because the host cannot run OAuth', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'drive', state: 'needs-auth' }],
    });

    await userEvent.click(screen.getByRole('button', { name: /in split/i }));
    assert.ok(await screen.findByText(/Authorize in a terminal/i));
    assert.strictEqual(screen.queryByRole('button', { name: /authorize/i }), null);
  });

  test('a blocked agent outranks a broken server in the trigger slot', async () => {
    renderApp();
    hydrate(snapshot({ status: 'awaiting-approval' }));
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'stripe', state: 'failed' }],
    });

    assert.ok(screen.getByText('1 needs you'));
    assert.strictEqual(screen.queryByText('MCP: failed'), null);
  });
});
