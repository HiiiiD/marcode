import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { UsageStrip } from '@/components/usage-strip';
import { catalog, layoutOf, snapshot, summary, windows } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

/**
 * The strip only lists providers that have sessions, so every test needs a
 * roster before it has anything to render.
 */
function mountStrip() {
  renderWithStore(<UsageStrip />);
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

  test('renders the windows the host pushed, in the order given', () => {
    mountStrip();

    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: windows() });

    const labels = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
    assert.deepStrictEqual(labels, ['Session (5h) 62% used', 'Week 18% used']);
  });

  test('the strip posts nothing — it is a render, not a request', () => {
    mountStrip();

    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: [] });

    assert.ok(!posted().some((m) => m.t.startsWith('request-')));
  });

  test('a provider with nothing reported reads as not-reported, not as an error or as "no limits"', () => {
    mountStrip();

    assert.ok(screen.getByText('Plan usage not reported'));
  });

  test('an empty set reads the same as nothing reported — the push cannot tell them apart', () => {
    mountStrip();

    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: [] });

    assert.ok(screen.getByText('Plan usage not reported'));
  });

  test('chips are keyboard-focusable', () => {
    mountStrip();
    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: windows() });

    const chip = screen.getByLabelText('Session (5h) 62% used');
    assert.strictEqual(chip.getAttribute('tabindex'), '0');
  });
});
