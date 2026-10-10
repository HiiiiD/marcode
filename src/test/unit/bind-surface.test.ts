import * as assert from 'node:assert';
import { bindSurface } from '../../host/bind-surface';
import type { SurfaceLink } from '../../host/surface-link';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

function fakeWebview() {
  let handler: ((raw: WebviewToHost) => void) | undefined;
  const posted: HostToWebview[] = [];
  return {
    webview: {
      onDidReceiveMessage: (h: (raw: WebviewToHost) => void) => { handler = h; return { dispose: () => { handler = undefined; } }; },
      postMessage: async (m: HostToWebview) => { posted.push(m); return true; },
    },
    send: (raw: WebviewToHost) => handler?.(raw),
    posted,
    attached: () => handler !== undefined,
  };
}

function fakeLink() {
  const sent: WebviewToHost[] = [];
  let listener: ((m: HostToWebview) => void) | undefined;
  let disposed = 0;
  const link: SurfaceLink = {
    transport: { post: (m) => { sent.push(m); }, onMessage: (l) => { listener = l; return () => { listener = undefined; }; } },
    onStatus: () => () => {}, pushContext: () => {}, dispose: () => { disposed++; },
  };
  return { link, sent, emit: (m: HostToWebview) => listener?.(m), disposed: () => disposed, listening: () => listener !== undefined };
}

const tick = () => new Promise((r) => setImmediate(r));

suite('bind surface', () => {
  test('messages sent before the link exists are delivered in order once it does', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    let resolve!: (link: SurfaceLink) => void;
    bindSurface(w.webview as never, () => new Promise((r) => { resolve = r; }), {});
    w.send({ t: 'ready' });
    w.send({ t: 'set-visible', sessionIds: [] });
    assert.strictEqual(l.sent.length, 0);
    resolve(l.link);
    await tick();
    assert.deepStrictEqual(l.sent.map((m) => m.t), ['ready', 'set-visible']);
    w.send({ t: 'refresh-usage' } as never);
    await tick();
    assert.deepStrictEqual(l.sent.map((m) => m.t), ['ready', 'set-visible', 'refresh-usage']);
  });

  test('host messages reach the webview and the handler sees them first', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    const seen: string[] = [];
    bindSurface(w.webview as never, async () => l.link, { onHostMessage: (m) => { seen.push(m.t); } });
    await tick();
    l.emit({ t: 'sessions-changed' } as never);
    assert.deepStrictEqual(seen, ['sessions-changed']);
    assert.deepStrictEqual(w.posted.map((m) => m.t), ['sessions-changed']);
  });

  test('a handler can replace a host message before it is posted', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    bindSurface(w.webview as never, async () => l.link, {
      onHostMessage: (m) => (m.t === 'memory-status' ? { ...m, enabled: false } : undefined),
    });
    await tick();
    l.emit({ t: 'memory-status', enabled: true, llm: false });
    l.emit({ t: 'sessions-changed' } as never);
    assert.deepStrictEqual(w.posted, [{ t: 'memory-status', enabled: false, llm: false }, { t: 'sessions-changed' }]);
  });

  test('an intercepted message is not forwarded', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    bindSurface(w.webview as never, async () => l.link, { intercept: async (raw) => raw.t === 'open-review' });
    await tick();
    w.send({ t: 'open-review' });
    w.send({ t: 'ready' });
    await tick();
    assert.deepStrictEqual(l.sent.map((m) => m.t), ['ready']);
  });

  test('disposing before the link arrives disposes the late link instead of leaking it', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    let resolve!: (link: SurfaceLink) => void;
    const b = bindSurface(w.webview as never, () => new Promise((r) => { resolve = r; }), {});
    b.dispose();
    resolve(l.link);
    await tick();
    assert.strictEqual(l.disposed(), 1);
    assert.strictEqual(l.listening(), false);
    assert.strictEqual(w.attached(), false);
  });

  test('disposing after the link arrived disposes it once', async () => {
    const w = fakeWebview();
    const l = fakeLink();
    const b = bindSurface(w.webview as never, async () => l.link, {});
    await tick();
    b.dispose();
    b.dispose();
    assert.strictEqual(l.disposed(), 1);
  });

  test('a failing connect does not throw', async () => {
    const w = fakeWebview();
    bindSurface(w.webview as never, async () => { throw new Error('nope'); }, {});
    w.send({ t: 'ready' });
    await tick();
  });
});
