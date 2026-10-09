import * as assert from 'node:assert';
import { IdleMonitor, isBusy } from '../../daemon/idle-monitor';

suite('daemon idle monitor', () => {
  const harness = () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const state = { busy: false, clients: 0, idled: 0 };
    const mon = new IdleMonitor({
      busy: () => state.busy, clients: () => state.clients, idleMs: 600_000, onIdle: () => { state.idled++; },
      setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimer: (h) => { (h as { live: boolean }).live = false; },
    });
    const fire = () => { for (const t of timers) { if (t.live) { t.live = false; t.fn(); } } };
    return { mon, state, timers, fire };
  };

  test('idle with no clients fires onIdle after the timeout', () => {
    const h = harness();
    h.mon.check();
    assert.strictEqual(h.timers[0].ms, 600_000);
    h.fire();
    assert.strictEqual(h.state.idled, 1);
  });

  test('a client attaching cancels the pending exit', () => {
    const h = harness();
    h.mon.check();
    h.state.clients = 1;
    h.mon.check();
    h.fire();
    assert.strictEqual(h.state.idled, 0);
  });

  test('a busy session cancels it, and going idle again restarts it', () => {
    const h = harness();
    h.state.busy = true;
    h.mon.check();
    assert.strictEqual(h.timers.length, 0);
    h.state.busy = false;
    h.mon.check();
    h.fire();
    assert.strictEqual(h.state.idled, 1);
  });

  test('state that turned busy between schedule and fire is re-checked', () => {
    const h = harness();
    h.mon.check();
    h.state.busy = true;
    h.fire();
    assert.strictEqual(h.state.idled, 0);
  });

  test('check() twice does not stack timers', () => {
    const h = harness();
    h.mon.check();
    h.mon.check();
    assert.strictEqual(h.timers.length, 1);
  });

  test('isBusy: running, awaiting-approval count; idle and error do not', () => {
    assert.strictEqual(isBusy([{ status: 'idle' }, { status: 'error' }]), false);
    assert.strictEqual(isBusy([{ status: 'idle' }, { status: 'running' }]), true);
    assert.strictEqual(isBusy([{ status: 'awaiting-approval' }]), true);
  });
});
