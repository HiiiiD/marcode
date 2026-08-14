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
    usage: {},
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

    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: windows() });

    // Exact, not a filter: `ready` is all `StoreProvider` posts on mount, so
    // anything else in this list is the strip having grown an effect again.
    assert.deepStrictEqual(posted().map((m) => m.t), ['ready']);
  });

  test('a window past its reset is not rendered — the host prunes on read, so a stale copy would linger here', () => {
    mountStrip();

    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1 }],
    });

    assert.strictEqual(screen.queryByLabelText('Session (5h) 62% used'), null);
    assert.ok(screen.getByText('Plan usage not reported'));
  });

  test('an expired window is dropped without taking its unexpired siblings with it', () => {
    mountStrip();

    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      windows: [
        { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1 },
        { id: 'seven-day', label: 'Week', usedPercent: 18 },
      ],
    });

    const labels = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
    assert.deepStrictEqual(labels, ['Week 18% used']);
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
