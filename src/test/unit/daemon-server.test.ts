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
  const make = (helloTimeoutMs?: number) => new DaemonServer({
    endpoint, bus, helloTimeoutMs,
    connectionDeps: {
      token: 'tok', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [],
      isBusy: () => false,
      makeRouter: () => { if (throwOnRouter) { throw new Error('boom'); } return { handle: async () => {} }; },
      onShutdown: () => {}, onChange: () => {},
    },
  });
  setup(async () => {
    throwOnRouter = false;
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
});
