import * as assert from 'node:assert';
import { Notifier, type NotifierPorts, type NotifyKind } from '../../host/notifier';
import type { SessionId, SessionStatus } from '../../protocol/messages';

function setup(over: Partial<NotifierPorts> = {}) {
  const shown: { id: SessionId; kind: NotifyKind; name: string }[] = [];
  const counts: number[] = [];
  const n = new Notifier({
    isWatching: () => false,
    nameOf: (id) => `name-${id}`,
    kinds: () => ({ approval: true, finished: true, error: true }),
    show: (id, kind, name) => { shown.push({ id, kind, name }); },
    setPendingCount: (c) => { counts.push(c); },
    ...over,
  });
  const status = (id: string, s: SessionStatus) => n.onStatus(id as SessionId, s);
  return { n, shown, counts, status };
}

suite('Notifier', () => {
  test('running -> idle notifies finished', () => {
    const { shown, status } = setup();
    status('a', 'running');
    status('a', 'idle');
    assert.deepStrictEqual(shown, [{ id: 'a', kind: 'finished', name: 'name-a' }]);
  });

  test('first-seen idle does not notify', () => {
    const { shown, status } = setup();
    status('a', 'idle');
    assert.strictEqual(shown.length, 0);
  });

  test('approval and error notify', () => {
    const { shown, status } = setup();
    status('a', 'running');
    status('a', 'awaiting-approval');
    status('b', 'running');
    status('b', 'error');
    assert.deepStrictEqual(shown.map((s) => s.kind), ['approval', 'error']);
  });

  test('watched session is silent', () => {
    const { shown, status } = setup({ isWatching: () => true });
    status('a', 'running');
    status('a', 'awaiting-approval');
    assert.strictEqual(shown.length, 0);
  });

  test('disabled kind is silent', () => {
    const { shown, status } = setup({ kinds: () => ({ approval: true, finished: false, error: true }) });
    status('a', 'running');
    status('a', 'idle');
    assert.strictEqual(shown.length, 0);
  });

  test('repeat of same status does not re-notify', () => {
    const { shown, status } = setup();
    status('a', 'running');
    status('a', 'awaiting-approval');
    status('a', 'awaiting-approval');
    assert.strictEqual(shown.length, 1);
  });

  test('flapping within the window coalesces per session', () => {
    let t = 0;
    const { shown, status } = setup({ now: () => t, coalesceMs: 5000 });
    status('a', 'running');
    status('a', 'awaiting-approval');
    t = 1000;
    status('a', 'running');
    status('a', 'awaiting-approval');
    assert.strictEqual(shown.length, 1);
    t = 6000;
    status('a', 'running');
    status('a', 'awaiting-approval');
    assert.strictEqual(shown.length, 2);
  });

  test('coalescing is per session', () => {
    const { shown, status } = setup({ now: () => 0 });
    status('a', 'running'); status('a', 'idle');
    status('b', 'running'); status('b', 'idle');
    assert.strictEqual(shown.length, 2);
  });

  test('retain drops sessions no longer in the roster', () => {
    const { counts, status, n } = setup();
    status('a', 'awaiting-approval');
    status('b', 'awaiting-approval');
    n.retain(['b' as SessionId]);
    assert.strictEqual(counts[counts.length - 1], 1);
  });

  test('pending count tracks sessions awaiting approval, even watched ones', () => {
    const { counts, status, n } = setup({ isWatching: () => true });
    status('a', 'awaiting-approval');
    status('b', 'awaiting-approval');
    status('a', 'running');
    assert.deepStrictEqual(counts, [1, 2, 1]);
    n.forget('b' as SessionId);
    assert.strictEqual(counts[counts.length - 1], 0);
  });
});
