import * as assert from 'node:assert';
import { PostBus, REVIEW_WANTS, FLEET_WANTS, HISTORY_WANTS } from '../../host/post-bus';
import type { HostToWebview, SessionId } from '../../protocol/messages';
import { layoutOf } from '../fixtures/protocol';

suite('PostBus', () => {
  test('delivers only what a client wants', () => {
    const bus = new PostBus();
    const all: HostToWebview[] = [];
    const some: HostToWebview[] = [];
    bus.add({ post: (m) => all.push(m), wants: () => true });
    bus.add({ post: (m) => some.push(m), wants: REVIEW_WANTS });

    bus.post({ t: 'session-status', id: 's1', status: 'idle' } as HostToWebview);
    bus.post({ t: 'session-patch', id: 's1', items: [] } as unknown as HostToWebview);

    assert.strictEqual(all.length, 2);
    assert.strictEqual(some.length, 1);
    assert.strictEqual(some[0].t, 'session-status');
  });

  test('a review client never receives session-patch', () => {
    assert.strictEqual(REVIEW_WANTS({ t: 'session-patch' } as HostToWebview), false);
    assert.strictEqual(REVIEW_WANTS({ t: 'fleet-diff', trees: [] } as HostToWebview), true);
    assert.strictEqual(REVIEW_WANTS({ t: 'sessions-changed' } as unknown as HostToWebview), true);
  });

  test('HISTORY_WANTS takes memory-progress but not memory-status (a direct answer)', () => {
    assert.strictEqual(HISTORY_WANTS({ t: 'memory-progress', phase: 'done', done: 1, total: 1 }), true);
    assert.strictEqual(HISTORY_WANTS({ t: 'memory-status', enabled: true, llm: false } as unknown as HostToWebview), false);
  });

  test('HISTORY_WANTS admits sessions-changed and nothing else', () => {
    assert.strictEqual(HISTORY_WANTS({ t: 'sessions-changed', sessions: [] } as unknown as HostToWebview), true);
    assert.strictEqual(HISTORY_WANTS({ t: 'session-status', id: 's1' as SessionId, status: 'idle' } as HostToWebview), false);
    assert.strictEqual(HISTORY_WANTS({ t: 'session-patch' } as unknown as HostToWebview), false);
    assert.strictEqual(HISTORY_WANTS({ t: 'fleet-diff', trees: [] } as HostToWebview), false);
  });

  test('FLEET_WANTS admits sessions-changed, session-status, session-patch, layout-changed, session-snapshot', () => {
    assert.strictEqual(FLEET_WANTS({ t: 'sessions-changed', sessions: [] } as unknown as HostToWebview), true);
    assert.strictEqual(FLEET_WANTS({ t: 'session-status', id: 's1' as SessionId, status: 'idle' } as HostToWebview), true);
    assert.strictEqual(
      FLEET_WANTS({ t: 'session-patch', id: 's1' as SessionId, patch: { op: 'append', item: {} } } as unknown as HostToWebview),
      true,
    );
    assert.strictEqual(
      FLEET_WANTS({ t: 'layout-changed', layout: layoutOf([]) } as HostToWebview),
      true,
    );
    assert.strictEqual(
      FLEET_WANTS({ t: 'session-snapshot', session: { id: 's1' } } as unknown as HostToWebview),
      true,
    );
    assert.strictEqual(FLEET_WANTS({ t: 'fleet-diff', trees: [] } as unknown as HostToWebview), false);
  });

  test('remove stops delivery', () => {
    const bus = new PostBus();
    const got: HostToWebview[] = [];
    const remove = bus.add({ post: (m) => got.push(m), wants: () => true });
    remove();
    bus.post({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.strictEqual(got.length, 0);
  });

  test('one client throwing does not stop the others', () => {
    const bus = new PostBus();
    const got: HostToWebview[] = [];
    bus.add({ post: () => { throw new Error('disposed webview'); }, wants: () => true });
    bus.add({ post: (m) => got.push(m), wants: () => true });
    bus.post({ t: 'sessions-changed' } as unknown as HostToWebview);
    assert.strictEqual(got.length, 1);
  });
});
