import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { MessageScrollerProvider } from '@/components/ui/message-scroller';
import { SubagentTranscript } from '@/components/subagent-transcript';
import { renderWithStore, resetHost } from './harness';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

suite('SubagentTranscript', () => {
  setup(() => { resetHost(); });

  test('shows a visible session title and the model, and offers no dead fork', () => {
    const children: TranscriptItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, ts: i + 1, role: 'tool', toolId: `c${i}`,
      tool: { kind: 'other', label: `Tool${i}`, raw: {} }, state: 'ok',
    }));
    const subagentItem: ToolItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore', model: 'opus' },
      state: 'ok', children,
    };

    renderWithStore(
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <SubagentTranscript
          item={subagentItem}
          sessionId={'a' as SessionId}
          title="My Session"
          onBack={() => {}}
        />
      </MessageScrollerProvider>,
    );

    // The session title is visible text, not only an aria-label.
    assert.strictEqual(screen.getByText('My Session') !== undefined, true);
    // The model rides along on the "Subagent: …" line.
    assert.strictEqual(screen.getByText(/subagent:.*explore.*opus/i) !== undefined, true);
    // No child offers a fork: subagent children aren't top-level JSONL
    // items, so TranscriptStore.upTo() can never find one and the control
    // would silently do nothing. (Idle-session TranscriptItemView would
    // offer "Fork from here" on every top-level 'tool' item if these
    // children were ever routed through it — exactly the bug this must not
    // reintroduce.)
    assert.strictEqual(screen.queryAllByRole('button', { name: /fork from here/i }).length, 0);
  });

  test('unwindowed: renders every child, not just the last ten', () => {
    const children: TranscriptItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, ts: i + 1, role: 'tool', toolId: `c${i}`,
      tool: { kind: 'other', label: `Tool${i}`, raw: {} }, state: 'ok',
    }));
    const subagentItem: ToolItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      state: 'ok', children,
    };

    renderWithStore(
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <SubagentTranscript
          item={subagentItem}
          sessionId={'a' as SessionId}
          title="My Session"
          onBack={() => {}}
        />
      </MessageScrollerProvider>,
    );

    assert.strictEqual(screen.getByText('Tool0') !== undefined, true, 'the oldest child is present');
    assert.strictEqual(screen.getByText('Tool24') !== undefined, true, 'the newest child is present');
  });
});
