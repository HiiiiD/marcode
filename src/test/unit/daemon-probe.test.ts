import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonServer } from '../../daemon/daemon-server';
import { probeEndpoint, type ProbeSocket } from '../../daemon/probe-endpoint';
import { PostBus } from '../../host/post-bus';

class FakeSocket extends EventEmitter implements ProbeSocket {
  destroyed = false;
  destroy(): void { this.destroyed = true; }
}

const fake = (act: (s: FakeSocket) => void) => {
  const sockets: FakeSocket[] = [];
  const connect = () => {
    const s = new FakeSocket();
    sockets.push(s);
    setImmediate(() => act(s));
    return s;
  };
  return { connect, sockets };
};
const errno = (code: string) => Object.assign(new Error(code), { code });
const pipeOrSock = (dir: string) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\marcode-probe-${process.pid}-${Date.now()}`
  : path.join(dir, 'probe.sock'));

suite('daemon endpoint probe', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-probe-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('a connect means the endpoint is live', async () => {
    const f = fake((s) => s.emit('connect'));
    assert.strictEqual(await probeEndpoint('x', { connect: f.connect }), 'live');
    assert.strictEqual(f.sockets[0].destroyed, true);
  });

  test('only a refused or missing endpoint is free', async () => {
    for (const code of ['ECONNREFUSED', 'ENOENT']) {
      const f = fake((s) => s.emit('error', errno(code)));
      assert.strictEqual(await probeEndpoint('x', { connect: f.connect }), 'free', code);
    }
    const denied = fake((s) => s.emit('error', errno('EACCES')));
    assert.strictEqual(await probeEndpoint('x', { connect: denied.connect }), 'unknown');
  });

  test('silence until the timeout is not free', async () => {
    const f = fake(() => {});
    assert.strictEqual(await probeEndpoint('x', { connect: f.connect, timeoutMs: 20 }), 'unknown');
    assert.strictEqual(f.sockets[0].destroyed, true);
  });

  test('a real listening endpoint is live, and free once it closes', async () => {
    const endpoint = pipeOrSock(dir);
    const server = net.createServer((s) => { s.destroy(); });
    await new Promise<void>((r) => server.listen(endpoint, r));
    assert.strictEqual(await probeEndpoint(endpoint), 'live');
    await new Promise((r) => server.close(r));
    assert.strictEqual(await probeEndpoint(endpoint), 'free');
  });

  test('POSIX: listen refuses an endpoint another process serves and leaves its socket', async function () {
    if (process.platform === 'win32') { this.skip(); }
    const endpoint = path.join(dir, 'sock', 'd.sock');
    fs.mkdirSync(path.dirname(endpoint), { mode: 0o700 });
    const live = net.createServer((s) => { s.destroy(); });
    await new Promise<void>((r) => live.listen(endpoint, r));
    const rival = new DaemonServer({
      endpoint, bus: new PostBus(),
      connectionDeps: {
        token: 't', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [], isBusy: () => false,
        makeRouter: () => ({ handle: async () => {} }), onShutdown: () => {}, onChange: () => {},
      },
    });
    let error = '';
    await rival.listen().catch((e: Error) => { error = e.message; });
    assert.strictEqual(/already served/.test(error), true);
    assert.strictEqual(fs.existsSync(endpoint), true);
    assert.strictEqual(await probeEndpoint(endpoint), 'live');
    await new Promise((r) => live.close(r));
  });
});
