import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSnapshot } from '../../protocol/messages';

function hydrate(over: Partial<SessionSnapshot> = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', over)],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', over)],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('SessionHeader MCP', () => {
  setup(() => { resetHost(); });

  test('the button is present even with no servers, and opens onto an empty state', async () => {
    renderApp();
    hydrate();

    const button = screen.getByRole('button', { name: /mcp servers for session a/i });
    await userEvent.click(button);
    assert.ok(await screen.findByText('No MCP servers configured for this session.'));
  });

  test('healthy servers are listed but do not mark the icon', async () => {
    renderApp();
    hydrate({ mcpServers: [{ name: 'github', state: 'connected', toolCount: 12 }] });

    const button = screen.getByRole('button', { name: /mcp servers for session a/i });
    const icon = button.querySelector('svg');
    assert.strictEqual(icon?.getAttribute('class')?.includes('text-destructive'), false);

    await userEvent.click(button);
    assert.ok(await screen.findByText('github'));
    assert.ok(screen.getByText('12 tools'));
  });

  test('a failed server marks the icon and explains itself in the popover', async () => {
    renderApp();
    hydrate({ mcpServers: [{ name: 'stripe', state: 'failed', error: 'spawn ENOENT' }] });

    const button = screen.getByRole('button', { name: /mcp servers for session a/i });
    const icon = button.querySelector('svg');
    assert.strictEqual(icon?.getAttribute('class')?.includes('text-destructive'), true);

    await userEvent.click(button);
    assert.ok(await screen.findByText('spawn ENOENT'));
  });

  test('needs-auth offers no button inside, because the host cannot run OAuth', async () => {
    renderApp();
    hydrate({ mcpServers: [{ name: 'drive', state: 'needs-auth' }] });

    await userEvent.click(screen.getByRole('button', { name: /mcp servers for session a/i }));
    assert.ok(await screen.findByText(/Authorize in a terminal/i));
    assert.strictEqual(screen.queryByRole('button', { name: /authorize/i }), null);
  });

  test('an OpenCode session explains why MCP servers cannot be listed, even with none reported', async () => {
    renderApp();
    hydrate({ providerId: 'opencode' });

    await userEvent.click(screen.getByRole('button', { name: /mcp servers for session a/i }));
    assert.ok(await screen.findByText(
      "MCP servers load from your opencode.json. OpenCode doesn't report their status, so they can't be listed here.",
    ));
  });

  test('two panes report their own servers independently', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a'), summary('b')],
      layout: layoutOf('a', 'b'),
      snapshots: [
        snapshot('a', { mcpServers: [{ name: 'github', state: 'connected' }] }),
        snapshot('b', { mcpServers: [{ name: 'stripe', state: 'failed' }] }),
      ],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.ok(screen.getByRole('button', { name: /mcp servers for session a/i }));
    assert.ok(screen.getByRole('button', { name: /mcp servers for session b/i }));
  });
});
