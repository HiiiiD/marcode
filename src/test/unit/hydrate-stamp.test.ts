import * as assert from 'assert';
import { stampHydrate, withHydrateStamp } from '../../client-core/hydrate-stamp';
import type { ClientTransport } from '../../client-core/transport';
import type { HostToWebview } from '../../protocol/messages';
import { layoutOf } from '../fixtures/protocol';

const hydrate: HostToWebview = {
  t: 'hydrate', sessions: [], layout: layoutOf([]), snapshots: [], catalog: [], unavailable: [], usage: {},
};

suite('hydrate-stamp', () => {
  test('stamps the given fields onto a hydrate and leaves the rest alone', () => {
    const out = stampHydrate(hydrate, { autoGrid: true });
    assert.strictEqual(out.t === 'hydrate' && out.autoGrid, true);
    assert.strictEqual(out.t === 'hydrate' && out.sessions.length, 0);
  });

  test('any other message passes through as the same object', () => {
    const msg: HostToWebview = { t: 'host-link', status: 'connected' };
    assert.strictEqual(stampHydrate(msg, { autoGrid: true }), msg);
  });

  test('a wrapped transport stamps what its listeners receive and forwards posts untouched', () => {
    const seen: HostToWebview[] = [];
    const posted: unknown[] = [];
    let emit: (m: HostToWebview) => void = () => undefined;
    const inner: ClientTransport = {
      post: (m) => { posted.push(m); },
      onMessage: (fn) => { emit = fn; return () => undefined; },
    };
    const wrapped = withHydrateStamp(inner, { autoGrid: true });
    wrapped.onMessage((m) => seen.push(m));
    wrapped.post({ t: 'ready' });
    emit(hydrate);
    assert.deepStrictEqual(posted, [{ t: 'ready' }]);
    assert.strictEqual(seen[0].t === 'hydrate' && seen[0].autoGrid, true);
  });
});
