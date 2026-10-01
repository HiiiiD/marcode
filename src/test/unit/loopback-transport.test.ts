import * as assert from 'node:assert';
import { createLoopback } from '../../client-core/loopback-transport';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

suite('loopback transport', () => {
  test('post reaches the handler, deliver reaches every listener, off unsubscribes', () => {
    const handled: WebviewToHost[] = [];
    const { transport, deliver } = createLoopback((m) => { handled.push(m); });
    const a: HostToWebview[] = [];
    const b: HostToWebview[] = [];
    const offA = transport.onMessage((m) => a.push(m));
    transport.onMessage((m) => b.push(m));
    transport.post({ t: 'ready' });
    deliver({ t: 'usage-refresh-done' });
    offA();
    deliver({ t: 'usage-refresh-done' });
    assert.deepStrictEqual(handled, [{ t: 'ready' }]);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 2);
  });

  test('a rejecting handler never surfaces as an unhandled rejection', async () => {
    const { transport } = createLoopback(async () => { throw new Error('boom'); });
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRejection);
    const origError = console.error;
    console.error = () => {};
    transport.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    console.error = origError;
    process.off('unhandledRejection', onRejection);
    assert.strictEqual(seen.length, 0);
  });
});
