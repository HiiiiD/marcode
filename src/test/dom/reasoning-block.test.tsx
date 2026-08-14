import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptItemView } from '@/components/transcript-item';
import { renderWithStore } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

const REASONING = 'Checking map-events for the block shape\nthen the host merge path';

function item(over: Partial<Extract<TranscriptItem, { role: 'assistant' }>> = {}): TranscriptItem {
  return { id: 'a1', ts: 1, role: 'assistant', text: 'The chain exists.', ...over };
}

suite('Reasoning disclosure', () => {
  test('an assistant item without thinking has no disclosure at all', () => {
    renderWithStore(<TranscriptItemView item={item()} sessionId="a" />);

    assert.strictEqual(screen.queryByRole('button', { name: /Reasoning/ }), null);
  });

  test('thinking starts collapsed — the body is not in the document', () => {
    renderWithStore(<TranscriptItemView item={item({ thinking: REASONING })} sessionId="a" />);

    const toggle = screen.getByRole('button', { name: /Reasoning/ });
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(screen.queryByText(/then the host merge path/), null);
  });

  test('the collapsed header previews the first line, so the row earns its space', () => {
    renderWithStore(<TranscriptItemView item={item({ thinking: REASONING })} sessionId="a" />);

    screen.getByText('Checking map-events for the block shape');
  });

  test('the preview skips leading blank lines rather than showing an empty row', () => {
    renderWithStore(
      <TranscriptItemView item={item({ thinking: '\n\n  Reading the SDK types' })} sessionId="a" />,
    );

    screen.getByText('Reading the SDK types');
  });

  test('clicking the header reveals the full reasoning', async () => {
    renderWithStore(<TranscriptItemView item={item({ thinking: REASONING })} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /Reasoning/ }));

    const toggle = screen.getByRole('button', { name: /Reasoning/ });
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText(/then the host merge path/));
  });

  test('the header controls the body it opens', async () => {
    renderWithStore(<TranscriptItemView item={item({ thinking: REASONING })} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /Reasoning/ }));

    const controls = screen.getByRole('button', { name: /Reasoning/ }).getAttribute('aria-controls');
    assert.ok(controls);
    assert.ok(document.getElementById(controls));
  });

  test('the opened body is capped so a long chain cannot bury the answer', async () => {
    const long = 'weighing the options\n'.repeat(200);
    renderWithStore(<TranscriptItemView item={item({ thinking: long })} sessionId="a" />);

    await userEvent.click(screen.getByRole('button', { name: /Reasoning/ }));

    const controls = screen.getByRole('button', { name: /Reasoning/ }).getAttribute('aria-controls')!;
    assert.ok(/max-h-\d/.test(document.getElementById(controls)!.className));
  });

  test('the answer still renders as markdown alongside the reasoning', () => {
    renderWithStore(
      <TranscriptItemView
        item={item({ thinking: REASONING, text: '```\ncode\n```' })}
        sessionId="a"
      />,
    );

    assert.ok(document.querySelector('pre'));
  });
});
