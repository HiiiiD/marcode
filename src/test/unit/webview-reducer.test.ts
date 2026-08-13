import * as assert from 'assert';
import { initialState, reduce } from '../../webview/reducer';
import type { SessionSnapshot, SessionSummary } from '../../protocol/messages';

function summary(id: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
    status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

function snapshot(id: string): SessionSnapshot {
  return { ...summary(id), items: [], hasMore: false, pending: [] };
}

suite('webview reducer', () => {
  test('hydrate populates sessions, layout, catalog and panes', () => {
    const next = reduce(initialState, {
      t: 'hydrate',
      sessions: [summary('s1')],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
      snapshots: [snapshot('s1')],
      catalog: [{ id: 'fake', displayName: 'Fake', models: [] }],
    });

    assert.strictEqual(next.ready, true);
    assert.strictEqual(next.sessions.length, 1);
    assert.strictEqual(next.layout.panes.length, 1);
    assert.ok(next.byId['s1']);
  });

  test('append patch adds an item', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 1, role: 'assistant', text: '' } },
    });
    assert.strictEqual(state.byId['s1'].items.length, 1);
  });

  test('delta patch appends to the targeted item only', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 1, role: 'assistant', text: 'He' } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'delta', itemId: 'a1', field: 'text', delta: 'llo' },
    });

    const item = state.byId['s1'].items[0] as { text: string };
    assert.strictEqual(item.text, 'Hello');
  });

  test('replace patch swaps an item in place, preserving order', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: {
        id: 't1', ts: 1, role: 'tool', toolId: 'x', name: 'Read',
        input: {}, state: 'running',
      } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 2, role: 'assistant', text: 'after' } },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'replace', item: {
        id: 't1', ts: 1, role: 'tool', toolId: 'x', name: 'Read',
        input: {}, state: 'ok', output: 'done',
      } },
    });

    assert.strictEqual(state.byId['s1'].items[0].id, 't1');
    assert.strictEqual((state.byId['s1'].items[0] as { state: string }).state, 'ok');
    assert.strictEqual(state.byId['s1'].items[1].id, 'a1');
  });

  test('session-prepend puts history in front and updates hasMore', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'b', ts: 2, role: 'user', text: 'second' } },
    });
    state = reduce(state, {
      t: 'session-prepend', id: 's1', hasMore: false,
      items: [{ id: 'a', ts: 1, role: 'user', text: 'first' }],
    });

    assert.deepStrictEqual(state.byId['s1'].items.map((i) => i.id), ['a', 'b']);
    assert.strictEqual(state.byId['s1'].hasMore, false);
  });

  test('a patch for an unknown session is ignored', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 'ghost',
      patch: { op: 'append', item: { id: 'x', ts: 1, role: 'user', text: 'hi' } },
    });
    assert.deepStrictEqual(state.byId, {});
  });

  test('session-status updates both the pane and the roster entry', () => {
    let state = reduce(initialState, {
      t: 'sessions-changed', sessions: [summary('s1')],
    });
    state = reduce(state, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, { t: 'session-status', id: 's1', status: 'running' });

    assert.strictEqual(state.sessions[0].status, 'running');
    assert.strictEqual(state.byId['s1'].summary.status, 'running');
  });

  test('local-layout applies a client-optimistic layout update', () => {
    const next = reduce(initialState, {
      t: 'local-layout',
      layout: { orientation: 'horizontal', panes: [{ sessionId: 's1', size: 100 }] },
    });
    assert.strictEqual(next.layout.orientation, 'horizontal');
    assert.deepStrictEqual(next.layout.panes, [{ sessionId: 's1', size: 100 }]);
  });

  test('an out-of-contract message is a no-op that returns the same state object', () => {
    const bogus = { t: 'not-a-real-variant' } as unknown as Parameters<typeof reduce>[1];
    const next = reduce(initialState, bogus);
    assert.strictEqual(next, initialState);
  });
});
