import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { createDraftStore } from '../../webview/lib/draft-store';
import type { SessionId } from '../../protocol/messages';

const A = 'a' as SessionId;
const B = 'b' as SessionId;

suite('draft store', () => {
  test('get on an unset id reads empty, not undefined', () => {
    const store = createDraftStore();
    assert.strictEqual(store.get(A), '');
  });

  test('set stores per-id text and notifies only that id\'s subscribers', () => {
    const store = createDraftStore();
    let aCalls = 0;
    let bCalls = 0;
    store.subscribe(A, () => { aCalls += 1; });
    store.subscribe(B, () => { bCalls += 1; });

    store.set(A, 'hello');

    assert.strictEqual(store.get(A), 'hello');
    assert.strictEqual(store.get(B), '');
    assert.strictEqual(aCalls, 1);
    assert.strictEqual(bCalls, 0);
  });

  test('hydrate replaces the whole map and notifies every touched id', () => {
    const store = createDraftStore();
    store.set(A, 'stale');
    let aCalls = 0;
    let bCalls = 0;
    store.subscribe(A, () => { aCalls += 1; });
    store.subscribe(B, () => { bCalls += 1; });

    // 'a' drops out of the hydrate payload (host says no draft survived);
    // 'b' is new. Both must be notified — 'a' because its value changed
    // (to empty), 'b' because it gained one.
    store.hydrate([[B, 'fresh']]);

    assert.strictEqual(store.get(A), '');
    assert.strictEqual(store.get(B), 'fresh');
    assert.strictEqual(aCalls, 1);
    assert.strictEqual(bCalls, 1);
  });

  test('unsubscribe stops further notifications', () => {
    const store = createDraftStore();
    let calls = 0;
    const off = store.subscribe(A, () => { calls += 1; });
    off();

    store.set(A, 'x');

    assert.strictEqual(calls, 0);
  });
});
