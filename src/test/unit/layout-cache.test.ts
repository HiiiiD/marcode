import * as assert from 'node:assert';
import { trackLayout } from '../../host/layout-cache';
import type { HostToWebview, PaneLayout } from '../../protocol/messages';

const layout = (id: string): PaneLayout => ({
  root: { kind: 'leaf', sessionId: id, size: 100 }, presets: [],
} as unknown as PaneLayout);

suite('layout cache', () => {
  // A class, like the real DaemonClient: onMessage reads `this`, so it breaks if detached from its owner.
  class Feed {
    private readonly listeners = new Set<(m: HostToWebview) => void>();
    onMessage(l: (m: HostToWebview) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
    send(m: HostToWebview): void { for (const l of [...this.listeners]) { l(m); } }
    count(): number { return this.listeners.size; }
  }
  const feed = () => new Feed();

  test('keeps the last layout from hydrate or layout-changed and ignores other messages', () => {
    const f = feed();
    const cache = trackLayout(f);
    assert.strictEqual(cache.current() === undefined, true);
    f.send({ t: 'hydrate', layout: layout('a') } as unknown as HostToWebview);
    assert.deepStrictEqual(cache.current(), layout('a'));
    f.send({ t: 'layout-changed', layout: layout('b') });
    f.send({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.deepStrictEqual(cache.current(), layout('b'));
  });

  test('dispose stops tracking', () => {
    const f = feed();
    const cache = trackLayout(f);
    cache.dispose();
    assert.strictEqual(f.count(), 0);
    f.send({ t: 'layout-changed', layout: layout('c') });
    assert.strictEqual(cache.current() === undefined, true);
  });
});
