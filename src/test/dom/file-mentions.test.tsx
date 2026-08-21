import * as assert from 'assert';
import { fireEvent, screen } from '@testing-library/react';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import type { ProviderInfo, SessionSummary } from '../../protocol/messages';
import { composePrompt } from '../../host/session-refs';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

const CATALOG: ProviderInfo[] = [{
  id: 'fake', displayName: 'Fake',
  models: [{ id: 'm', displayName: 'M' }],
  permissionModes: [{ id: 'default' }],
}];

function hydrateOneSession(): SessionSummary {
  const a = summary('s-1', 'agent one');
  sendFromHost({
    t: 'hydrate',
    sessions: [a],
    layout: { orientation: 'vertical', panes: [{ sessionId: 's-1', size: 1 }] },
    snapshots: [{
      ...a, items: [], hasMore: false, pending: [], pendingQuestions: [], mcpServers: [],
      pendingAttachments: [],
    }],
    catalog: CATALOG,
    unavailable: [],
    usage: {},
  });
  return a;
}

function messageBox(): HTMLElement {
  return screen.getAllByLabelText('Message')[0];
}

/** Waits past the composer's file-search debounce. */
async function pastDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

suite('file mentions in the composer', () => {
  setup(() => resetHost());

  test('typing @ with a query debounces a file-search to the host', async () => {
    renderApp();
    hydrateOneSession();

    fireEvent.change(messageBox(), { target: { value: 'Look at @comp' } });
    await pastDebounce();

    const searches = posted().filter((m) => m.t === 'file-search');
    assert.strictEqual(searches.length, 1);
    assert.strictEqual((searches[0] as { query: string }).query, 'comp');
  });

  test('a matching file-search-result renders under a Files heading', async () => {
    renderApp();
    hydrateOneSession();

    fireEvent.change(messageBox(), { target: { value: 'Look at @comp' } });
    await pastDebounce();

    sendFromHost({
      t: 'file-search-result', id: 's-1', query: 'comp',
      files: [{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }],
    });

    screen.getByText('Files');
    screen.getByText('composer.tsx');
  });

  /** A response for a query the user has since typed past must not render. */
  test('a stale file-search-result for an old query is ignored', async () => {
    renderApp();
    hydrateOneSession();

    fireEvent.change(messageBox(), { target: { value: 'Look at @comp' } });
    await pastDebounce();
    fireEvent.change(messageBox(), { target: { value: 'Look at @composer now more' } });

    sendFromHost({
      t: 'file-search-result', id: 's-1', query: 'comp',
      files: [{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }],
    });

    assert.strictEqual(screen.queryByText('composer.tsx') === null, true);
  });

  test('picking a file keeps the token mid-sentence and sends fileRefs', async () => {
    renderApp();
    hydrateOneSession();

    const box = messageBox();
    fireEvent.change(box, { target: { value: 'Look at @comp' } });
    await pastDebounce();
    sendFromHost({
      t: 'file-search-result', id: 's-1', query: 'comp',
      files: [{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }],
    });
    fireEvent.keyDown(box, { key: 'Enter' });

    // The token stays in the box, unlike an attachment chip — the whole
    // point of matching session-ref behaviour.
    assert.strictEqual(
      (box as HTMLTextAreaElement).value, 'Look at @src/webview/composer.tsx',
    );

    fireEvent.change(box, { target: { value: `${(box as HTMLTextAreaElement).value} please` } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1);
    const sent = sends[0] as { text: string; fileRefs?: { path: string; name: string }[] };
    assert.strictEqual(sent.fileRefs?.length, 1);
    assert.strictEqual(sent.fileRefs?.[0].path, 'src/webview/composer.tsx');
    assert.strictEqual(sent.text.includes('@src/webview/composer.tsx'), true);
  });

  test('deleting the token drops the file ref, same as a session ref', async () => {
    renderApp();
    hydrateOneSession();

    const box = messageBox();
    fireEvent.change(box, { target: { value: 'Look at @comp' } });
    await pastDebounce();
    sendFromHost({
      t: 'file-search-result', id: 's-1', query: 'comp',
      files: [{ path: 'src/webview/composer.tsx', name: 'composer.tsx' }],
    });
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.change(box, { target: { value: 'Do it myself' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    const sent = sends[0] as { fileRefs?: unknown[] };
    assert.strictEqual(sent.fileRefs, undefined);
  });

  test('a user item with a file ref shows only the prose, with the file behind a chip', () => {
    renderApp();
    hydrateOneSession();

    sendFromHost({
      t: 'session-patch', id: 's-1',
      patch: {
        op: 'append',
        item: {
          id: 'u1', ts: 1, role: 'user',
          text: composePrompt('Look at @src/a.ts please', [
            { title: 'src/a.ts', kind: 'file', text: 'export const x = 1;' },
          ]),
          fileRefs: [{ path: 'src/a.ts', name: 'a.ts' }],
        },
      },
    });

    screen.getByText('Look at @src/a.ts please');
    const chip = screen.getByText('file from src/a.ts');
    assert.strictEqual(screen.queryByText('export const x = 1;') === null, true);

    fireEvent.click(chip);
    screen.getByText('export const x = 1;');
  });
});
