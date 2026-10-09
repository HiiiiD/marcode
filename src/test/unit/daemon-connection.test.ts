import * as assert from 'node:assert';
import { DaemonConnection, type ConnectionDeps, type FrameSocket } from '../../daemon/connection';
import { encodeFrame } from '../../daemon/protocol';
import type { createRemoteHooks } from '../../daemon/remote-hooks';
import type { ServerFrame } from '../../protocol/daemon-wire';
import type { PostClient } from '../../host/post-bus';

class FakeSocket implements FrameSocket {
  out: ServerFrame[] = [];
  ended = false;
  bytes = 0;
  private data: (c: string) => void = () => {};
  private close: () => void = () => {};
  write(d: string) { this.out.push(JSON.parse(d) as ServerFrame); return true; }
  end() { this.ended = true; this.close(); }
  buffered() { return this.bytes; }
  onData(cb: (c: string) => void) { this.data = cb; }
  onClose(cb: () => void) { this.close = cb; }
  feed(f: object | string) { this.data(typeof f === 'string' ? f : encodeFrame(f as never)); }
}

const HELLO = { f: 'hello', protocolVersion: 1, appVersion: '1', clientKind: 'tui', token: 'tok', roots: ['/r'], defaultCwd: '/r' };

function setup(over: Partial<ConnectionDeps> = {}) {
  const sock = new FakeSocket();
  const handled: unknown[] = [];
  const bus: PostClient[] = [];
  const state = { shutdown: 0, roots: [] as string[][], rootsDropped: 0, changes: 0 };
  let hooks: ReturnType<typeof createRemoteHooks> | undefined;
  const deps: ConnectionDeps = {
    token: 'tok', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [],
    isBusy: () => false,
    makeRouter: (_emit, h) => { hooks = h; return { handle: async (m) => { handled.push(m); } }; },
    addToBus: (c) => { bus.push(c); return () => { bus.splice(bus.indexOf(c), 1); }; },
    onRoots: (r) => { state.roots.push(r); return () => { state.rootsDropped++; }; },
    onShutdown: () => { state.shutdown++; },
    onChange: () => { state.changes++; },
    ...over,
  };
  const conn = new DaemonConnection(sock, deps);
  return { sock, conn, handled, bus, state, hooks: () => hooks };
}

suite('daemon connection', () => {
  test('a valid hello is welcomed and registered on the bus', () => {
    const t = setup();
    t.sock.feed(HELLO);
    assert.strictEqual(t.sock.out[0].f, 'welcome');
    assert.strictEqual(t.bus.length, 1);
    assert.deepStrictEqual(t.state.roots, [['/r']]);
  });

  test('the welcome carries the login recipes and a client id', () => {
    const recipe = { id: 'claude', terminalName: 'Claude login', command: 'claude login', env: {} };
    const t = setup({ loginRecipes: [recipe] });
    t.sock.feed(HELLO);
    const w = t.sock.out[0] as Extract<ServerFrame, { f: 'welcome' }>;
    assert.deepStrictEqual(w.loginRecipes, [recipe]);
    assert.strictEqual(typeof w.clientId === 'string' && w.clientId.length > 0, true);
    assert.strictEqual(t.conn.kind, 'tui');
    assert.strictEqual(t.conn.attached, true);
  });

  test('anything before hello is rejected and closed', () => {
    const t = setup();
    t.sock.feed({ f: 'msg', m: { t: 'ready' } });
    assert.deepStrictEqual(t.sock.out[0], { f: 'reject', reason: 'bad-hello', daemon: { protocolVersion: 1, appVersion: '1' } });
    assert.strictEqual(t.sock.ended, true);
  });

  test('a wrong token and a wrong protocol version are rejected distinctly', () => {
    const a = setup(); a.sock.feed({ ...HELLO, token: 'nope' });
    assert.strictEqual((a.sock.out[0] as { reason: string }).reason, 'bad-token');
    assert.strictEqual(a.sock.ended, true);
    assert.strictEqual(a.bus.length, 0);
    assert.strictEqual(a.state.roots.length, 0);
    const b = setup(); b.sock.feed({ ...HELLO, protocolVersion: 9 });
    assert.deepStrictEqual(b.sock.out[0], { f: 'reject', reason: 'protocol-mismatch', daemon: { protocolVersion: 1, appVersion: '1' } });
    assert.strictEqual(b.bus.length, 0);
    assert.strictEqual(b.state.roots.length, 0);
  });

  test('msg frames reach the router after hello', async () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.feed({ f: 'msg', m: { t: 'ready' } });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(t.handled, [{ t: 'ready' }]);
  });

  test('a failing handler does not become an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const origError = console.error;
    console.error = () => {};
    try {
      const t = setup({ makeRouter: () => ({ handle: async () => { throw new Error('boom'); } }) });
      t.sock.feed(HELLO);
      t.sock.feed({ f: 'msg', m: { t: 'ready' } });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(unhandled.length, 0);
      assert.strictEqual(t.sock.ended, false);
    } finally {
      console.error = origError;
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('garbage closes this connection and nothing else', () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.feed('this is not json\n');
    assert.strictEqual(t.sock.ended, true);
    assert.strictEqual(t.bus.length, 0);
    assert.strictEqual(t.state.rootsDropped, 1);
  });

  test('an oversized line closes the connection', () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.feed('x'.repeat(64 * 1024 * 1024 + 1));
    assert.strictEqual(t.sock.ended, true);
    assert.strictEqual(t.bus.length, 0);
  });

  test('a frame split across two chunks is reassembled', () => {
    const t = setup();
    const line = encodeFrame(HELLO as never);
    t.sock.feed(line.slice(0, 10));
    t.sock.feed(line.slice(10));
    assert.strictEqual(t.sock.out[0].f, 'welcome');
  });

  test('shutdown with the token is refused while busy and honoured while idle', () => {
    const busy = setup({ isBusy: () => true });
    busy.sock.feed({ f: 'shutdown', token: 'tok' });
    assert.deepStrictEqual(busy.sock.out[0], { f: 'refuse', reason: 'busy' });
    assert.strictEqual(busy.state.shutdown, 0);
    const idle = setup();
    idle.sock.feed({ f: 'shutdown', token: 'tok' });
    assert.strictEqual(idle.sock.out[0].f, 'bye');
    assert.strictEqual(idle.state.shutdown, 1);
    const bad = setup();
    bad.sock.feed({ f: 'shutdown', token: 'x' });
    assert.deepStrictEqual(bad.sock.out[0], { f: 'refuse', reason: 'bad-token' });
  });

  test('a bus post to a client more than the cap behind drops it', () => {
    const t = setup({ maxBuffered: 100 });
    t.sock.feed(HELLO);
    t.sock.bytes = 101;
    t.bus[0].post({ t: 'sessions-changed', sessions: [] } as never);
    assert.strictEqual(t.sock.ended, true);
  });

  test('closing removes the bus registration and the roots', () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.end();
    assert.strictEqual(t.bus.length, 0);
    assert.strictEqual(t.state.rootsDropped, 1);
    assert.strictEqual(t.conn.attached, false);
    t.conn.close();
    assert.strictEqual(t.state.rootsDropped, 1);
  });

  test('ctx feeds the editor context and res settles a pending req', async () => {
    const t = setup();
    t.sock.feed(HELLO);
    const ctx = { path: '/r/a.ts', selection: null };
    t.sock.feed({ f: 'ctx', ctx });
    assert.deepStrictEqual(t.hooks()?.editor.current(), ctx);
    const picked = t.hooks()!.picker.pick();
    const req = t.sock.out.find((f) => f.f === 'req') as Extract<ServerFrame, { f: 'req' }>;
    assert.strictEqual(req.op, 'pick');
    t.sock.feed({ f: 'res', id: req.id, ok: true, result: ['/r/a.ts'] });
    assert.deepStrictEqual(await picked, ['/r/a.ts']);
  });

  test('a close with a pending ask resolves it empty', async () => {
    const t = setup();
    t.sock.feed(HELLO);
    const picked = t.hooks()!.picker.pick();
    t.sock.end();
    assert.deepStrictEqual(await picked, []);
  });
});
