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

/**
 * The accessible name of an option carries its description too — the
 * description is the difference between the choices, so it belongs in the
 * name and not only on screen.
 */
const ONLY = 'Question cards only. Smaller blast radius';
const BOTH = 'Both in one spec. Shares the call site';

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

    await userEvent.click(screen.getByLabelText(ONLY));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only'] },
    });
  });

  test('the option group is named by the question', () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    // Without this the question text is an orphaned line and the radios
    // announce as an unnamed set.
    screen.getByRole('radiogroup', { name: 'Which one?' });
  });

  test('a multiSelect question exposes a named group', () => {
    const item = question({
      questions: [{ ...question().questions[0], multiSelect: true }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    // A checkbox set has no grouping element of its own, so the card declares
    // one rather than leaving the checkboxes ungrouped.
    screen.getByRole('group', { name: 'Which one?' });
  });

  test('three questions step forward and post one message carrying all three', async () => {
    const item = question({ questions: [q('a1'), q('a2'), q('a3')] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.getByText('1 of 3').textContent, '1 of 3');
    await userEvent.click(screen.getByLabelText('A. a'));
    await userEvent.click(screen.getByLabelText('Next'));
    assert.strictEqual(screen.getByText('2 of 3').textContent, '2 of 3');
    await userEvent.click(screen.getByLabelText('A. a'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('A. a'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { a1: ['A'], a2: ['A'], a3: ['A'] },
    });
  });

  test('stepping announces the question it moved to', async () => {
    const item = question({ questions: [q('a1'), q('a2')] });
    const { container } = renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    const announced = () => container.querySelector('[aria-live="polite"]')?.textContent ?? '';
    assert.strictEqual(announced(), 'Question 1 of 2: H. a1?');

    await userEvent.click(screen.getByLabelText('A. a'));
    await userEvent.click(screen.getByLabelText('Next'));

    // The region is the same node throughout — created after the fact it
    // would announce nothing, torn down and rebuilt it would announce twice.
    assert.strictEqual(announced(), 'Question 2 of 2: H. a2?');
  });

  test('Back returns to the previous question with its answer intact', async () => {
    const item = question({ questions: [q('a1'), q('a2')] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText('B. b'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('Back'));

    assert.strictEqual(screen.getByText('1 of 2').textContent, '1 of 2');
    // Local state only, but it survives stepping within the same card: the
    // user must not lose a pick by checking what they already answered.
    assert.strictEqual(
      screen.getByLabelText('B. b').getAttribute('aria-checked'), 'true');

    // Base UI's radio indicator settles its transition state on the next
    // frame. Stepping back re-mounts the checked indicator, so that frame
    // lands after this test's last await unless it is flushed here — which
    // would otherwise print an act(...) warning against the *next* test.
    await act(async () => {});
  });

  test('two options sharing a label stay distinct', async () => {
    const item = question({
      questions: [{
        ...question().questions[0],
        options: [{ label: 'A', description: 'first' }, { label: 'A', description: 'second' }],
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText('A. second'));

    // Identity is the index, not the label: keyed by label these two options
    // are one option, and picking either would check both.
    assert.strictEqual(screen.getByLabelText('A. first').getAttribute('aria-checked'), 'false');
    assert.strictEqual(screen.getByLabelText('A. second').getAttribute('aria-checked'), 'true');

    await act(async () => {});
  });

  test('a multiSelect question posts every checked value', async () => {
    const item = question({
      questions: [{ ...question().questions[0], multiSelect: true }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText(ONLY));
    await userEvent.click(screen.getByLabelText(BOTH));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only', 'Both in one spec'] },
    });
  });

  test('free text displaces the pick on a single-select question', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText(ONLY));
    await userEvent.type(screen.getByLabelText('Your answer'), 'Neither');
    await userEvent.click(screen.getByLabelText('Answer'));

    // One question, one answer: concatenating the pick and the typed text
    // posted two values for a question that can only have one.
    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Neither'] },
    });
  });

  test('free text is added to the picks on a multiSelect question', async () => {
    const item = question({
      questions: [{ ...question().questions[0], multiSelect: true }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText(ONLY));
    await userEvent.type(screen.getByLabelText('Your answer'), 'And this');
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only', 'And this'] },
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

  test('a secret question masks its field and says so before it is typed', () => {
    const item = question({
      questions: [{
        id: 'qq1', header: 'Token', question: 'API token?', multiSelect: false,
        allowOther: true, secret: true,
      }],
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    const field = screen.getByLabelText('Your answer (hidden)') as HTMLInputElement;
    assert.strictEqual(field.type, 'password');
    // The reassurance has to arrive before the credential does — it used to
    // appear only on the settled card, after the value had been sent.
    screen.getByText('This answer is not written to the transcript.');
    assert.strictEqual(
      field.getAttribute('aria-describedby'), 'question-a-q1-secret-reason');
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

  test('stopping the turn states the consequence and takes a second click', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Stop'));

    // Nothing has been interrupted yet, and the cost is on screen rather than
    // hidden in an aria-label only a screen reader could reach.
    assert.strictEqual(posted().some((m) => m.t === 'interrupt'), false);
    screen.getByText('Stopping ends this turn. The question goes unanswered and nothing is undone.');

    await userEvent.click(screen.getByLabelText('Stop the turn'));

    assert.deepStrictEqual(posted().at(-1), { t: 'interrupt', id: 'a' });
  });

  test('the disabled answer button names what is missing', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    assert.strictEqual((screen.getByLabelText('Answer') as HTMLButtonElement).disabled, true);
    assert.strictEqual(
      screen.getByLabelText('Answer').getAttribute('aria-describedby'),
      'question-a-q1-advance-reason');
    screen.getByText('Choose an option or type an answer to continue.');

    await userEvent.click(screen.getByLabelText(ONLY));

    assert.strictEqual((screen.getByLabelText('Answer') as HTMLButtonElement).disabled, false);
    assert.strictEqual(
      screen.getByLabelText('Answer').getAttribute('aria-describedby') === null, true);
  });

  test('cancelled and stale cards offer no controls', () => {
    renderWithStore(<QuestionCard item={question({ state: 'stale' })} sessionId="a" />);
    hydrateWith([]);

    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
    assert.strictEqual(screen.queryByLabelText('Stop') === null, true);
    assert.strictEqual(screen.queryByRole('radio') === null, true);
  });

  test('a stale card reads as a sentence, not a state token', () => {
    renderWithStore(<QuestionCard item={question({ state: 'stale' })} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Question — Expired unanswered');
  });

  test('a cancelled card reads as cancelled and keeps the question', () => {
    renderWithStore(<QuestionCard item={question({ state: 'cancelled' })} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('Question — Turn stopped before answering');
    // Scrollback without the question is a record of an answer to nothing.
    screen.getByText('Which one?');
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });

  test('an answered card records what was answered', () => {
    renderWithStore(
      <QuestionCard
        item={question({ state: 'answered', answers: { qq1: ['Both in one spec'] } })}
        sessionId="a"
      />);
    hydrateWith([]);

    screen.getByText('Question — Answered');
    screen.getByText('Which one?');
    screen.getByText('Both in one spec');
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });

  test('a settled card records every question, not just the first', () => {
    const item = question({
      state: 'answered',
      questions: [q('a1'), q('a2')],
      answers: { a1: ['A'], a2: ['B'] },
    });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([]);

    screen.getByText('a1?');
    screen.getByText('a2?');
    screen.getByText('A');
    screen.getByText('B');
  });

  test('a pending question the host is no longer waiting on offers no answer', () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith([]);

    // Same reasoning as PermissionCard: a persisted `pending` item from a
    // previous process would post an answer the host silently drops.
    assert.strictEqual(
      (screen.getByLabelText('Answer') as HTMLButtonElement).disabled, true);
    screen.getByText('Question — No longer awaiting an answer');
    screen.getByText('This question is no longer awaiting an answer.');
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

    screen.getByLabelText(ONLY);
    screen.getByLabelText('Answer');
  });
});
