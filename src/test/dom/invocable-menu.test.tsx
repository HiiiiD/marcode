import * as assert from 'assert';
import { fireEvent, screen } from '@testing-library/react';
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

  /**
   * ARIA honours `aria-activedescendant` only on the element that actually
   * holds DOM focus. Focus never leaves the textarea here, so a copy sitting
   * on the listbox alone announces nothing — the id would resolve and the
   * active row would still be silent.
   */
  test('the focused textarea points at the highlighted row', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.type(box, '/');

    const first = box.getAttribute('aria-activedescendant');
    assert.ok(first, 'the textarea, not just the listbox, must name the active row');
    assert.ok(document.getElementById(first)?.textContent?.includes('brainstorming'));
    assert.strictEqual(document.getElementById(first)?.getAttribute('aria-selected'), 'true');

    await userEvent.keyboard('{ArrowDown}');

    const second = box.getAttribute('aria-activedescendant');
    assert.notStrictEqual(second, first);
    assert.ok(document.getElementById(second ?? '')?.textContent?.includes(
      'superpowers:writing-plans',
    ));
  });

  /**
   * The control is the second entry point to the SAME menu, so everything the
   * typed path can do the clicked path must do too. An earlier shape opened
   * it with a flag of its own and left focus on the button: the arrow keys
   * are bound on the textarea, so the list was keyboard-dead.
   */
  test('the control hands focus back, so arrows and Enter work after a click', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;

    await userEvent.click(screen.getByLabelText('Skills and commands'));

    assert.strictEqual(document.activeElement, box, 'focus must return to the message box');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    assert.strictEqual(box.value, '/superpowers:writing-plans ');
  });

  test('typing after the control opens it narrows rather than closing', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.click(screen.getByLabelText('Skills and commands'));
    await userEvent.keyboard('bra');

    const options = screen.getAllByRole('option');
    assert.strictEqual(options.length, 1);
    assert.ok(options[0].textContent?.includes('brainstorming'));
  });

  /**
   * Trigger discipline requires `/` at position 0, so the menu genuinely
   * cannot open over a draft. Disabled with a reason rather than clearing the
   * box — the user's half-written message is not ours to throw away.
   */
  test('with a message typed the control is disabled and says why', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), 'hello');

    const control = screen.getByLabelText('Skills and commands');
    assert.strictEqual(control.hasAttribute('disabled'), true);
    assert.strictEqual(
      control.getAttribute('title'), null,
      'a title on a disabled control is unreachable by assistive tech',
    );
    const describedBy = control.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the disabled control must explain itself');
    assert.strictEqual(
      document.getElementById(describedBy)?.textContent,
      'Clear the message to browse skills and commands.',
    );
  });

  /**
   * `twMerge` cannot merge across variants, so a `hover:bg-muted` on the
   * active row would ship alongside `bg-accent` and win on specificity —
   * hovering the keyboard-active row would wipe its highlight.
   */
  test('the active row carries no hover fill to override its highlight', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);

    await userEvent.type(screen.getByLabelText('Message'), '/');

    const options = screen.getAllByRole('option');
    assert.strictEqual(options[0].getAttribute('aria-selected'), 'true');
    assert.ok(
      !options[0].className.includes('hover:bg-muted'),
      'the active row must not carry a hover fill that outranks bg-accent',
    );
    assert.ok(options[0].className.includes('bg-accent'));
    assert.ok(options[1].className.includes('hover:bg-muted'), 'inactive rows still hover');
  });

  test('moving the highlight scrolls it into view', async () => {
    const calls: { el: Element; arg: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function record(this: Element, arg?: unknown): void {
      calls.push({ el: this, arg });
    } as typeof original;

    try {
      renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
      await userEvent.type(screen.getByLabelText('Message'), '/');
      await userEvent.keyboard('{ArrowDown}');
    } finally {
      Element.prototype.scrollIntoView = original;
    }

    const onActive = calls.filter((c) => c.el.getAttribute('aria-selected') === 'true');
    assert.ok(onActive.length > 0, 'the highlighted row must be scrolled into view');
    assert.deepStrictEqual(onActive.at(-1)?.arg, { block: 'nearest' });
  });

  /**
   * The menu is an in-flow block-start addon, so leaving it open keeps eating
   * vertical space above the composer once the user has clicked away.
   */
  test('focus leaving the box closes the menu', async () => {
    renderWithStore(<Composer pane={pane(ENTRIES)} model={NO_EFFORT} />);
    const box = screen.getByLabelText('Message');

    await userEvent.type(box, '/bra');
    assert.ok(screen.getByRole('listbox'));

    fireEvent.blur(box);

    assert.strictEqual(screen.queryByRole('listbox'), null);
    assert.strictEqual(screen.getByLabelText('Message').getAttribute('aria-expanded'), 'false');
  });
});
