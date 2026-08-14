import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextRing } from '@/components/context-ring';
import type { PaneState } from '@/reducer';
import { breakdown, summary } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

function pane(contextPercent?: number): PaneState {
  return {
    summary: summary('a', { contextPercent }),
    items: [], hasMore: false, pending: [],
  };
}

suite('ContextRing', () => {
  setup(() => { resetHost(); });

  test('labels the ring with the percentage in use', () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    assert.ok(screen.getByLabelText('Context 43% used'));
  });

  test('labels the ring as unavailable when nothing was reported', () => {
    renderWithStore(<ContextRing pane={pane()} />);
    assert.ok(screen.getByLabelText('Context usage unavailable'));
  });

  test('opening the popover requests the breakdown for that session', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);

    await userEvent.click(screen.getByLabelText('Context 43% used'));

    assert.deepStrictEqual(posted().at(-1), { t: 'request-context', id: 'a' });
  });

  test('renders the slices and memory files once the reply arrives', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    await userEvent.click(screen.getByLabelText('Context 43% used'));

    sendFromHost({
      t: 'context-breakdown', id: 'a', result: { ok: true, breakdown: breakdown() },
    });

    assert.ok(screen.getByText('System prompt'));
    assert.ok(screen.getByText('57%'));
    assert.ok(screen.getByRole('button', { name: /CLAUDE\.md/ }));
  });

  test('a sub-one-percent memory file reads as <1%, never 0%', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    await userEvent.click(screen.getByLabelText('Context 43% used'));

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: {
        ok: true,
        breakdown: breakdown({ memoryFiles: [{ path: '/repo/AGENTS.md', percent: 0 }] }),
      },
    });

    assert.ok(screen.getByText('<1%'));
  });

  test('an empty memory list says so rather than showing a lone row', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    await userEvent.click(screen.getByLabelText('Context 43% used'));

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: { ok: true, breakdown: breakdown({ memoryPercent: 0, memoryFiles: [] }) },
    });

    assert.ok(screen.getByText('No memory files loaded'));
  });

  test('clicking a memory file asks the host to open it', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    await userEvent.click(screen.getByLabelText('Context 43% used'));
    sendFromHost({
      t: 'context-breakdown', id: 'a', result: { ok: true, breakdown: breakdown() },
    });

    await userEvent.click(screen.getByRole('button', { name: /CLAUDE\.md/ }));

    assert.deepStrictEqual(posted().at(-1), { t: 'open-file', path: '/repo/CLAUDE.md' });
  });

  test('a not-ok reply shows its reason', async () => {
    renderWithStore(<ContextRing pane={pane(43)} />);
    await userEvent.click(screen.getByLabelText('Context 43% used'));

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: { ok: false, reason: 'This session is not running' },
    });

    assert.ok(screen.getByText('This session is not running'));
  });
});
