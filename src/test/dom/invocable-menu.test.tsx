import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/composer';
import type { PaneState } from '@/reducer';
import type { Invocable } from '../../protocol/messages';
import { catalog, summary } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost } from './harness';

const ENTRIES: Invocable[] = [
  { name: 'brainstorming', description: 'Turn ideas into designs' },
  { name: 'superpowers:writing-plans', description: 'Plan before code', origin: 'superpowers' },
  { name: 'loop', description: 'Run on an interval', argHint: '[interval] [prompt]' },
];

const NO_EFFORT = catalog()[0].models[1];

function pane(invocables?: Invocable[]): PaneState {
  return { summary: summary('a'), items: [], hasMore: false, pending: [], invocables };
}

suite('invocable menu', () => {
  test('typing / opens the menu and a name filters it', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '/bra');

    const options = screen.getAllByRole('option');
    assert.strictEqual(options.length, 1);
    assert.ok(options[0].textContent?.includes('brainstorming'));
  });

  test('a slash that is not at position 0 opens nothing', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), 'see src/foo');

    assert.strictEqual(screen.queryByRole('listbox'), null);
  });

  test('a space closes the menu and Enter sends again', async () => {
    resetHost();
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '/loop 5m');
    assert.strictEqual(screen.queryByRole('listbox'), null);

    await userEvent.type(box, '{Enter}');
    const sends = posted().filter((m) => m.t === 'send');
    assert.deepStrictEqual(sends.map((m) => (m as { text: string }).text), ['/loop 5m']);
  });

  test('arrows move the active option and Enter inserts it', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/');
    await userEvent.keyboard('{ArrowDown}');

    const list = screen.getByRole('listbox');
    const activeId = list.getAttribute('aria-activedescendant');
    assert.strictEqual(document.getElementById(activeId ?? '')?.textContent?.includes(
      'superpowers:writing-plans',
    ), true);

    await userEvent.keyboard('{Enter}');
    assert.strictEqual(box.value, '/superpowers:writing-plans ');
  });

  test('Escape closes the menu and leaves the typed text alone', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/bra');
    await userEvent.keyboard('{Escape}');

    assert.strictEqual(screen.queryByRole('listbox'), null);
    assert.strictEqual(box.value, '/bra');
  });

  test('the arg hint is shown but never sent', async () => {
    resetHost();
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/loop');
    await userEvent.keyboard('{Enter}');
    assert.ok(screen.getByText('[interval] [prompt]'));

    await userEvent.type(box, '5m{Enter}');
    const sends = posted().filter((m) => m.t === 'send');
    assert.deepStrictEqual(sends.map((m) => (m as { text: string }).text), ['/loop 5m']);
  });

  test('a query matching nothing renders one No match row', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), '/zzzz');

    assert.strictEqual(screen.getAllByRole('option').length, 1);
    assert.ok(screen.getByText('No match'));
  });

  test('a pane with no catalog has no control and an inert slash', async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} />);

    assert.strictEqual(screen.queryByLabelText('Skills and commands'), null);
    await userEvent.type(screen.getByLabelText('Message'), '/');
    assert.strictEqual(screen.queryByRole('listbox'), null);
  });

  test('the control opens the full list unfiltered', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.click(screen.getByLabelText('Skills and commands'));

    assert.strictEqual(screen.getAllByRole('option').length, ENTRIES.length);
  });
});
