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
    mcpServers: [], pendingQuestions: [], attachments,
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
      t: 'attachments-rejected', id: 'a', reasons: ['Attachments are limited to 10 MB.'],
    });

    // Two copies by design: the announced region and the visible line.
    assert.strictEqual(screen.getAllByText('Attachments are limited to 10 MB.').length, 2);
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

  test('a pasted image previews from the store, composed onto the host base', () => {
    // The host writes this attribute on #root; nothing else in the webview
    // ever learns a disk path.
    const root = document.createElement('div');
    root.id = 'root';
    root.dataset.attachmentBase = 'https://file+.vscode-resource/attachments';
    document.body.appendChild(root);

    try {
      renderWithStore(
        <Composer
          pane={pane([att({ storeRelative: 's1/a1.png' })])}
          model={NO_EFFORT}
          models={[]}
        />,
      );

      const image = screen.getByRole('img', { name: 'shot.png' }) as HTMLImageElement;
      assert.strictEqual(
        image.getAttribute('src'),
        'https://file+.vscode-resource/attachments/s1/a1.png',
      );
    } finally {
      root.remove();
    }
  });

  test('an image with no store-relative path keeps the icon', () => {
    renderWithStore(
      <Composer pane={pane([att()])} model={NO_EFFORT} models={[]} />,
    );

    // An adopted image was never copied into the store, so there is nothing a
    // webview may load — the chip must not render a broken image.
    assert.strictEqual(screen.queryByRole('img') === null, true);
    assert.strictEqual(screen.getByText('shot.png') !== null, true);
  });

  test('a non-image with a store-relative path is never previewed', () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.dataset.attachmentBase = 'https://file+.vscode-resource/attachments';
    document.body.appendChild(root);

    try {
      renderWithStore(
        <Composer
          pane={pane([att({ kind: 'file', name: 'notes.md', storeRelative: 's1/a2.md' })])}
          model={NO_EFFORT}
          models={[]}
        />,
      );

      assert.strictEqual(screen.queryByRole('img') === null, true);
    } finally {
      root.remove();
    }
  });

  test('every refused file gets its own line, naming the file and the constraint', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({
      t: 'attachments-rejected', id: 'a',
      reasons: ['a-folder — that is a folder', 'huge.bin — too large (14.0 MB of 10 MB)'],
    });

    assert.strictEqual(screen.getAllByText('a-folder — that is a folder').length, 2);
    assert.strictEqual(screen.getAllByText('huge.bin — too large (14.0 MB of 10 MB)').length, 2);
  });

  test('the live region is mounted before there is anything to say', () => {
    // A region created with its text already inside it announces nothing —
    // the same reasoning status-badge.tsx documents. It has to be mounted
    // ahead of the failure so only its content changes.
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);

    assert.strictEqual(container.querySelector('[role="status"]') === null, false);
    assert.strictEqual(container.querySelector('[role="status"]')?.textContent, '');
  });

  test('a rejection changes the mounted region\'s text rather than creating one', () => {
    const { container } = renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const before = container.querySelector('[role="status"]');
    sendFromHost({ t: 'attachments-rejected', id: 'a', reasons: ['shot.png — could not be read'] });

    const after = container.querySelector('[role="status"]');
    assert.strictEqual(before === after, true);
    assert.strictEqual(after?.textContent?.includes('shot.png — could not be read'), true);
  });

  test('the rejection can be dismissed without attaching something else', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({ t: 'attachments-rejected', id: 'a', reasons: ['shot.png — could not be read'] });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss attachment errors' }));

    assert.strictEqual(screen.queryAllByText('shot.png — could not be read').length, 0);
  });

  test('a clipboard entry the webview cannot read is reported to the host', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText('Message');
    // A File whose bytes cannot be read: FileReader rejects, so no attach-paste
    // can ever be posted, and silence would be the only other option.
    const unreadable = { name: 'broken.png', type: 'image/png' } as unknown as File;

    act(() => { fire(box, 'paste', { clipboardData: { files: [unreadable] } }); });
    await waitFor(() => {
      assert.strictEqual(posted().at(-1)?.t, 'attach-failed');
    });

    assert.deepStrictEqual(posted().at(-1), { t: 'attach-failed', id: 'a', name: 'broken.png' });
  });

  test('a queued message shows the files parked with it', () => {
    const queuedPane = pane();
    queuedPane.summary = {
      ...queuedPane.summary,
      queued: [{ id: 'q1', text: 'look at this', attachments: [att({ name: 'parked.png' })] }],
    };

    renderWithStore(<Composer pane={queuedPane} model={NO_EFFORT} models={[]} />);

    // Cancelling a queued message discards its attachments too, so the row
    // has to say what it is holding before the user decides.
    assert.strictEqual(screen.getByText('parked.png') !== null, true);
  });

  test('a queued message offers no way to un-attach what it parked', () => {
    const queuedPane = pane();
    queuedPane.summary = {
      ...queuedPane.summary,
      queued: [{ id: 'q1', text: 'look at this', attachments: [att({ name: 'parked.png' })] }],
    };

    renderWithStore(<Composer pane={queuedPane} model={NO_EFFORT} models={[]} />);

    // The whole message is cancelled or it is not; there is no wire message
    // for editing a parked one.
    assert.strictEqual(screen.queryAllByRole('button', { name: /remove parked\.png/i }).length, 0);
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
