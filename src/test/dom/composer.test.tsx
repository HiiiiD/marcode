import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import type { SessionStatus } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import {
  posted, renderApp, renderWithStore, sendFromHost,
} from './harness';

function pane(status: SessionStatus = 'idle'): PaneState {
  return { summary: summary('a', { status }), items: [], hasMore: false, pending: [] };
}

const WITH_EFFORT = catalog()[0].models[0];   // fake-large, effort low/medium/high
const NO_EFFORT = catalog()[0].models[1];     // fake-small

/** One session in the roster, in its own pane, with the effort-capable model. */
function hydrateOne() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });
}

suite('Composer', () => {
  test('Enter posts send and clears the textarea', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, 'hello{Enter}');

    assert.deepStrictEqual(posted().at(-1), { t: 'send', id: 'a', text: 'hello' });
    assert.strictEqual(box.value, '');
  });

  test('Shift+Enter inserts a newline and posts nothing', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, 'one{Shift>}{Enter}{/Shift}two');

    assert.deepStrictEqual(posted().at(-1), { t: 'ready' });
    assert.strictEqual(box.value, 'one\ntwo');
  });

  test('whitespace-only input leaves Send disabled and posts nothing', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '   ');

    assert.strictEqual((screen.getByText('Send') as HTMLButtonElement).disabled, true);
    await userEvent.type(box, '{Enter}');
    assert.deepStrictEqual(posted().at(-1), { t: 'ready' });
  });

  test('a running session shows Send disabled and Stop beside it; Stop posts interrupt', async () => {
    renderWithStore(<Composer pane={pane('running')} model={NO_EFFORT} />);

    assert.strictEqual((screen.getByText('Send') as HTMLButtonElement).disabled, true);
    await userEvent.click(screen.getByText('Stop'));

    assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
  });

  test('awaiting-approval also shows Stop', () => {
    renderWithStore(<Composer pane={pane('awaiting-approval')} model={NO_EFFORT} />);
    screen.getByText('Stop');
  });

  test('a model without effort renders no Effort control', () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);
    assert.strictEqual(screen.queryByLabelText('Effort'), null);
  });

  test('choosing an effort level posts set-effort', async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} />);

    await userEvent.click(screen.getByLabelText('Effort'));
    await userEvent.click(await screen.findByRole('option', { name: 'high' }));

    assert.deepStrictEqual(posted().at(-1), { t: 'set-effort', id: 'a', effort: 'high' });
  });

  test('the effort and mode selects use the sm size variant, not a hand-written height', () => {
    renderApp();
    hydrateOne();

    for (const label of ['Effort', 'Permission mode']) {
      const trigger = screen.getByLabelText(label);
      assert.strictEqual(
        trigger.getAttribute('data-size'), 'sm',
        `${label} must set size="sm"; a hand-written h-7 loses to data-[size=default]:h-8`,
      );
      // Not \bh-\d: SelectTrigger's own base classes always carry both
      // `data-[size=default]:h-8` and `data-[size=sm]:h-7` as compound,
      // variant-qualified tokens (CSS picks the active one via the
      // data-size attribute) — a bare \b boundary matches "h-8"/"h-7"
      // inside those regardless of what we authored. A hand-written height
      // is always a space-separated, unqualified token instead.
      assert.ok(
        !/(?:^|\s)h-\d/.test(trigger.className),
        `${label} must not hand-write a height over the size variant`,
      );
    }
  });

  test('Send sits inside the input group, after the settings', () => {
    renderApp();
    hydrateOne();

    const group = screen.getByLabelText('Message').closest('[data-slot="input-group"]');
    assert.ok(group, 'the textarea must live inside an InputGroup');

    const send = screen.getByRole('button', { name: 'Send' });
    assert.ok(group!.contains(send), 'Send must live inside the group, not in a row below it');

    const mode = screen.getByLabelText('Permission mode');
    assert.ok(
      mode.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
      'settings come first, the action comes last',
    );
  });

  test('Send stays visible but disabled while the agent runs, with Stop beside it', () => {
    renderApp();
    hydrateOne();
    sendFromHost({ t: 'session-status', id: 'a', status: 'running' });

    const send = screen.getByRole('button', { name: 'Send' });
    assert.ok((send as HTMLButtonElement).disabled, 'Send is disabled, not removed, during a run');
    assert.strictEqual(
      send.getAttribute('title'),
      'The agent is working. Stop it to send another message.',
    );
    screen.getByRole('button', { name: 'Stop' });
  });

  test('Stop still posts interrupt', async () => {
    renderApp();
    hydrateOne();
    sendFromHost({ t: 'session-status', id: 'a', status: 'running' });

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
  });
});
