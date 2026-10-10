import * as assert from 'node:assert';
import { trackLayout } from '../../host/layout-cache';
import type { HostToWebview, PaneLayout } from '../../protocol/messages';

const layout = (id: string): PaneLayout => ({
  root: { kind: 'leaf', sessionId: id, size: 100 }, presets: [],
} as unknown as PaneLayout);

suite('layout cache', () => {
  function feed() {
    const listeners = new Set<(m: HostToWebview) => void>();
    const onMessage = (l: (m: HostToWebview) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
    return { onMessage, send: (m: HostToWebview) => { for (const l of [...listeners]) { l(m); } }, count: () => listeners.size };
  }

  test('keeps the last layout from hydrate or layout-changed and ignores other messages', () => {
    const f = feed();
    const cache = trackLayout(f.onMessage);
    assert.strictEqual(cache.current() === undefined, true);
    f.send({ t: 'hydrate', layout: layout('a') } as unknown as HostToWebview);
    assert.deepStrictEqual(cache.current(), layout('a'));
    f.send({ t: 'layout-changed', layout: layout('b') });
    f.send({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.deepStrictEqual(cache.current(), layout('b'));
  });

  test('dispose stops tracking', () => {
    const f = feed();
    const cache = trackLayout(f.onMessage);
    cache.dispose();
    assert.strictEqual(f.count(), 0);
    f.send({ t: 'layout-changed', layout: layout('c') });
    assert.strictEqual(cache.current() === undefined, true);
  });
});
