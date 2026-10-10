import * as fs from 'node:fs';
import * as assert from 'node:assert';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonServer } from '../../daemon/daemon-server';
import { endpointFor } from '../../daemon/endpoint';
import { encodeFrame, LineDecoder } from '../../daemon/protocol';
import { PostBus } from '../../host/post-bus';

const HELLO = (kind: string, roots: string[]) => ({
  f: 'hello', protocolVersion: 1, appVersion: '1', clientKind: kind, token: 'tok', roots, defaultCwd: roots[0] ?? '/',
});

function client(endpoint: string): Promise<{ sock: net.Socket; frames: any[]; send(f: object): void; closed(): boolean }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    const frames: any[] = [];
    let closed = false;
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => { for (const l of dec.push(c)) { frames.push(JSON.parse(l)); } });
    sock.on('close', () => { closed = true; });
    sock.once('connect', () => resolve({ sock, frames, closed: () => closed, send: (f) => { sock.write(encodeFrame(f as never)); } }));
    sock.once('error', reject);
  });
}
const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) { await new Promise((r) => setTimeout(r, 10)); } };

suite('daemon server', () => {
  let server: DaemonServer;
  let bus: PostBus;
  let endpoint: string;
  let throwOnRouter = false;
  let throwOnChange = false;
  const make = (helloTimeoutMs?: number) => new DaemonServer({
    endpoint, bus, helloTimeoutMs,
    connectionDeps: {
      token: 'tok', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [],
      isBusy: () => false,
      makeRouter: () => { if (throwOnRouter) { throw new Error('boom'); } return { handle: async () => {} }; },
      onShutdown: () => {}, onChange: () => { if (throwOnChange) { throw new Error('change boom'); } },
    },
  });
  setup(async () => {
    throwOnRouter = false;
    throwOnChange = false;
    bus = new PostBus();
    endpoint = endpointFor(path.join(os.tmpdir(), `mar-srv-${process.pid}-${Date.now()}-${Math.random()}`));
    server = make();
    await server.listen();
  });
  teardown(async () => { await server.close(); });

  test('two clients attach; a bus post reaches only the one whose kind wants it', async () => {
    const tui = await client(endpoint);
    const review = await client(endpoint);
    tui.send(HELLO('tui', ['/a']));
    review.send(HELLO('review', ['/b']));
    await until(() => tui.frames.length > 0 && review.frames.length > 0);
    assert.strictEqual(server.clientCount(), 2);
    assert.deepStrictEqual(server.roots().sort(), ['/a', '/b']);
    bus.post({ t: 'session-patch' } as never);
    await until(() => tui.frames.length > 1);
    assert.strictEqual(tui.frames.some((f) => f.f === 'msg'), true);
    assert.strictEqual(review.frames.some((f) => f.f === 'msg'), false);
    tui.sock.destroy(); review.sock.destroy();
  });

  test('broadcastAct reaches only attached clients of that kind, and is a no-op with none', async () => {
    server.broadcastAct('sidebar', 'notify', ['warn', 'early']);
    const sidebar = await client(endpoint);
    const review = await client(endpoint);
    sidebar.send(HELLO('sidebar', ['/a']));
    review.send(HELLO('review', ['/a']));
    await until(() => sidebar.frames.length > 0 && review.frames.length > 0);
    server.broadcastAct('sidebar', 'notify', ['warn', 'hi']);
    await until(() => sidebar.frames.some((f) => f.f === 'act'));
    assert.deepStrictEqual(sidebar.frames.filter((f) => f.f === 'act').map((f) => [f.op, f.args]), [['notify', ['warn', 'hi']]]);
    assert.strictEqual(review.frames.some((f) => f.f === 'act'), false);
    sidebar.sock.destroy(); review.sock.destroy();
  });

  test('a client sending garbage does not disturb another', async () => {
    const good = await client(endpoint);
    const bad = await client(endpoint);
    good.send(HELLO('tui', ['/a']));
    bad.sock.write('{{{{ not json\n');
    await until(() => good.frames.length > 0);
    await until(() => server.clientCount() === 1);
    assert.strictEqual(server.clientCount(), 1);
    bus.post({ t: 'session-patch' } as never);
    await until(() => good.frames.length > 1);
    assert.strictEqual(good.frames.length > 1, true);
    good.sock.destroy();
  });

  test('closing a client drops its roots and count', async () => {
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => server.clientCount() === 1);
    c.sock.destroy();
    await until(() => server.clientCount() === 0);
    assert.deepStrictEqual(server.roots(), []);
  });

  test('onRootsChanged fires when a client attaches and leaves', async () => {
    let calls = 0;
    server.onRootsChanged(() => { calls++; });
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => calls >= 1);
    c.sock.destroy();
    await until(() => calls >= 2);
    assert.strictEqual(calls >= 2, true);
  });

  test('a throwing dep does not kill the server; other clients keep working', async () => {
    throwOnRouter = true;
    const bad = await client(endpoint);
    bad.send(HELLO('tui', ['/x']));
    await until(() => bad.closed());
    assert.strictEqual(bad.closed(), true);
    throwOnRouter = false;
    const good = await client(endpoint);
    good.send(HELLO('tui', ['/a']));
    await until(() => good.frames.some((f) => f.f === 'welcome'));
    assert.strictEqual(good.frames.some((f) => f.f === 'welcome'), true);
    assert.strictEqual(server.clientCount(), 1);
    good.sock.destroy();
  });

  test('clientCount excludes an un-helloed socket, and it is closed after the deadline', async () => {
    await server.close();
    server = make(80);
    await server.listen();
    const idle = await client(endpoint);
    const good = await client(endpoint);
    good.send(HELLO('tui', ['/a']));
    await until(() => good.frames.length > 0);
    assert.strictEqual(server.clientCount(), 1);
    await until(() => idle.closed());
    assert.strictEqual(idle.closed(), true);
    assert.strictEqual(good.closed(), false);
    assert.strictEqual(server.clientCount(), 1);
    good.sock.destroy();
  });

  test('close() ends connections and is idempotent', async () => {
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => server.clientCount() === 1);
    await server.close();
    await server.close();
    await until(() => c.closed());
    assert.strictEqual(c.closed(), true);
    assert.strictEqual(server.clientCount(), 0);
  });

  test('close() really waits: the client sees the close and the endpoint is reusable at once', async () => {
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => server.clientCount() === 1);
    await server.close();
    const again = make();
    await again.listen();
    await until(() => c.closed());
    assert.strictEqual(c.closed(), true);
    await again.close();
  });

  test('close() before listen resolves', async () => {
    const fresh = make();
    await fresh.close();
    await fresh.close();
  });

  test('a server error event does not crash and the server still accepts clients', async () => {
    (server as unknown as { server: net.Server }).server.emit('error', new Error('x'));
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => c.frames.some((f) => f.f === 'welcome'));
    assert.strictEqual(c.frames.some((f) => f.f === 'welcome'), true);
    c.sock.destroy();
  });

  test('a throwing onChange on detach does not take the server down', async () => {
    const a = await client(endpoint);
    const b = await client(endpoint);
    a.send(HELLO('tui', ['/a']));
    b.send(HELLO('tui', ['/b']));
    await until(() => server.clientCount() === 2);
    throwOnChange = true;
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    throwOnChange = false;
    bus.post({ t: 'session-patch' } as never);
    await until(() => b.frames.some((f) => f.f === 'msg'));
    assert.strictEqual(b.frames.some((f) => f.f === 'msg'), true);
    b.sock.destroy();
  });

  test('a pre-existing loose socket dir owned by us is tightened to 0700 (POSIX)', async function () {
    if (process.platform === 'win32') { this.skip(); }
    await server.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dir-'));
    fs.chmodSync(dir, 0o777);
    endpoint = path.join(dir, 's.sock');
    server = make();
    await server.listen();
    assert.strictEqual((fs.statSync(dir).mode & 0o777).toString(8), '700');
  });
});
