import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { UsageStrip } from '@/components/usage-strip';
import { catalog, layoutOf, snapshot, summary, windows } from '../fixtures/protocol';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

/**
 * The strip follows usage, not the roster, but every test still needs a
 * hydrated store — the catalog supplies display names and `usageByProvider`
 * starts empty either way.
 */
function mountStrip() {
  const result = renderWithStore(<UsageStrip />);
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
  return result;
}

/**
 * Whether the strip rendered anything at all, as a boolean.
 *
 * Deliberately NOT `assert.strictEqual(container.querySelector('div'), null)`.
 * A failing `assert` builds its message by running `util.inspect` on the
 * actual value, and a jsdom element reaches its parents, its ownerDocument
 * and that document's window — so inspecting one div walks the whole graph.
 * That assertion, in its failing state, allocated 3.5GB in 4 seconds and took
 * the machine down. Booleans and strings are the only safe things to hand an
 * assertion here. See CLAUDE.md's DOM-test invariant.
 */
function rendered(container: HTMLElement): boolean {
  return container.querySelector('div') !== null;
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

  test('an expired-only provider drops out of the strip', () => {
    const { container } = mountStrip();
    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1 }],
    });

    assert.strictEqual(rendered(container), false);
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

  test('the strip unmounts entirely when nothing reports', () => {
    const { container } = mountStrip();
    assert.strictEqual(rendered(container), false);
  });

  test('an empty set reads the same as nothing reported — the strip stays unmounted', () => {
    const { container } = mountStrip();

    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: [] });

    assert.strictEqual(rendered(container), false);
  });

  test('chips are keyboard-focusable', () => {
    mountStrip();
    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: windows() });

    const chip = screen.getByLabelText('Session (5h) 62% used');
    assert.strictEqual(chip.getAttribute('tabindex'), '0');
  });

  test('a provider with usage but no session is shown', () => {
    const { container } = mountStrip();
    sendFromHost({
      t: 'usage-windows', providerId: 'other',
      windows: [{ id: 'seven-day', label: 'Week', usedPercent: 18, resetsAt: Date.now() + 60_000 }],
    });

    // Usage belongs to the account, not to an open conversation. A second
    // subscription is real whether or not a session for it is open right now.
    assert.ok(screen.getByLabelText('Week 18% used'));
    assert.strictEqual(rendered(container), true);
  });

  test('a provider with a session but no usage is absent', () => {
    const { container } = mountStrip();   // seeds a 'fake' session, no windows

    assert.strictEqual(screen.queryByText(/Plan usage not reported/), null);
    // An API-key provider can never report. A permanent row it can never fill
    // is noise no action clears, so the strip does not render one.
    assert.strictEqual(container.textContent, '');
  });

  test('two reporting providers are each labelled', () => {
    renderWithStore(<UsageStrip />);
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [snapshot('a')],
      catalog: [...catalog(), { id: 'other', displayName: 'Other', models: [], permissionModes: [] }],
      unavailable: [],
      usage: {},
    });
    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 10, resetsAt: Date.now() + 60_000 }],
    });
    sendFromHost({
      t: 'usage-windows', providerId: 'other',
      windows: [{ id: 'seven-day', label: 'Week', usedPercent: 20, resetsAt: Date.now() + 60_000 }],
    });

    assert.ok(screen.getByText('Fake'));
    assert.ok(screen.getByText('Other'));
  });
});
