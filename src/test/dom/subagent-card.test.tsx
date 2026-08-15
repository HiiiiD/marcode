import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubagentCard } from '@/components/subagent-card';
import { StoreProvider } from '@/store';
import { renderWithStore, resetHost } from './harness';
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

  test('expanding reveals the children through the shipped ToolCard', async () => {
    renderWithStore(<SubagentCard item={subagent([child('c1', 'Read')])} sessionId="s1" />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    const panel = document.getElementById('subagent-task1');
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
    assert.strictEqual(
      screen.queryByRole('button', { name: /show all/i }), null,
      'no overflow control',
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
