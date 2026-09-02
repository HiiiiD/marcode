import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptItemView } from '@/components/transcript-item';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';
import type { ProviderInfo, TranscriptItem } from '../../protocol/messages';

function hydrateWithItems(
  items: TranscriptItem[],
  over: Parameters<typeof summary>[1] & { catalog?: ProviderInfo[] } = {},
) {
  const { catalog: catalogOver, ...summaryOver } = over;
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', summaryOver)],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { ...summaryOver, items })],
    catalog: catalogOver ?? catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('TranscriptItemView', () => {
  test('every item is labelled by role', () => {
    renderApp();
    hydrateWithItems([
      { id: '1', ts: 1, role: 'user', text: 'hello' },
      { id: '2', ts: 2, role: 'assistant', text: 'hi `there`' },
    ]);

    screen.getByText('You');
    screen.getByText('Agent');
  });

  test('assistant text is rendered as markdown', () => {
    renderApp();
    hydrateWithItems([{ id: '2', ts: 2, role: 'assistant', text: '```\ncode\n```' }]);

    assert.ok(document.querySelector('pre'));
    assert.ok(!document.body.textContent!.includes('```'));
  });

  test('long unbroken tokens wrap rather than clip', () => {
    renderApp();
    hydrateWithItems([{ id: '1', ts: 1, role: 'user', text: 'x'.repeat(400) }]);

    const el = screen.getByText('x'.repeat(400));
    assert.ok(
      el.className.includes('wrap-break-word'),
      'pre-wrap breaks at whitespace only, and the scroller has no horizontal axis',
    );
  });

  test('an error item is capped so a stack trace cannot blow out the pane', () => {
    renderApp();
    hydrateWithItems([{ id: '3', ts: 3, role: 'error', message: 'boom\n'.repeat(200) }]);

    const el = screen.getByText(/boom/);
    assert.ok(/max-h-\d/.test(el.className) || /max-h-\d/.test(el.parentElement!.className));
  });

  test('a sign-in error offers a login action for the session\'s provider', async () => {
    renderApp();
    hydrateWithItems(
      [{ id: '3', ts: 3, role: 'error', message: 'Not signed in to Claude. Run `claude auth login`.' }],
      { providerId: 'claude' },
    );

    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    assert.deepStrictEqual(posted().at(-1), { t: 'login-provider', providerId: 'claude' });
  });

  test('a sign-in error for a loginKind "none" provider offers no login action', () => {
    renderApp();
    hydrateWithItems(
      [{ id: '3', ts: 3, role: 'error', message: 'Not signed in to Claude. Run `claude auth login`.' }],
      { providerId: 'claude-work', catalog: [{ id: 'claude-work', displayName: 'Claude (work)', models: [], permissionModes: [], loginKind: 'none' }] },
    );
    assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
  });

  test('an error unrelated to sign-in offers no login action', () => {
    renderApp();
    hydrateWithItems([{ id: '3', ts: 3, role: 'error', message: 'control request failed' }]);

    assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
  });

  test('a switch item renders its precomputed sentence', () => {
    renderApp();
    hydrateWithItems([
      { id: '4', ts: 4, role: 'switch', kind: 'model', text: 'Switched model to Fake Small' },
    ]);

    screen.getByText('Switched model to Fake Small');
  });
});

suite('TranscriptItemView fork', () => {
  test('a user item offers Fork from here while the session is idle', () => {
    renderApp();
    hydrateWithItems([{ id: 'u1', ts: 1, role: 'user', text: 'hello' }]);

    assert.ok(screen.getByRole('button', { name: 'Fork from here' }));
  });

  test('clicking Fork from here asks the host to fork at that item', async () => {
    renderApp();
    hydrateWithItems([{ id: 'u1', ts: 1, role: 'user', text: 'hello' }]);

    await userEvent.click(screen.getByRole('button', { name: 'Fork from here' }));

    assert.deepStrictEqual(posted().at(-1), { t: 'fork-session', id: 'a', itemId: 'u1' });
  });

  test('no fork action while the session is mid-turn', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a', { status: 'running' })],
      layout: layoutOf('a'),
      snapshots: [snapshot('a', {
        status: 'running',
        items: [{ id: 'u1', ts: 1, role: 'user', text: 'hello' }],
      })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.strictEqual(screen.queryByRole('button', { name: 'Fork from here' }) === null, true);
  });

  test('a permission item offers no fork action — it is not conversation content', () => {
    renderApp();
    hydrateWithItems([{
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'pending',
    }]);

    assert.strictEqual(screen.queryByRole('button', { name: 'Fork from here' }) === null, true);
  });
});

suite('TranscriptItemView subagent routing', () => {
  const spawned = (children?: TranscriptItem[]): TranscriptItem => ({
    id: 't1', ts: 1, role: 'tool', toolId: 'task1',
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
    state: 'running', children,
  });

  test('a just-spawned subagent renders as a subagent card, not a tool card', () => {
    // The window where the jump-to affordance matters most: the Task is
    // running and has returned nothing, so `children` is still empty. Routing
    // on children alone made exactly this case look like a generic tool.
    renderWithStore(<TranscriptItemView item={spawned()} sessionId="a" />);

    screen.getByText('Subagent');
    assert.ok(
      screen.getByRole('button', { expanded: false }).textContent?.includes('Explore'),
      'and it is named by the agent type it spawned',
    );
  });

  test('a plain tool with no children is still a tool card', () => {
    renderWithStore(<TranscriptItemView item={{
      id: 'r1', ts: 1, role: 'tool', toolId: 'read1',
      tool: { kind: 'file-read', label: 'Read', path: 'a.ts' }, state: 'running',
    }} sessionId="a" />);

    assert.strictEqual(screen.queryByText('Subagent'), null);
  });
});

const WITH_CONTEXT: TranscriptItem = {
  id: 'u1', ts: 1, role: 'user', text: 'fix the send path',
  context: {
    path: 'src/host/agent-session.ts',
    languageId: 'typescript',
    selection: { ranges: [{ startLine: 60, endLine: 73, text: 'x' }], truncated: false },
  },
};

const PLAIN: TranscriptItem = { id: 'u2', ts: 2, role: 'user', text: 'plain' };

suite('TranscriptItemView user context', () => {
  test('a message sent without context shows no chip', () => {
    renderWithStore(<TranscriptItemView item={PLAIN} sessionId="a" />);
    assert.strictEqual(screen.queryByRole('button', { name: /agent-session/ }), null);
    assert.ok(screen.getByText('plain'));
  });

  test('a message sent with context shows the chip it carried', () => {
    renderWithStore(<TranscriptItemView item={WITH_CONTEXT} sessionId="a" />);
    assert.ok(screen.getByRole('button', { name: /agent-session\.ts:60-73/ }));
  });

  test('clicking the chip asks the host to reveal the first selected line', async () => {
    renderWithStore(<TranscriptItemView item={WITH_CONTEXT} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /agent-session\.ts:60-73/ }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'reveal-file', path: 'src/host/agent-session.ts', startLine: 60,
    });
  });

  test('a file-reference chip reveals the file with no line', async () => {
    const fileOnly: TranscriptItem = {
      id: 'u3', ts: 3, role: 'user', text: 'look',
      context: { path: 'src/a.ts', languageId: 'typescript' },
    };
    renderWithStore(<TranscriptItemView item={fileOnly} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /a\.ts/ }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'reveal-file', path: 'src/a.ts', startLine: undefined,
    });
  });
});

suite('TranscriptItemView from sender', () => {
  test('a message delivered by another session shows "Message from <name>" instead of "You"', () => {
    const delivered: TranscriptItem = {
      id: 'u1', ts: 1, role: 'user', text: 'do the thing',
      from: { sessionId: 'b', name: 'sender' },
    };
    renderWithStore(<TranscriptItemView item={delivered} sessionId="a" />);

    assert.ok(screen.getByText('Message from sender'));
    assert.strictEqual(screen.queryByText('You') === null, true);
  });

  test('a human-typed message still shows "You"', () => {
    renderWithStore(<TranscriptItemView item={PLAIN} sessionId="a" />);

    assert.ok(screen.getByText('You'));
  });
});
