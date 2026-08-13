import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import type { SessionStatus } from '../../protocol/messages';
import { catalog, summary } from '../fixtures/protocol';
import { posted, renderWithStore } from './harness';

function pane(status: SessionStatus = 'idle'): PaneState {
  return { summary: summary('a', { status }), items: [], hasMore: false, pending: [] };
}

const WITH_EFFORT = catalog()[0].models[0];   // fake-large, effort low/medium/high
const NO_EFFORT = catalog()[0].models[1];     // fake-small

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

  test('a running session shows Stop, and clicking it posts interrupt', async () => {
    renderWithStore(<Composer pane={pane('running')} model={NO_EFFORT} />);

    assert.strictEqual(screen.queryByText('Send'), null);
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
});
