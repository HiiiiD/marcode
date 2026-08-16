import * as assert from 'assert';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionCard } from '@/components/question-card';
import type { QuestionRequest, QuestionSpec } from '../../protocol/messages';
import { catalog, layoutOf, question, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';

function hydrateWith(pendingQuestions: QuestionRequest[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { pendingQuestions })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { pendingQuestions })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

function q(id: string): QuestionSpec {
  return {
    id, header: 'H', question: `${id}?`, multiSelect: false, allowOther: false, secret: false,
    options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
  };
}

const LIVE: QuestionRequest[] = [
  { requestId: 'r1', blocking: true, questions: question().questions },
];

suite('QuestionCard', () => {
  test('a single question renders no stepper', () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    assert.strictEqual(screen.queryByText('1 of 1') === null, true);
    assert.strictEqual(screen.queryByLabelText('Next') === null, true);
    assert.strictEqual(screen.queryByLabelText('Back') === null, true);
    assert.strictEqual(screen.getByLabelText('Answer').textContent!.length > 0, true);
  });

  test('choosing an option and answering posts the answers keyed by question id', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Question cards only'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only'] },
    });
  });

  test('three questions step forward and post one message carrying all three', async () => {
    const item = question({ questions: [q('a1'), q('a2'), q('a3')] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.getByText('1 of 3').textContent, '1 of 3');
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Next'));
    assert.strictEqual(screen.getByText('2 of 3').textContent, '2 of 3');
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { a1: ['A'], a2: ['A'], a3: ['A'] },
    });
  });

  test('Back returns to the previous question with its answer intact', async () => {
    const item = question({ questions: [q('a1'), q('a2')] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText('B'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('Back'));

    assert.strictEqual(screen.getByText('1 of 2').textContent, '1 of 2');
    // Local state only, but it survives stepping within the same card: the
    // user must not lose a pick by checking what they already answered.
    assert.strictEqual(
      screen.getByLabelText('B').getAttribute('aria-checked'), 'true');

    // Base UI's radio indicator settles its transition state on the next
    // frame. Stepping back re-mounts the checked indicator, so that frame
    // lands after this test's last await unless it is flushed here — which
    // would otherwise print an act(...) warning against the *next* test.
    await act(async () => {});
  });

  test('a multiSelect question posts every checked value', async () => {
    const item = question({
      questions: [{ ...question().questions[0], multiSelect: true }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText('Question cards only'));
    await userEvent.click(screen.getByLabelText('Both in one spec'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only', 'Both in one spec'] },
    });
  });

  test('a question with no options renders a text field only', () => {
    const item = question({
      questions: [{
        id: 'qq1', header: 'Name', question: 'Name?', multiSelect: false,
        allowOther: true, secret: false,
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.queryByRole('radio') === null, true);
    assert.strictEqual(screen.queryByRole('checkbox') === null, true);
    assert.strictEqual(screen.getByLabelText('Your answer').tagName, 'INPUT');
  });

  test('free text populates the answer', async () => {
    const item = question({
      questions: [{
        id: 'qq1', header: 'Name', question: 'Name?', multiSelect: false,
        allowOther: true, secret: false,
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.type(screen.getByLabelText('Your answer'), 'Ada');
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Ada'] },
    });
  });

  test('a secret question masks its field', () => {
    const item = question({
      questions: [{
        id: 'qq1', header: 'Token', question: 'API token?', multiSelect: false,
        allowOther: true, secret: true,
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(
      (screen.getByLabelText('Your answer') as HTMLInputElement).type, 'password');
  });

  test('a preview is collapsed until its disclosure is opened', async () => {
    const item = question({
      questions: [{
        ...question().questions[0],
        options: [
          { label: 'A', description: 'a', preview: 'PREVIEW BODY' },
          { label: 'B', description: 'b' },
        ],
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.queryByText('PREVIEW BODY') === null, true);
    // Only option A carries a preview, so only A gets a disclosure.
    assert.strictEqual(screen.queryByLabelText('Show preview for B') === null, true);
    await userEvent.click(screen.getByLabelText('Show preview for A'));
    assert.strictEqual(screen.getByText('PREVIEW BODY').textContent, 'PREVIEW BODY');
  });

  test('cancelling posts the interrupt', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Cancel this turn'));

    assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
  });

  test('cancelled and stale cards offer no controls', () => {
    renderWithStore(<QuestionCard item={question({ state: 'stale' })} sessionId="a" />);
    hydrateWith([]);

    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
    assert.strictEqual(screen.queryByLabelText('Cancel this turn') === null, true);
    assert.strictEqual(screen.queryByRole('radio') === null, true);
  });

  test('a cancelled card reads as cancelled', () => {
    renderWithStore(<QuestionCard item={question({ state: 'cancelled' })} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Scope — cancelled');
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });

  test('an answered card records what was answered', () => {
    renderWithStore(
      <QuestionCard
        item={question({ state: 'answered', answers: { qq1: ['Both in one spec'] } })}
        sessionId="a"
      />);
    hydrateWith([]);

    screen.getByText('Scope — answered');
    screen.getByText('Both in one spec');
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });

  test('a pending question the host is no longer waiting on offers no answer', () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith([]);

    // Same reasoning as PermissionCard: a persisted `pending` item from a
    // previous process would post an answer the host silently drops.
    assert.strictEqual(
      (screen.getByLabelText('Answer') as HTMLButtonElement).disabled, true);
  });

  test('a question with nothing to ask degrades to a line', () => {
    renderWithStore(<QuestionCard item={question({ questions: [] })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: [] }]);

    screen.getByText('A question arrived with nothing to ask');
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });

  test('the transcript renders a question item through the card', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a', { pendingQuestions: LIVE })],
      layout: layoutOf('a'),
      snapshots: [snapshot('a', { items: [question()], pendingQuestions: LIVE })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    screen.getByLabelText('Question cards only');
    screen.getByLabelText('Answer');
  });
});
