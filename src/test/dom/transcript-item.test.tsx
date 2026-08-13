import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';
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
