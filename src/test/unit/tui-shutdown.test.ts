import * as assert from 'node:assert';
import { createShutdown, installExitSignals } from '../../tui/shutdown';

function fakes(over: { destroy?: () => void; dispose?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    destroyRenderer: () => { calls.push('destroy'); over.destroy?.(); },
    disposeHost: () => { calls.push('dispose'); return over.dispose ? over.dispose() : Promise.resolve(); },
    exit: (code) => { calls.push(`exit ${code}`); exits.push(code); },
    timeoutMs: 20,
  });
  return { calls, exits, shutdown };
}

suite('tui shutdown', () => {
  test('destroys the renderer before disposing the host, then exits with the code', async () => {
    const f = fakes();
    await f.shutdown(0);
    assert.deepStrictEqual(f.calls, ['destroy', 'dispose', 'exit 0']);
  });

  test('a hanging dispose is cut off by the timeout', async () => {
    const f = fakes({ dispose: () => new Promise<void>(() => {}) });
    await f.shutdown(143);
    assert.deepStrictEqual(f.exits, [143]);
  });

  test('a throwing renderer destroy still disposes and exits', async () => {
    const f = fakes({ destroy: () => { throw new Error('tty gone'); } });
    await f.shutdown(1);
    assert.deepStrictEqual(f.calls, ['destroy', 'dispose', 'exit 1']);
  });

  test('a rejecting or synchronously throwing dispose still exits', async () => {
    const rejecting = fakes({ dispose: () => Promise.reject(new Error('boom')) });
    await rejecting.shutdown(1);
    assert.deepStrictEqual(rejecting.exits, [1]);
    const throwing = fakes({ dispose: () => { throw new Error('sync boom'); } });
    await throwing.shutdown(1);
    assert.deepStrictEqual(throwing.exits, [1]);
  });

  test('a second call during shutdown exits 130 at once', async () => {
    const f = fakes({ dispose: () => new Promise<void>(() => {}) });
    const first = f.shutdown(0);
    await f.shutdown(0);
    assert.deepStrictEqual(f.exits, [130]);
    await first;
    assert.deepStrictEqual(f.exits, [130, 0]);
    assert.strictEqual(f.calls.filter((c) => c === 'destroy').length, 1);
  });

  test('calls after completion are no-ops', async () => {
    const f = fakes();
    await f.shutdown(0);
    await f.shutdown(1);
    assert.deepStrictEqual(f.exits, [0]);
  });
});

suite('tui shutdown ifIdle and signals', () => {
  test('ifIdle runs the whole sequence when nothing started it', async () => {
    const f = fakes();
    await f.shutdown.ifIdle(1);
    assert.deepStrictEqual(f.calls, ['destroy', 'dispose', 'exit 1']);
  });

  test('ifIdle during a shutdown it did not start is ignored, not a forced 130', async () => {
    const f = fakes({ dispose: () => new Promise<void>(() => {}) });
    const first = f.shutdown(0);
    await f.shutdown.ifIdle(1);
    await first;
    assert.deepStrictEqual(f.exits, [0]);
  });

  test('every exit signal goes through the one shutdown with its own code', () => {
    const handlers = new Map<string, () => void>();
    const codes: number[] = [];
    installExitSignals((sig, fn) => { handlers.set(sig, fn); }, (code) => { codes.push(code); return Promise.resolve(); });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGBREAK']) { handlers.get(sig)?.(); }
    assert.deepStrictEqual(codes, [130, 143, 129, 131, 149]);
  });

  test('a signal the platform refuses to listen for is skipped, not fatal', () => {
    const installed: string[] = [];
    installExitSignals((sig) => { if (sig === 'SIGQUIT') { throw new Error('ENOSYS'); } installed.push(sig); }, () => Promise.resolve());
    assert.deepStrictEqual(installed, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
  });
});
