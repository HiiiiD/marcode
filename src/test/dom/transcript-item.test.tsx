import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptItemView } from '@/components/transcript-item';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

function hydrateWithItems(items: TranscriptItem[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { items })],
    catalog: catalog(),
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
