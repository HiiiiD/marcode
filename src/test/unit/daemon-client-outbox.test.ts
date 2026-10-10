import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeFrame, LineDecoder } from '../../daemon/protocol';
import { SocketDaemonClient, type ClientStatus, type DaemonClient, type Opened } from '../../daemon-client/daemon-client';
import { openLink, type HelloFrame } from '../../daemon-client/daemon-link';
import { Outbox } from '../../daemon-client/outbox';
import type { ClientFrame } from '../../protocol/daemon-wire';
import type { WebviewToHost } from '../../protocol/messages';

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};

const HELLO: HelloFrame = { f: 'hello', clientKind: 'tui', token: 't', roots: [], defaultCwd: '.', protocolVersion: 1, appVersion: 'x' };
const WELCOME = encodeFrame({ f: 'welcome', clientId: 'c', loginRecipes: [], protocolVersion: 1, appVersion: 'x' });

/** A stand-in daemon that welcomes every hello and records each connection's frames. */
class RecordingDaemon {
  readonly connections: ClientFrame[][] = [];
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(readonly endpoint: string) {}

  async start(): Promise<void> {
    const server = net.createServer((sock) => {
      const frames: ClientFrame[] = [];
      this.connections.push(frames);
      this.sockets.add(sock);
      const dec = new LineDecoder();
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('close', () => { this.sockets.delete(sock); });
      sock.on('data', (chunk: string) => {
        for (const line of dec.push(chunk)) {
          const f = JSON.parse(line) as ClientFrame;
          frames.push(f);
          if (f.f === 'hello') { sock.write(WELCOME); }
        }
      });
    });
    this.server = server;
    await new Promise<void>((r) => server.listen(this.endpoint, r));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) { s.destroy(); }
    const server = this.server;
    this.server = undefined;
    if (server) { await new Promise((r) => server.close(r)); }
  }
}

const msgs = (frames: ClientFrame[]): WebviewToHost[] =>
  frames.flatMap((f) => (f.f === 'msg' ? [f.m] : []));

suite('daemon client outbox', function () {
  this.timeout(20000);
  let dir: string;
  let daemon: RecordingDaemon;
  let clients: DaemonClient[];

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-obx-'));
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\marcode-test-outbox-${process.pid}-${Date.now()}`
      : path.join(dir, 'd.sock');
    daemon = new RecordingDaemon(endpoint);
    clients = [];
    await daemon.start();
  });
  teardown(async () => {
    for (const c of clients) { c.close(); }
    await daemon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = async (): Promise<Opened | undefined> => {
    const r = await openLink(daemon.endpoint, HELLO, 1000);
    return 'link' in r ? r : undefined;
  };
  const client = async (attempts = 5) => {
    const first = await open();
    assert.strictEqual(first !== undefined, true);
    const c = new SocketDaemonClient(first as Opened, {}, open, { attempts, baseMs: 50 });
    clients.push(c);
    const statuses: ClientStatus[] = [];
    c.onStatus((s) => statuses.push(s));
    return { c, statuses };
  };

  test('a send posted while reconnecting reaches the restarted daemon once, after ready', async () => {
    const { c, statuses } = await client();
    await until(() => daemon.connections.length === 1);
    await daemon.stop();
    await until(() => statuses.includes('reconnecting'));
    c.post({ t: 'send', id: 's1', text: 'hello there' });
    c.post({ t: 'set-draft', id: 's1', text: 'dra' });
    c.post({ t: 'set-draft', id: 's1', text: 'draft' });
    c.post({ t: 'interrupt', id: 's1' });
    await daemon.start();
    await until(() => statuses.includes('connected') && msgs(daemon.connections[1] ?? []).length >= 3);
    assert.deepStrictEqual(statuses, ['reconnecting', 'connected']);
    assert.strictEqual(daemon.connections.length, 2);
    assert.deepStrictEqual(msgs(daemon.connections[1]), [
      { t: 'ready' },
      { t: 'send', id: 's1', text: 'hello there' },
      { t: 'set-draft', id: 's1', text: 'draft' },
    ]);
    c.post({ t: 'send', id: 's1', text: 'live' });
    await until(() => msgs(daemon.connections[1]).length === 4);
    assert.strictEqual(msgs(daemon.connections[1]).filter((m) => m.t === 'send').length, 2);
  });

  test('close() discards whatever was queued', async () => {
    const { c, statuses } = await client();
    await until(() => daemon.connections.length === 1);
    await daemon.stop();
    await until(() => statuses.includes('reconnecting'));
    c.post({ t: 'send', id: 's1', text: 'lost on purpose' });
    c.close();
    await daemon.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(daemon.connections.length, 1);
  });

  test('lost discards the queue: a later reconnect never replays it', async () => {
    const { c, statuses } = await client(1);
    await until(() => daemon.connections.length === 1);
    await daemon.stop();
    await until(() => statuses.includes('reconnecting'));
    c.post({ t: 'send', id: 's1', text: 'too late' });
    await until(() => statuses.includes('lost'));
    assert.deepStrictEqual(statuses, ['reconnecting', 'lost']);
    assert.strictEqual(daemon.connections.length, 1);
  });

  test('Outbox keeps only send and set-draft, caps at its limit and drops the oldest', () => {
    const box = new Outbox(3);
    assert.strictEqual(box.offer({ t: 'ready' }), false);
    for (let i = 0; i < 5; i++) { box.offer({ t: 'send', id: 's', text: String(i) }); }
    assert.deepStrictEqual(box.drain().map((m) => m.text), ['2', '3', '4']);
    assert.deepStrictEqual(box.drain(), []);
  });

  test('Outbox: a set-draft replaces an earlier one for the same session only', () => {
    const box = new Outbox();
    box.offer({ t: 'set-draft', id: 'a', text: 'a1' });
    box.offer({ t: 'set-draft', id: 'b', text: 'b1' });
    box.offer({ t: 'send', id: 'a', text: 'go' });
    box.offer({ t: 'set-draft', id: 'a', text: 'a2' });
    assert.deepStrictEqual(box.drain(), [
      { t: 'set-draft', id: 'b', text: 'b1' },
      { t: 'send', id: 'a', text: 'go' },
      { t: 'set-draft', id: 'a', text: 'a2' },
    ]);
    box.offer({ t: 'send', id: 'a', text: 'x' });
    box.clear();
    assert.deepStrictEqual(box.drain(), []);
  });
});
