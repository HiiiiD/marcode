import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { UsageStrip } from '@/components/usage-strip';
import { catalog, layoutOf, snapshot, summary, windows } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

function hydrateOne() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });
}

suite('UsageStrip', () => {
  setup(() => { resetHost(); });

  test('requests usage for each provider with a session', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();

    assert.ok(posted().some((m) => m.t === 'request-usage' && m.providerId === 'fake'));
  });

  /**
   * The primary path after every window reload. This component's effect runs
   * before `App`'s, so the first `request-usage` is posted at or before
   * `set-visible` — and sessions restored from `index.json` are not live
   * until `set-visible` has opened them, so the host legitimately answers
   * "No active session for this provider". The correction has to come from
   * the strip itself; nothing else will ask again until the user sends a
   * message. `sessions-changed` is the signal, and it carries no changed
   * summary field when a restored session is opened (idle stays idle), which
   * is exactly why the earlier `id:status` key never re-fired.
   */
  test('asks again once the roster changes after a not-ok reply', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();
    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      result: { ok: false, reason: 'No active session for this provider' },
    });

    const before = posted().filter((m) => m.t === 'request-usage').length;
    sendFromHost({ t: 'sessions-changed', sessions: [summary('a')] });

    const after = posted().filter(
      (m) => m.t === 'request-usage' && m.providerId === 'fake',
    ).length;
    assert.strictEqual(after, before + 1, 'the not-ok reply must be re-asked, exactly once');
  });

  test('does not keep re-asking while the same not-ok reply is cached', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();
    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      result: { ok: false, reason: 'No active session for this provider' },
    });
    sendFromHost({ t: 'sessions-changed', sessions: [summary('a')] });

    const after = posted().filter((m) => m.t === 'request-usage').length;
    sendFromHost({ t: 'sessions-changed', sessions: [summary('a')] });
    sendFromHost({ t: 'sessions-changed', sessions: [summary('a')] });

    assert.strictEqual(
      posted().filter((m) => m.t === 'request-usage').length, after,
      'a roster change with no new reply is throttled, not re-asked',
    );
  });

  test('renders one chip per reported window, in the order given', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();

    sendFromHost({
      t: 'usage-windows', providerId: 'fake', result: { ok: true, windows: windows() },
    });

    const labels = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
    assert.deepStrictEqual(labels, ['Session (5h) 62% used', 'Week 18% used']);
  });

  test('an ok reply with no windows reads as no plan limits, not as an error', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();

    sendFromHost({
      t: 'usage-windows', providerId: 'fake', result: { ok: true, windows: [] },
    });

    assert.ok(screen.getByText('No plan limits'));
  });

  test('a not-ok reply shows its reason', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();

    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      result: { ok: false, reason: 'No active session for this provider' },
    });

    assert.ok(screen.getByText('No active session for this provider'));
  });

  test('chips are keyboard-focusable', () => {
    renderWithStore(<UsageStrip />);
    hydrateOne();
    sendFromHost({
      t: 'usage-windows', providerId: 'fake', result: { ok: true, windows: windows() },
    });

    const chip = screen.getByLabelText('Session (5h) 62% used');
    assert.strictEqual(chip.getAttribute('tabindex'), '0');
  });
});
