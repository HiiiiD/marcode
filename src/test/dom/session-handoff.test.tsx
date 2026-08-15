import * as assert from 'assert';
import { fireEvent, screen } from '@testing-library/react';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

function hydrateTwoSessions(): void {
  const a = summary('s-1', 'agent one');
  const b = summary('s-2', 'refactor store');
  sendFromHost({
    t: 'hydrate',
    sessions: [a, b],
    layout: { orientation: 'vertical', panes: [{ sessionId: 's-1', size: 1 }] },
    snapshots: [{ ...a, items: [], hasMore: false, pending: [], mcpServers: [] }],
    catalog: [{
      id: 'fake', displayName: 'Fake',
      models: [{ id: 'm', displayName: 'M' }],
      permissionModes: [{ id: 'default' }],
    }],
    unavailable: [],
    usage: {},
  });
}

suite('session handoff', () => {
  setup(() => resetHost());

  test('typing @ opens the menu with the other session', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@' } });

    assert.strictEqual(screen.getAllByText('refactor store').length > 0, true);
    assert.strictEqual(screen.getAllByText('handoff').length, 1);
  });

  test('picking a session inserts a token and sends refs with the message', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.change(box, { target: { value: `${(box as HTMLTextAreaElement).value} now` } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1);
    const sent = sends[0] as { text: string; refs?: { sessionId: string; kind: string }[] };
    assert.strictEqual(sent.refs?.length, 1);
    assert.strictEqual(sent.refs?.[0].sessionId, 's-2');
    assert.strictEqual(sent.text.includes('@refactor-store:'), true);
  });

  test('deleting the token drops the ref', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'Do it myself' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    const sent = sends[0] as { refs?: unknown[] };
    assert.strictEqual(sent.refs, undefined);
  });

  test('the composer announces the ref menu to assistive tech', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    assert.strictEqual(box.getAttribute('aria-expanded'), 'false');

    fireEvent.change(box, { target: { value: '@' } });

    assert.strictEqual(box.getAttribute('aria-expanded'), 'true');
    const controls = box.getAttribute('aria-controls');
    assert.strictEqual(typeof controls === 'string' && controls.length > 0, true);
    const active = box.getAttribute('aria-activedescendant');
    assert.strictEqual(typeof active === 'string' && active.startsWith(controls!), true);
  });

  test('picking handoff opens the create dialog and posts a seed', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@hand' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const seed = screen.getByLabelText('First message');
    fireEvent.change(seed, { target: { value: 'Execute the plan in docs/x.md' } });
    fireEvent.click(screen.getByText('Create and send'));

    const creates = posted().filter((m) => m.t === 'create-session');
    assert.strictEqual(creates.length, 1);
    const sent = creates[0] as { seed?: { text: string; refs: unknown[] } };
    assert.strictEqual(sent.seed?.text, 'Execute the plan in docs/x.md');
    assert.strictEqual(sent.seed?.refs.length, 0);
  });

  test('the handoff dialog inherits the source session provider and model', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@hand' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('Create and send'));

    const creates = posted().filter((m) => m.t === 'create-session');
    const sent = creates[0] as { providerId: string; model: string };
    assert.strictEqual(sent.providerId, 'fake');
    assert.strictEqual(sent.model, 'm');
  });
});
