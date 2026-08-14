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
