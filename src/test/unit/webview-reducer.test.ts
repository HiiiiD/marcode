import * as assert from 'assert';
import type { SessionSummary } from '../../protocol/messages';
import { initialState, reduce } from '../../webview/reducer';
import { snapshot, summary } from '../fixtures/protocol';

/**
 * A state the host could actually produce for one session: a roster entry
 * and the matching pane. `session-snapshot` alone leaves `sessions` empty,
 * which the host never does — and the `context-breakdown` rule below keys
 * off the roster, so tests about it have to start from the real shape.
 */
function withSession(id: string) {
  return reduce(initialState, {
    t: 'hydrate',
    sessions: [summary(id)],
    layout: { orientation: 'vertical', panes: [{ sessionId: id, size: 100 }] },
    snapshots: [snapshot(id)],
    catalog: [],
  });
}

function hydrated() {
  return reduce(initialState, {
    t: 'hydrate',
    sessions: [],
    layout: { orientation: 'vertical', panes: [] },
    catalog: [],
    snapshots: [{
      id: 's1', providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
      status: 'idle', permissionMode: 'default',
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: 1, updatedAt: 1, includeEditorContext: true,
      items: [], hasMore: false, pending: [], mcpServers: [],
    }],
  });
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

  test('sessions-changed mirrors an updated summary (effort, permissionMode) into byId', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    assert.strictEqual(state.byId['s1'].summary.effort, undefined);
    assert.strictEqual(state.byId['s1'].summary.permissionMode, 'default');

    const updated: SessionSummary = { ...summary('s1'), effort: 'high', permissionMode: 'bypass' };
    state = reduce(state, { t: 'sessions-changed', sessions: [updated] });

    assert.strictEqual(state.byId['s1'].summary.effort, 'high');
    assert.strictEqual(state.byId['s1'].summary.permissionMode, 'bypass');
  });

  test('sessions-changed for a session with no byId entry does not create one', () => {
    const before = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    const after = reduce(before, {
      t: 'sessions-changed', sessions: [summary('s1'), summary('ghost')],
    });

    assert.ok(!('ghost' in after.byId));
    // Referentially unchanged for the id that never had a pane: no
    // half-initialized pane is created, and no new object is allocated for
    // an id this reducer has nothing to mirror onto.
    assert.strictEqual(after.byId['ghost'], undefined);
  });

  test('sessions-changed preserves items, hasMore and pending on the mirrored pane', () => {
    let state = reduce(initialState, { t: 'session-snapshot', session: snapshot('s1') });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'append', item: { id: 'a1', ts: 1, role: 'assistant', text: 'hi' } },
    });
    const before = state.byId['s1'];
    assert.strictEqual(before.items.length, 1);

    const updated: SessionSummary = { ...summary('s1'), effort: 'low' };
    state = reduce(state, { t: 'sessions-changed', sessions: [updated] });

    assert.strictEqual(state.byId['s1'].items, before.items);
    assert.strictEqual(state.byId['s1'].hasMore, before.hasMore);
    assert.strictEqual(state.byId['s1'].pending, before.pending);
    assert.strictEqual(state.byId['s1'].summary.effort, 'low');
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

  test('an append with parentItemId nests under the parent tool item', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 't1' },
    });

    const items = state.byId['s1'].items;
    assert.strictEqual(items.length, 1, 'the child is not a top-level item');
    assert.strictEqual((items[0] as { children?: unknown[] }).children?.length, 1);
  });

  test('a replace with parentItemId settles the child in place', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 't1' },
    });
    state = reduce(state, {
      t: 'session-patch', id: 's1',
      patch: { op: 'replace', item: { ...child, state: 'ok' as const }, parentItemId: 't1' },
    });

    const children = (state.byId['s1'].items[0] as { children: { state: string }[] }).children;
    assert.strictEqual(children.length, 1, 'settled in place, not appended again');
    assert.strictEqual(children[0].state, 'ok');
  });

  test('a child whose parent is not in the loaded window is promoted to top-level', () => {
    const child = {
      id: 't2', ts: 2, role: 'tool' as const, toolId: 'c1', name: 'Read',
      input: {}, state: 'running' as const,
    };
    const state = reduce(hydrated(), {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: child, parentItemId: 'gone' },
    });
    assert.strictEqual(state.byId['s1'].items.length, 1);
    assert.strictEqual(state.byId['s1'].items[0].id, 't2');
  });

  test('a nested pending permission still reaches the pane pending list', () => {
    const parent = {
      id: 't1', ts: 1, role: 'tool' as const, toolId: 'task1', name: 'Task',
      input: {}, state: 'running' as const,
    };
    const perm = {
      id: 'p1', ts: 2, role: 'permission' as const, requestId: 'r1', name: 'Bash',
      input: {}, state: 'pending' as const,
    };
    let state = reduce(hydrated(), { t: 'session-patch', id: 's1', patch: { op: 'append', item: parent } });
    state = reduce(state, {
      t: 'session-patch', id: 's1', patch: { op: 'append', item: perm, parentItemId: 't1' },
    });
    assert.strictEqual(state.byId['s1'].pending.length, 1);
  });

  test('session-mcp replaces the pane server list wholesale', () => {
    let state = reduce(hydrated(), {
      t: 'session-mcp', id: 's1', servers: [{ name: 'github', state: 'pending' }],
    });
    state = reduce(state, {
      t: 'session-mcp', id: 's1',
      servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
    });
    assert.deepStrictEqual(state.byId['s1'].mcpServers, [
      { name: 'github', state: 'connected', toolCount: 12 },
    ]);
  });

  test('session-mcp for an unknown session is ignored', () => {
    const before = hydrated();
    const after = reduce(before, { t: 'session-mcp', id: 'nope', servers: [] });
    assert.strictEqual(after, before);
  });

  test('a snapshot carries invocables onto the pane', () => {
    const state = reduce(initialState, {
      t: 'session-snapshot',
      session: { ...snapshot('s1'), invocables: [{ name: 'init' }] },
    });

    assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'init' }]);
  });

  test('session-invocables replaces the pane list wholesale', () => {
    let state = reduce(initialState, {
      t: 'session-snapshot',
      session: { ...snapshot('s1'), invocables: [{ name: 'a' }, { name: 'b' }] },
    });
    state = reduce(state, { t: 'session-invocables', id: 's1', entries: [{ name: 'c' }] });

    assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'c' }]);
  });

  test('session-invocables for an unknown pane is a no-op', () => {
    const state = reduce(initialState, {
      t: 'session-invocables', id: 'nope', entries: [{ name: 'a' }],
    });

    assert.deepStrictEqual(state.byId, {});
  });

  test('hydrate carries invocables onto each pane', () => {
    const state = reduce(initialState, {
      t: 'hydrate',
      sessions: [summary('s1')],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
      snapshots: [{ ...snapshot('s1'), invocables: [{ name: 'init' }] }],
      catalog: [],
    });

    assert.deepStrictEqual(state.byId['s1'].invocables, [{ name: 'init' }]);
  });
  
  test('editor-context replaces the client-wide context', () => {
    const ctx = { path: 'src/a.ts', languageId: 'typescript' };
    const next = reduce(initialState, { t: 'editor-context', ctx });
    assert.deepStrictEqual(next.editorContext, ctx);

    const cleared = reduce(next, { t: 'editor-context', ctx: null });
    assert.strictEqual(cleared.editorContext, null);
  });

  test('catalog replaces the provider/model catalog wholesale', () => {
    const seeded = reduce(initialState, {
      t: 'catalog',
      catalog: [{ id: 'claude', displayName: 'Claude', models: [{ id: 'haiku', displayName: 'Haiku 4.5' }] }],
    });
    const next = reduce(seeded, {
      t: 'catalog',
      catalog: [{
        id: 'claude', displayName: 'Claude',
        models: [{ id: 'claude-fable-5', displayName: 'Fable 5' }],
      }],
    });

    assert.deepStrictEqual(next.catalog, [{
      id: 'claude', displayName: 'Claude',
      models: [{ id: 'claude-fable-5', displayName: 'Fable 5' }],
    }]);
  });

  test('the initial state has no editor context', () => {
    assert.strictEqual(initialState.editorContext, null);
  });

  test('context-breakdown is stored under its session id', () => {
    let state = withSession('s1');
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: {
        ok: true,
        breakdown: {
          systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
          memoryFiles: [],
        },
      },
    });

    const result = state.contextBySession['s1'];
    if (!result?.ok) { assert.fail('expected a stored ok breakdown'); }
    assert.strictEqual(result.breakdown.freePercent, 57);
  });

  test('a context-breakdown for a session the roster does not name is ignored', () => {
    // `request-context` and its reply are two round trips apart, so a
    // session deleted in between would otherwise have its breakdown cached
    // after the `sessions-changed` that should have pruned it.
    const state = withSession('s1');
    const after = reduce(state, {
      t: 'context-breakdown', id: 'gone',
      result: { ok: false, reason: 'This session is not running' },
    });

    assert.strictEqual(after, state, 'an unknown session must not even re-create state');
    assert.strictEqual(after.contextBySession['gone'], undefined);
  });

  test('usage-windows replaces a provider entry wholesale', () => {
    let state = reduce(initialState, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    state = reduce(state, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'seven-day', label: 'Week', usedPercent: 18 }],
    });
    assert.deepStrictEqual(state.usageByProvider.fake, [
      { id: 'seven-day', label: 'Week', usedPercent: 18 },
    ]);
  });

  test('an empty set is stored, not ignored — it is how a set clears', () => {
    let state = reduce(initialState, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    state = reduce(state, { t: 'usage-windows', providerId: 'fake', windows: [] });
    assert.deepStrictEqual(state.usageByProvider.fake, []);
  });

  test('sessions-changed prunes cached breakdowns for removed sessions', () => {
    let state = withSession('s1');
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: { ok: false, reason: 'This session is not running' },
    });
    state = reduce(state, { t: 'sessions-changed', sessions: [] });

    assert.strictEqual(state.contextBySession['s1'], undefined);
  });

  test('sessions-changed updates contextPercent without clearing the cached breakdown', () => {
    let state = withSession('s1');
    state = reduce(state, {
      t: 'context-breakdown', id: 's1',
      result: {
        ok: true,
        breakdown: {
          systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
          memoryFiles: [],
        },
      },
    });
    state = reduce(state, {
      t: 'sessions-changed',
      sessions: [summary('s1', { contextPercent: 43 })],
    });

    assert.strictEqual(state.sessions[0].contextPercent, 43);
    assert.strictEqual(state.contextBySession['s1']?.ok, true);
  });
});
