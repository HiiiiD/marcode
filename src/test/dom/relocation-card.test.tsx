import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RelocationCard } from '@/components/relocation-card';
import type { SessionStatus, TranscriptItem } from '../../protocol/messages';
import { catalog, layoutOf, relocation, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';

function hydrateWith(items: TranscriptItem[], status: SessionStatus = 'idle') {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { status })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { items, status })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('RelocationCard', () => {
  test('offers the move when pending', () => {
    renderWithStore(<RelocationCard item={relocation()} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('feat-x');
    assert.strictEqual(
      (screen.getByLabelText('Move this session to feat-x') as HTMLButtonElement).disabled,
      false,
    );
  });

  test('clicking Move posts answer-relocation with move true', async () => {
    renderWithStore(<RelocationCard item={relocation()} sessionId="a" />);
    hydrateWith([]);

    await userEvent.click(screen.getByLabelText('Move this session to feat-x'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'answer-relocation', id: 'a', itemId: 'r1', move: true,
    });
  });

  test('clicking Stay posts answer-relocation with move false', async () => {
    renderWithStore(<RelocationCard item={relocation()} sessionId="a" />);
    hydrateWith([]);

    await userEvent.click(screen.getByLabelText('Stay in the current directory'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'answer-relocation', id: 'a', itemId: 'r1', move: false,
    });
  });

  test('the move stays offered while the session is running', async () => {
    renderWithStore(<RelocationCard item={relocation()} sessionId="a" />);
    hydrateWith([]);
    sendFromHost({ t: 'session-status', id: 'a', status: 'running' });

    // The offer is raised mid-turn in the common case, so a card that gated
    // Move on idle would arrive dead. The host queues the move instead.
    assert.strictEqual(
      (screen.getByLabelText('Move this session to feat-x') as HTMLButtonElement).disabled,
      false,
    );
    assert.strictEqual(
      (screen.getByLabelText('Stay in the current directory') as HTMLButtonElement).disabled,
      false,
    );

    await userEvent.click(screen.getByLabelText('Move this session to feat-x'));
    assert.deepStrictEqual(posted().at(-1), {
      t: 'answer-relocation', id: 'a', itemId: 'r1', move: true,
    });
  });

  test('answering disables both buttons with no host round-trip', async () => {
    renderWithStore(<RelocationCard item={relocation()} sessionId="a" />);
    hydrateWith([]);

    await userEvent.click(screen.getByLabelText('Move this session to feat-x'));
    const after = posted().length;

    assert.strictEqual(
      (screen.getByLabelText('Move this session to feat-x') as HTMLButtonElement).disabled,
      true,
    );
    await userEvent.click(screen.getByLabelText('Move this session to feat-x'));
    assert.strictEqual(posted().length, after, 'a second click must post nothing');
  });

  test('a moved item renders its outcome with no buttons', () => {
    renderWithStore(<RelocationCard item={relocation({ state: 'moved' })} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Moved to feat-x');
    assert.strictEqual(screen.queryByLabelText('Move this session to feat-x') === null, true);
    assert.strictEqual(screen.queryByLabelText('Stay in the current directory') === null, true);
  });

  test('a declined item renders as stayed', () => {
    renderWithStore(<RelocationCard item={relocation({ state: 'stayed' })} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Stayed');
  });

  test('a queued item names its destination and offers no second answer', () => {
    renderWithStore(<RelocationCard item={relocation({ state: 'queued' })} sessionId="a" />);
    hydrateWith([]);

    // Settled-but-live: the question is answered, so the two answer buttons
    // are gone, but the row still says what is about to happen and when.
    screen.getByText('Moving to feat-x when this turn ends');
    assert.strictEqual(screen.queryByLabelText('Move this session to feat-x') === null, true);
    assert.strictEqual(screen.queryByLabelText('Stay in the current directory') === null, true);
    assert.strictEqual(
      (screen.getByLabelText('Cancel the queued move to feat-x') as HTMLButtonElement).disabled,
      false,
    );
  });

  test('cancelling a queued move posts cancel-relocation', async () => {
    renderWithStore(
      <RelocationCard item={relocation({ id: 'r7', state: 'queued' })} sessionId="a" />);
    hydrateWith([]);

    await userEvent.click(screen.getByLabelText('Cancel the queued move to feat-x'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'cancel-relocation', id: 'a', itemId: 'r7',
    });
  });

  test('the transcript renders a queued item through the card', () => {
    renderApp();
    hydrateWith([relocation({ state: 'queued' })]);

    screen.getByLabelText('Cancel the queued move to feat-x');
  });

  test('the transcript renders a relocation item through the card', () => {
    renderApp();
    hydrateWith([relocation()]);

    screen.getByText('feat-x');
    screen.getByLabelText('Move this session to feat-x');
  });
});
