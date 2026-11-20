import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubagentCard } from '@/components/subagent-card';
import { SubagentGroupCard } from '@/components/subagent-group-card';
import { StoreProvider } from '@/store';
import { posted, renderWithStore, resetHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

function child(id: string, name: string): TranscriptItem {
  return {
    id, ts: 2, role: 'tool', toolId: id,
    tool: { kind: 'other', label: name, raw: {} }, state: 'ok',
  };
}

function subagent(children: TranscriptItem[], over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
    state: 'running', children, ...over,
  } as ToolItem;
}

suite('SubagentCard', () => {
  setup(() => { resetHost(); });

  test('collapsed by default, and renders none of its children', async () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);

    const toggle = screen.getByRole('button', { expanded: false });
    assert.ok(toggle.textContent?.includes('Explore'), 'names the agent type, not "Task"');
    assert.ok(toggle.textContent?.includes('1 tool'));
    assert.strictEqual(screen.queryByText('Read'), null, 'no child is rendered while collapsed');
  });

  test('shows the model when the spawn call named one', () => {
    const item = subagent([], {
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore', model: 'opus' },
    });
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    const toggle = screen.getByRole('button', { expanded: false });
    assert.ok(toggle.textContent?.includes('opus'));
  });

  test('omits the model when the spawn call did not name one', () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);

    assert.strictEqual(screen.queryByText(/opus|sonnet|haiku/i), null);
  });

  test('expanding reveals the children through the shipped ToolCard', async () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    const panel = document.getElementById(screen.getByRole('button', { expanded: true }).getAttribute('aria-controls')!);
    assert.ok(panel);
    assert.ok(within(panel!).getByText('Read'));
  });

  test('caps the rendered children at ten and says so', async () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`, `Tool${i}`));
    renderWithStore(<SubagentCard item={subagent(children)} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    assert.ok(screen.getByText('showing last 10 of 25'));
    assert.ok(screen.getByText('Tool24'), 'the newest child is rendered');
    assert.strictEqual(screen.queryByText('Tool14'), null, 'the eleventh-from-last is not');
  });

  test('offers to open the full transcript once expanded, window or not', async () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`, `Tool${i}`));
    renderWithStore(<SubagentCard item={subagent(children)} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    assert.strictEqual(
      screen.getByRole('button', { name: /open full transcript/i }) !== null,
      true,
    );
  });

  test('still offers to open the full transcript when nothing is truncated', async () => {
    // Opening Fleet's read-only view is worth reaching for any subagent, not
    // just a long-running one — a short run (or one with no children at all)
    // must not lose its only route into that view.
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    assert.strictEqual(screen.queryByText(/showing last/i), null, 'nothing is truncated here');
    assert.strictEqual(
      screen.getByRole('button', { name: /open full transcript/i }) !== null,
      true,
    );
  });

  test('a pending permission child forces the card open and is announced', () => {
    const item = subagent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'pending',
    }]);
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    assert.ok(screen.getByRole('button', { expanded: true }), 'force-opened');
    assert.ok(screen.getByText('Needs you'));
  });

  test('a deliberate collapse sticks even while still blocked', async () => {
    const item = subagent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'pending',
    }]);
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    await userEvent.click(screen.getByRole('button', { expanded: true }));
    assert.ok(screen.getByRole('button', { expanded: false }), 'stays collapsed');
    assert.ok(screen.getByText('Needs you'), 'and keeps reporting the block');
  });

  test('collapsing an unblocked running card does not suppress a later force-open', async () => {
    const { rerender } = renderWithStore(
      <SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />,
    );

    // Open it, then collapse it again — deliberately, but while nothing is
    // blocked. This must not behave like collapsing a force-opened card.
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await userEvent.click(screen.getByRole('button', { expanded: true }));
    assert.ok(screen.getByRole('button', { expanded: false }));

    // A permission now arrives on the same subagent.
    const blocked = subagent([{
      id: 'p1', ts: 2, role: 'permission', requestId: 'r1',
      tool: { kind: 'command', label: 'Bash', command: 'ls' }, state: 'pending',
    }]);
    rerender(<StoreProvider><SubagentCard item={blocked} sessionId="s1" /></StoreProvider>);

    assert.ok(screen.getByRole('button', { expanded: true }), 'force-opened');
    assert.ok(screen.getByText('Needs you'));
  });

  test('the card has no scroll container of its own', async () => {
    const children = Array.from({ length: 25 }, (_, i) => child(`c${i}`, `Tool${i}`));
    const { container } = renderWithStore(
      <SubagentCard item={subagent(children)} sessionId="s1" />,
    );
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    for (const el of container.querySelectorAll('*')) {
      const cls = el.className;
      if (typeof cls !== 'string') { continue; }
      assert.ok(
        !/overflow-(y-|x-)?(auto|scroll)|max-h-/.test(cls),
        `nested scrolling would break the pane's MessageScroller: ${cls}`,
      );
    }
  });
});

suite('SubagentCard hosted child', () => {
  setup(() => { resetHost(); });

  const hosted = (sessionId?: string) => subagent([], {
    tool: { kind: 'subagent', label: 'Subagent', action: 'spawn', agent: 'claude-ab12', ...(sessionId ? { childSessionId: sessionId } : {}) },
  });
  /** A worker that started just now: not yet quiet, so its card stays collapsed until opened. */
  const live = (id: string): ToolItem => ({ ...hosted(id), ts: Date.now() }) as ToolItem;

  test('a hosted subagent offers to open it as its own session', async () => {
    renderWithStore(<SubagentCard item={live('s-child')} sessionId="s1" />);
    screen.getByRole('button', { name: 'More worker actions' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('menuitem', { name: /open as session/i }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'promote-subagent'), [{ t: 'promote-subagent', id: 's-child' }]);
  });

  test('a running hosted worker can be stopped from its card', async () => {
    renderWithStore(<SubagentCard item={live('s-child')} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop this worker' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'interrupt'), [{ t: 'interrupt', id: 's-child' }]);
  });

  test('a failed hosted worker opens itself and says what happened and why', async () => {
    const item = { ...live('s-child'), state: 'error', output: { kind: 'text', text: 'Agent has ended its turn before returning a response' } } as ToolItem;
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);
    // It opens itself: the reason is not behind a click.
    assert.ok(screen.getByText('Failed'));
    assert.ok(screen.getByText('Agent has ended its turn before returning a response'));
    assert.strictEqual(screen.queryByRole('button', { name: 'Stop this worker' }) === null, true);
  });

  test('a message typed into a hosted worker card goes to that worker session', async () => {
    renderWithStore(<SubagentCard item={live('s-child')} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Message' }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Message / }), 'use the other API{Enter}');
    assert.deepStrictEqual(posted().filter((m) => m.t === 'send'), [{ t: 'send', id: 's-child', text: 'use the other API' }]);
    assert.ok(screen.getByText('use the other API'));
  });

  test('a vendor subagent has no stop or message controls', async () => {
    renderWithStore(<SubagentCard item={hosted()} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    assert.strictEqual(screen.queryAllByRole('button', { name: 'Stop this worker' }).length, 0);
    assert.strictEqual(screen.queryAllByRole('textbox').length, 0);
  });

  test('a hosted worker waiting on a question reads as needing you and says what it asks', () => {
    const asking = {
      id: 'q1', ts: Date.now(), role: 'question', requestId: 'r1', blocking: true, state: 'pending',
      questions: [{ header: 'Scope', question: 'Which module first?', options: [] }],
    } as unknown as TranscriptItem;
    const item = { ...live('s-child'), children: [asking] } as ToolItem;
    renderWithStore(<SubagentCard item={item} sessionId="s1" />);

    assert.ok(screen.getByText('Needs you'));
    assert.ok(screen.getByText(/Which module first\?/));
    assert.strictEqual(screen.queryByRole('button', { name: 'Stop this worker' }) === null, true);
  });

  test('a vendor subagent has nothing to promote', async () => {
    renderWithStore(<SubagentCard item={hosted()} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    assert.strictEqual(screen.queryAllByRole('button', { name: /open as session/i }).length, 0);
  });
});

suite('SubagentGroupCard', () => {
  setup(() => { resetHost(); });

  const worker = (id: string, over: Partial<ToolItem>): ToolItem => ({
    ...subagent([], { id, tool: { kind: 'subagent', label: 'Subagent', action: 'spawn', agent: id, childSessionId: `c-${id}`, provider: 'claude' } }),
    ...over,
  }) as ToolItem;

  test('the team row is names and coloured dots only, and it opens itself on trouble', () => {
    const items = [
      worker('a', { state: 'running', ts: Date.now() }),
      worker('b', { state: 'error', output: { kind: 'text', text: 'boom' } }),
      worker('c', { state: 'ok' }),
    ];
    renderWithStore(<SubagentGroupCard items={items} sessionId="s1" />);

    const row = screen.getAllByRole('button', { expanded: true })[0];
    assert.strictEqual(row.textContent?.includes('3 workers'), true);
    assert.strictEqual(/Failed|Done|Running|Quiet/.test(row.textContent ?? ''), false);
    assert.ok(screen.getAllByTitle('b · failed').length > 0);
    assert.ok(screen.getAllByTitle('c · done').length > 0);
  });
});
