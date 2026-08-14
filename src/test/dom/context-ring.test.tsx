import * as assert from 'assert';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextRing } from '@/components/context-ring';
import { useStore } from '@/store';
import { breakdown, catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

/**
 * `ContextRing` takes its pane as a prop, but the prop must still be the
 * host's own state: a hand-built `PaneState` lets the component be exercised
 * against a store that has never heard of the session, which is precisely
 * the shape that hid the reducer's missing unknown-session rule. So the
 * store is hydrated and the pane is read back out of it.
 */
function RingUnderTest() {
  const { state } = useStore();
  const pane = state.byId['a'];
  return pane ? <ContextRing pane={pane} /> : null;
}

function mount(contextPercent?: number): void {
  renderWithStore(<RingUnderTest />);
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { contextPercent })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { contextPercent })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

/**
 * The trigger composes a Tooltip and a Popover on the same element. Base
 * UI's own open/close transitions for both resolve on timers that outlive
 * `userEvent.click`'s `act()` scope, so without this flush their state
 * updates land after the test body returns and React logs a "not wrapped in
 * act" warning even though the assertions that follow are correct. A
 * microtask flush, not a timeout, is enough to let those timers settle.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * `userEvent.click` leaves the virtual pointer resting on the trigger, which
 * arms the Tooltip's 600ms open delay. That timer outlives the test body by
 * a wide margin and fires in whatever suite happens to be running ~600ms
 * later, entirely outside any `act()` — which is where the ContextRing
 * suite's "not wrapped in act" warnings came from, and why they never
 * appeared when the file was run on its own. Moving the pointer off cancels
 * it at the source rather than waiting it out.
 */
async function open(label: string): Promise<void> {
  const trigger = screen.getByLabelText(label);
  await userEvent.click(trigger);
  await userEvent.unhover(trigger);
  await settle();
}

function requestCount(): number {
  return posted().filter((m) => m.t === 'request-context').length;
}

suite('ContextRing', () => {
  setup(() => { resetHost(); });

  test('labels the ring with the percentage in use', () => {
    mount(43);
    assert.ok(screen.getByLabelText('Context 43% used'));
  });

  test('labels the ring as unavailable when nothing was reported', () => {
    mount();
    assert.ok(screen.getByLabelText('Context usage unavailable'));
  });

  test('opening the dialog requests the breakdown for that session', async () => {
    mount(43);

    await open('Context 43% used');

    assert.deepStrictEqual(posted().at(-1), { t: 'request-context', id: 'a' });
  });

  test('renders the slices and memory files once the reply arrives', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a', result: { ok: true, breakdown: breakdown() },
    });

    assert.ok(screen.getByText('System prompt'));
    assert.ok(screen.getByText('57%'));
    assert.ok(screen.getByRole('button', { name: /CLAUDE\.md/ }));
  });

  test('a sub-one-percent memory file reads as <1%, never 0%', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: {
        ok: true,
        breakdown: breakdown({ memoryFiles: [{ path: '/repo/AGENTS.md', percent: 0 }] }),
      },
    });

    assert.ok(screen.getByText('<1%'));
  });

  test('an empty memory list says so rather than showing a lone row', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: { ok: true, breakdown: breakdown({ memoryPercent: 0, memoryFiles: [] }) },
    });

    assert.ok(screen.getByText('No memory files loaded'));
  });

  test('clicking a memory file asks the host to open it', async () => {
    mount(43);
    await open('Context 43% used');
    sendFromHost({
      t: 'context-breakdown', id: 'a', result: { ok: true, breakdown: breakdown() },
    });

    await userEvent.click(screen.getByRole('button', { name: /CLAUDE\.md/ }));
    await settle();

    assert.deepStrictEqual(
      posted().at(-1), { t: 'open-file', id: 'a', path: '/repo/CLAUDE.md' },
    );
  });

  test('a not-ok reply shows its reason', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: { ok: false, reason: 'This session is not running' },
    });

    assert.ok(screen.getByText('This session is not running'));
  });

  test('the not-ok state offers a retry that re-asks for the breakdown', async () => {
    mount(43);
    await open('Context 43% used');
    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: { ok: false, reason: 'This session is not running' },
    });
    const before = requestCount();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();

    assert.strictEqual(requestCount(), before + 1);
    assert.deepStrictEqual(posted().at(-1), { t: 'request-context', id: 'a' });
  });

  test('memory files sharing a basename stay distinguishable', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: {
        ok: true,
        breakdown: breakdown({
          memoryFiles: [
            { path: '/repo/CLAUDE.md', percent: 3 },
            { path: '/home/.claude/CLAUDE.md', percent: 1 },
          ],
        }),
      },
    });

    const names = screen.getAllByRole('button', { name: /CLAUDE\.md/ })
      .map((el) => el.textContent);
    assert.deepStrictEqual(names, ['/repo/CLAUDE.md', '/home/.claude/CLAUDE.md']);
  });

  test('the header, the ring label and the danger label agree on one number', async () => {
    mount(86);
    await open('Context 86% used');

    // On the wire, a breakdown reply and the sessions-changed that refreshes
    // contextPercent from that same fetch may not land in the same tick — so
    // the header must keep quoting the pushed number even while a breakdown
    // implying a different total is already on screen underneath it. If the
    // header derived its own number from the rows again, this would show
    // "50% used" beside a ring still labelled 86%.
    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: {
        ok: true,
        breakdown: breakdown({
          systemPercent: 20, memoryPercent: 6, conversationPercent: 24, freePercent: 50,
        }),
      },
    });

    assert.ok(screen.getByText('86% used'), 'the header must agree with the ring, not the rows');
    assert.ok(screen.getByLabelText('Context 86% used'));
  });

  test('an out-of-range percentage clamps the label as well as the bar', async () => {
    mount(43);
    await open('Context 43% used');

    sendFromHost({
      t: 'context-breakdown', id: 'a',
      result: {
        ok: true,
        breakdown: breakdown({
          conversationPercent: 140,
          memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 140 }],
        }),
      },
    });

    assert.strictEqual(screen.getAllByText('100%').length, 2);
  });

  test('above 80% the ring is labelled in text, not by colour alone', () => {
    mount(86);

    const trigger = screen.getByLabelText('Context 86% used');
    assert.ok(trigger.textContent?.includes('86%'));
  });

  test('below 80% the ring stays a bare glyph', () => {
    mount(43);

    const trigger = screen.getByLabelText('Context 43% used');
    assert.strictEqual(trigger.textContent, '');
  });
});
