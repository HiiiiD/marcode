import * as assert from 'assert';
import { fireEvent, screen } from '@testing-library/react';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import type { SessionSummary } from '../../protocol/messages';
// The host's own composer, not a hand-written copy of its output: `composePrompt`
// and the webview's `splitComposed` have to agree character for character, and
// a convention that only lives in a test fixture is one nobody checks. The
// module has no `vscode` and no I/O, so it imports fine under jsdom.
import { composePrompt } from '../../host/session-refs';

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

  /**
   * The picking tests above type a trailing space before the second Enter,
   * which closes the menu through the whitespace rule in `mentionQuery` — so
   * they never exercise the state machine's own close. This one does: the
   * caret sits at the end of the freshly inserted token, so the query matches
   * again and the menu re-renders over the row just picked. Left open, the
   * next Enter re-enters the pick and attaches the SAME source twice.
   */
  test('Enter straight after a pick sends once, with one ref', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Do @refac' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1, 'the second Enter must send, not re-pick');
    const sent = sends[0] as { refs?: unknown[] };
    assert.strictEqual(sent.refs?.length, 1, 'the source must be attached once');
  });

  /**
   * An `@word` that matches nothing is ordinary prose — a name, a handle, a
   * npm scope. A menu that claims Enter with no row to insert makes the
   * message unsendable and says nothing about why.
   */
  test('a message ending in an unmatched @word still sends', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'please ping @notasession' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sends = posted().filter((m) => m.t === 'send');
    assert.strictEqual(sends.length, 1);
    assert.strictEqual((sends[0] as { text: string }).text, 'please ping @notasession');
  });

  test('focus leaving the box closes the ref menu', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@' } });
    assert.strictEqual(screen.queryByRole('listbox') === null, false);

    fireEvent.blur(box);

    assert.strictEqual(screen.queryByRole('listbox') === null, true);
    assert.strictEqual(box.getAttribute('aria-expanded'), 'false');
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

  test('the rows are grouped under the headings their source supplies', () => {
    renderApp();
    hydrateTwoSessions();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '@' } });

    // The heading is on screen and is NOT one of the addressable rows: three
    // options (one action, two kinds for the other session), no more.
    screen.getByText('Actions');
    screen.getByText('Sessions');
    assert.strictEqual(screen.getAllByRole('option').length, 3);
    // The visible heading is aria-hidden, so the name reaches assistive tech
    // through the group instead — static text is not a legal listbox child.
    screen.getByRole('group', { name: 'Actions' });
    screen.getByRole('group', { name: 'Sessions' });
  });

  /**
   * `aria-controls` has to resolve. Unmounting the listbox on an empty query
   * left the textarea pointing at an id that was not in the document, with
   * `aria-expanded="true"` beside it.
   */
  test('an unmatched query keeps the listbox mounted, saying No match', () => {
    renderApp();
    hydrateTwoSessions();

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: '@nothinglikethis' } });

    screen.getByText('No match');
    const controls = box.getAttribute('aria-controls');
    assert.strictEqual(typeof controls === 'string', true);
    assert.strictEqual(document.getElementById(controls!) === null, false);
    // Nothing addressable while there is nothing to insert.
    assert.strictEqual(box.getAttribute('aria-activedescendant'), null);
  });

  test('the listbox names itself, and each row carries its full label', () => {
    renderApp();
    hydrateTwoSessions();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '@' } });

    const list = screen.getByRole('listbox');
    assert.strictEqual((list.getAttribute('aria-label') ?? '').length > 0, true);
    const rows = screen.getAllByRole('option');
    assert.strictEqual(rows.every((r) => (r.getAttribute('title') ?? '').length > 0), true);
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

  test('a user item with refs shows only the prose, with the payload behind a chip', () => {
    renderApp();
    hydrateTwoSessions();

    sendFromHost({
      t: 'session-patch', id: 's-1',
      patch: {
        op: 'append',
        item: {
          id: 'u1', ts: 1, role: 'user',
          text: composePrompt('Do it', [
            { title: 'refactor store', kind: 'plan', text: 'step one' },
          ]),
          refs: [{ sessionId: 's-2', kind: 'plan', title: 'refactor store' }],
        },
      },
    });

    // Exact matcher: this only passes if the block was lifted OUT of the
    // prose. Un-split, the node's textContent is the whole composed string
    // and this throws. That is what makes the test discriminate.
    screen.getByText('Do it');

    // The chip is present and the payload is not, until it is opened.
    const chip = screen.getByText('plan from refactor store');
    assert.strictEqual(screen.queryByText('step one') === null, true);

    fireEvent.click(chip);
    screen.getByText('step one');
  });

  /**
   * Two references in one message is the configuration that surfaces a
   * heading-only React key (both headings read `plan from Untitled` while the
   * sessions are unnamed) and a substring-based prune. Nothing covered it.
   */
  test('a user item carrying two references renders both chips over clean prose', () => {
    renderApp();
    hydrateTwoSessions();

    sendFromHost({
      t: 'session-patch', id: 's-1',
      patch: {
        op: 'append',
        item: {
          id: 'u3', ts: 3, role: 'user',
          text: composePrompt('Merge these', [
            { title: 'refactor store', kind: 'plan', text: 'step one' },
            { title: 'agent one', kind: 'message', text: 'the reply' },
          ]),
          refs: [
            { sessionId: 's-2', kind: 'plan', title: 'refactor store' },
            { sessionId: 's-3', kind: 'message', title: 'agent one' },
          ],
        },
      },
    });

    screen.getByText('Merge these');
    const first = screen.getByText('plan from refactor store');
    const second = screen.getByText('message from agent one');
    assert.strictEqual(screen.queryByText('step one') === null, true);
    assert.strictEqual(screen.queryByText('the reply') === null, true);

    // Each chip opens its own payload — a collided React key lets one
    // block's open state reconcile onto the other's.
    fireEvent.click(first);
    screen.getByText('step one');
    assert.strictEqual(screen.queryByText('the reply') === null, true);
    fireEvent.click(second);
    screen.getByText('the reply');
    screen.getByText('step one');
  });

  test('a user item whose text lacks the expected block degrades to plain prose', () => {
    renderApp();
    hydrateTwoSessions();

    sendFromHost({
      t: 'session-patch', id: 's-1',
      patch: {
        op: 'append',
        item: {
          id: 'u2', ts: 2, role: 'user',
          text: 'Just prose, no block here',
          refs: [{ sessionId: 's-2', kind: 'plan', title: 'refactor store' }],
        },
      },
    });

    screen.getByText('Just prose, no block here');
    assert.strictEqual(screen.queryByText('plan from refactor store') === null, true);
  });
});
