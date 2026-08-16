import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as assert from 'assert';
import type { Attachment } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';

const NO_EFFORT = catalog()[0].models[1];

function pane(attachments: Attachment[] = []): PaneState {
  return {
    summary: summary('a'), items: [], hasMore: false, pending: [],
    mcpServers: [], attachments,
  };
}

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1', path: '/tmp/shot.png', name: 'shot.png',
    kind: 'image', mediaType: 'image/png', bytes: 2048, ...over,
  };
}

suite('Attachment chips', () => {
  test('a session-attachments message renders one chip per attachment', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [snapshot('a')],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });
    sendFromHost({
      t: 'session-attachments', id: 'a',
      attachments: [att(), att({ id: 'a2', name: 'notes.md', kind: 'file' })],
    });

    assert.strictEqual(screen.getAllByRole('listitem').length >= 2, true);
    assert.strictEqual(screen.getByText('shot.png') !== null, true);
    assert.strictEqual(screen.getByText('notes.md') !== null, true);
  });

  test('removing a chip posts attach-remove', async () => {
    renderWithStore(<Composer pane={pane([att()])} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByRole('button', { name: /remove shot\.png/i }));

    assert.deepStrictEqual(posted().at(-1), { t: 'attach-remove', id: 'a', attachmentId: 'a1' });
  });

  test('no attachments renders no strip', () => {
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    assert.strictEqual(container.querySelector('[data-testid="attachment-chips"]') === null, true);
  });

  test('a rejection renders its reason', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({
      t: 'attachments-rejected', id: 'a', reason: 'Attachments are limited to 10 MB.',
    });

    assert.strictEqual(screen.getByText('Attachments are limited to 10 MB.') !== null, true);
  });
});
