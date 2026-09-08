import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSnapshot } from '../../protocol/messages';

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1', providerId: 'claude', model: 'claude-opus-5', title: 'mar-code', name: 'mar-code',
    cwd: '/work/mar-code', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 }, resumeTokens: {},
    archived: false, createdAt: 1, updatedAt: 1, includeEditorContext: true,
    pendingQuestions: [],
    items: [], hasMore: false, pending: [], mcpServers: [], pendingAttachments: [], ...over,
  };
}

function hydrate(snap: SessionSnapshot) {
  sendFromHost({
    t: 'hydrate',
    sessions: [snap],
    layout: { orientation: 'vertical', panes: [{ sessionId: snap.id, size: 100 }] },
    catalog: [{ id: 'claude', displayName: 'Claude', models: [], permissionModes: [] }],
    snapshots: [snap],
    unavailable: [],
    usage: {},
  });
}

suite('MCP servers control', () => {
  setup(() => { resetHost(); });

  test('no button when there are no servers', async () => {
    renderApp();
    hydrate(snapshot());

    assert.strictEqual(screen.queryByRole('button', { name: /mcp servers/i }), null);
  });

  test('healthy servers are listed but do not warn on the button', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
    });

    const button = screen.getByRole('button', { name: 'MCP servers' });
    assert.strictEqual(screen.queryByText(/failed|needs auth/i), null, 'silent when healthy');

    await userEvent.click(button);
    assert.ok(await screen.findByText('github'));
    assert.ok(screen.getByText('12 tools'));
  });

  test('a failed server warns on the button and explains itself in the popover', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'stripe', state: 'failed', error: 'spawn ENOENT' }],
    });

    const button = screen.getByRole('button', { name: /mcp servers/i });
    assert.ok(within(button).getByText('failed'));

    await userEvent.click(button);
    assert.ok(await screen.findByText('spawn ENOENT'));
  });

  test('needs-auth offers no button, because the host cannot run OAuth', async () => {
    renderApp();
    hydrate(snapshot());
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'drive', state: 'needs-auth' }],
    });

    await userEvent.click(screen.getByRole('button', { name: /mcp servers/i }));
    assert.ok(await screen.findByText(/Authorize in a terminal/i));
    assert.strictEqual(screen.queryByRole('button', { name: /authorize/i }), null);
  });

  test('a blocked agent and a broken server warn independently, on their own controls', async () => {
    renderApp();
    hydrate(snapshot({ status: 'awaiting-approval' }));
    sendFromHost({
      t: 'session-mcp', id: 's1', servers: [{ name: 'stripe', state: 'failed' }],
    });

    assert.ok(screen.getByText('1 needs you'));
    const button = screen.getByRole('button', { name: /mcp servers/i });
    assert.ok(within(button).getByText('failed'));
  });

  test('an OpenCode session explains why MCP servers cannot be listed, even with none reported', async () => {
    renderApp();
    hydrate(snapshot({ providerId: 'opencode' }));

    await userEvent.click(screen.getByRole('button', { name: /mcp servers/i }));
    assert.ok(await screen.findByText(
      "MCP servers load from your opencode.json. OpenCode doesn't report their status, so they can't be listed here.",
    ));
    assert.strictEqual(screen.queryByText(/unsupported/i), null);
  });

  test('a non-OpenCode session with no servers shows no MCP control', async () => {
    renderApp();
    hydrate(snapshot({ providerId: 'claude' }));

    assert.strictEqual(screen.queryByRole('button', { name: /mcp servers/i }), null);
  });
});
