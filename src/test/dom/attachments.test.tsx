import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import { act, screen, waitFor } from '@testing-library/react';
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

  /**
   * `window.Event`, not the ambient `Event`: the suite's jsdom lives in its own
   * realm, so a globally-constructed event fails jsdom's own brand check on
   * dispatch. Paste and drop carry their payload on the native event, which is
   * why these are dispatched rather than driven through userEvent.
   */
  function fire(target: EventTarget, type: string, props: Record<string, unknown>) {
    target.dispatchEvent(Object.assign(
      new window.Event(type, { bubbles: true, cancelable: true }),
      props,
    ));
  }

  test('the paperclip posts attach-pick', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    assert.deepStrictEqual(posted().at(-1), { t: 'attach-pick', id: 'a' });
  });

  test('pasting an image posts attach-paste with its bytes', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText('Message');
    const file = new window.File(
      [String.fromCharCode(1, 2, 3, 4)], 'image.png', { type: 'image/png' },
    );
    const clipboardData = { files: [file] } as unknown as DataTransfer;

    act(() => { fire(box, 'paste', { clipboardData }); });
    await waitFor(() => {
      assert.strictEqual(posted().at(-1)?.t, 'attach-paste');
    });

    const msg = posted().at(-1) as Extract<ReturnType<typeof posted>[number], { t: 'attach-paste' }>;
    assert.strictEqual(msg.t, 'attach-paste');
    assert.strictEqual(msg.id, 'a');
    assert.strictEqual(msg.mediaType, 'image/png');
    assert.strictEqual(msg.base64, 'AQIDBA==');
  });

  test('pasting plain text does not attach anything', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText('Message');
    const before = posted().length;

    act(() => { fire(box, 'paste', { clipboardData: { files: [] } }); });

    assert.strictEqual(posted().length, before);
  });

  test('dropping files posts attach-drop with their uris', async () => {
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const zone = container.querySelector('[data-testid="composer-drop"]') as HTMLElement;
    const dataTransfer = {
      files: [],
      getData: (type: string) => type === 'text/uri-list'
        ? 'file:///tmp/a.png\r\nfile:///tmp/b.md'
        : '',
    } as unknown as DataTransfer;

    await act(async () => { fire(zone, 'drop', { dataTransfer }); });

    assert.deepStrictEqual(posted().at(-1), {
      t: 'attach-drop', id: 'a', uris: ['file:///tmp/a.png', 'file:///tmp/b.md'],
    });
  });

  test('a sent user message lists what it carried', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [{
        ...snapshot('a'),
        items: [{
          id: 'u1', ts: 1, role: 'user', text: 'look at this',
          attachments: [att({ name: 'carried.png' })],
        }],
      }],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.strictEqual(screen.getByText('carried.png') !== null, true);
  });

  test('a sent message offers no way to un-attach — it is a record, not a draft', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [{
        ...snapshot('a'),
        items: [{
          id: 'u1', ts: 1, role: 'user', text: 'look at this',
          attachments: [att({ name: 'carried.png' })],
        }],
      }],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.strictEqual(screen.queryAllByRole('button', { name: /remove carried\.png/i }).length, 0);
  });
});
