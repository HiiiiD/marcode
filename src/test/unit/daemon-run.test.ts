import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonInfoPath, readDaemonInfo, writeDaemonInfo, type DaemonInfo } from '../../daemon/daemon-info';
import { toLoginRecipesWire } from '../../daemon/login-recipes';
import { encodeFrame, LineDecoder } from '../../daemon/protocol';
import { runDaemon, type RunningDaemon, type RunDaemonOptions } from '../../daemon/run-daemon';
import type { HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';

interface Client { sock: net.Socket; frames: any[]; send(f: object): void; closed(): boolean }

function client(endpoint: string): Promise<Client> {
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

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};
const settled = (p: Promise<void>) => { let done = false; void p.then(() => { done = true; }); return () => done; };
const hello = (info: DaemonInfo, protocolVersion = info.protocolVersion) => ({
  f: 'hello', protocolVersion, appVersion: info.appVersion, clientKind: 'tui', token: info.token, roots: [], defaultCwd: os.tmpdir(),
});

suite('runDaemon', function () {
  this.timeout(15000);
  let dir: string;
  let daemon: RunningDaemon | undefined;
  const start = async (extra: Partial<RunDaemonOptions> = {}) => {
    daemon = await runDaemon({
      workspaceDir: dir,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      appVersion: '9.9.9',
      initialRoots: [dir],
      ...extra,
    });
    return daemon;
  };

  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-run-')); });
  teardown(async () => {
    await daemon?.stop();
    daemon = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('daemon.json is written once listening, and its endpoint hydrates a client with the fake provider', async () => {
    const d = await start();
    const info = await readDaemonInfo(dir);
    assert.strictEqual(info?.pid, process.pid);
    assert.strictEqual(info?.token, d.info.token);
    assert.strictEqual(info?.appVersion, '9.9.9');
    const c = await client(d.info.endpoint);
    c.send(hello(d.info));
    c.send({ f: 'msg', m: { t: 'ready' } });
    await until(() => c.frames.some((f) => f.f === 'msg' && f.m.t === 'hydrate'));
    assert.strictEqual(c.frames[0].f, 'welcome');
    const hydrate = c.frames.find((f) => f.f === 'msg' && f.m.t === 'hydrate');
    assert.strictEqual(hydrate?.m.catalog.some((p: { id: string }) => p.id === 'fake'), true);
    c.sock.destroy();
  });

  test('host warnings and shell noise reach a sidebar client as acts, and are harmless before one attaches', async () => {
    let notifier: { warn(m: string): void; shellNoise(p: string): void } | undefined;
    const d = await start({ onNotifier: (n) => { notifier = n; } });
    notifier?.warn('before anyone');
    const sidebar = await client(d.info.endpoint);
    const tui = await client(d.info.endpoint);
    sidebar.send({ ...hello(d.info), clientKind: 'sidebar' });
    tui.send(hello(d.info));
    await until(() => sidebar.frames.length > 0 && tui.frames.length > 0);
    notifier?.warn('boom');
    notifier?.shellNoise('Profile.ps1');
    await until(() => sidebar.frames.filter((f) => f.f === 'act').length === 2);
    assert.deepStrictEqual(
      sidebar.frames.filter((f) => f.f === 'act').map((f) => [f.op, f.args]),
      [['notify', ['warn', 'boom']], ['shellNoise', ['Profile.ps1']]],
    );
    assert.strictEqual(tui.frames.some((f) => f.f === 'act'), false);
    sidebar.sock.destroy(); tui.sock.destroy();
  });

  test('stop() removes daemon.json, closes the socket, resolves done, and is idempotent', async () => {
    const d = await start();
    const c = await client(d.info.endpoint);
    c.send(hello(d.info));
    await until(() => c.frames.length > 0);
    await Promise.all([d.stop(), d.stop()]);
    await d.done;
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
    await until(() => c.closed());
    assert.strictEqual(c.closed(), true);
    await d.stop();
  });

  test('an idle daemon with no clients exits on its own', async () => {
    const d = await start({ idleMsOverride: 50 });
    await d.done;
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
  });

  test('an attached client keeps it alive past the idle time; detaching lets it exit', async () => {
    const d = await start({ idleMsOverride: 50 });
    const c = await client(d.info.endpoint);
    c.send(hello(d.info));
    await until(() => c.frames.length > 0);
    const isDone = settled(d.done);
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(isDone(), false);
    c.sock.destroy();
    await d.done;
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
  });

  test('login recipes carry only the env keys that differ from the daemon\'s own', () => {
    const wire = toLoginRecipesWire(
      new Map([['x', { terminalName: 'X login', command: 'x login', env: { A: '1', B: 'same', C: undefined } }]]),
      { B: 'same' },
    );
    assert.deepStrictEqual(wire, [{ id: 'x', terminalName: 'X login', command: 'x login', env: { A: '1' } }]);
  });

  test('shutdown is refused while a session waits on an approval', async () => {
    const d = await start();
    const c = await client(d.info.endpoint);
    c.send(hello(d.info));
    c.send({ f: 'msg', m: { t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } });
    await until(() => c.frames.some((f) => f.f === 'msg' && f.m.t === 'session-status' && f.m.status === 'awaiting-approval'));
    const s = await client(d.info.endpoint);
    s.send({ f: 'shutdown', token: d.info.token });
    await until(() => s.frames.length > 0);
    assert.deepStrictEqual(s.frames[0], { f: 'refuse', reason: 'busy' });
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), true);
    c.sock.destroy(); s.sock.destroy();
  });

  test('shutdown{token} on an idle daemon says bye and the daemon goes away', async () => {
    const d = await start();
    const s = await client(d.info.endpoint);
    s.send({ f: 'shutdown', token: d.info.token });
    await d.done;
    await until(() => s.closed());
    assert.deepStrictEqual(s.frames[0], { f: 'bye' });
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
  });

  test('protocolVersionOverride is advertised in daemon.json and enforced at hello', async () => {
    const d = await start({ protocolVersionOverride: 99 });
    assert.strictEqual((await readDaemonInfo(dir))?.protocolVersion, 99);
    const c = await client(d.info.endpoint);
    c.send(hello(d.info, 1));
    await until(() => c.frames.length > 0);
    assert.strictEqual(c.frames[0].f, 'reject');
    assert.strictEqual(c.frames[0].reason, 'protocol-mismatch');
    assert.strictEqual(c.frames[0].daemon.protocolVersion, 99);
    c.sock.destroy();
  });

  test('a session leaving awaiting-approval with no client attached lets the idle daemon exit', async () => {
    let host: HostHandle | undefined;
    const d = await start({ idleMsOverride: 100, onHost: (h) => { host = h; } });
    const isDone = settled(d.done);
    const c = await client(d.info.endpoint);
    c.send(hello(d.info));
    c.send({ f: 'msg', m: { t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } });
    const parked = () => c.frames.find((f) => f.f === 'msg' && f.m.t === 'session-status' && f.m.status === 'awaiting-approval');
    await until(() => parked() !== undefined);
    const id = parked().m.id;
    c.sock.destroy();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(isDone(), false);
    const items = (await host?.manager.transcriptTail(id))?.items ?? [];
    const ask = items.find((i) => i.role === 'permission');
    assert.strictEqual(ask?.role, 'permission');
    if (ask?.role === 'permission') { host?.manager.get(id)?.respondToPermission(ask.requestId, { allow: true }); }
    await until(isDone);
    assert.strictEqual(isDone(), true);
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
  });

  test('a host dispose that hangs is logged and abandoned: stop still removes daemon.json and resolves done', async () => {
    const lines: string[] = [];
    let slow: Promise<void> | undefined;
    const d = await start({
      disposeTimeoutMs: 50, log: (l) => lines.push(l),
      onHost: (h) => {
        const real = h.dispose.bind(h);
        h.dispose = () => (slow = new Promise<void>((r) => setTimeout(r, 1000)).then(real));
      },
    });
    const t0 = Date.now();
    await d.stop();
    await d.done;
    assert.strictEqual(Date.now() - t0 < 900, true);
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), false);
    assert.strictEqual(lines.some((l) => l.startsWith('host dispose timed out')), true);
    await slow;
  });

  test('a startup failure is logged with its cause and rejects', async () => {
    fs.mkdirSync(daemonInfoPath(dir));
    const lines: string[] = [];
    let rejected = false;
    await start({ log: (l) => lines.push(l) }).catch(() => { rejected = true; });
    daemon = undefined;
    assert.strictEqual(rejected, true);
    assert.strictEqual(lines.some((l) => l.startsWith('startup failed:')), true);
  });

  test('a listen failure is logged with its cause and rejects', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const first = await start();
    const lines: string[] = [];
    let rejected = false;
    await runDaemon({
      workspaceDir: dir, appVersion: '1', initialRoots: [dir], log: (l) => lines.push(l),
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    }).catch(() => { rejected = true; });
    daemon = first;
    assert.strictEqual(rejected, true);
    assert.strictEqual(lines.some((l) => l.startsWith('startup failed:')), true);
  });

  test('a live owner that appears while the host boots is caught right before listening', async () => {
    const owner: DaemonInfo = { pid: process.ppid, endpoint: 'x', token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 };
    let error = '';
    await start({ onHost: () => { fs.writeFileSync(daemonInfoPath(dir), JSON.stringify(owner)); } })
      .then((d) => d.stop(), (e: Error) => { error = e.message; });
    daemon = undefined;
    assert.strictEqual(error, `a daemon is already running for this workspace (pid ${process.ppid})`);
    assert.deepStrictEqual(await readDaemonInfo(dir), owner);
  });

  test('a live daemon owning the workspace is refused, and its daemon.json is left alone', async () => {
    const owner: DaemonInfo = { pid: process.ppid, endpoint: 'x', token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 };
    await writeDaemonInfo(dir, owner);
    const lines: string[] = [];
    let error = '';
    await start({ log: (l) => lines.push(l) }).catch((e: Error) => { error = e.message; });
    daemon = undefined;
    assert.strictEqual(error, `a daemon is already running for this workspace (pid ${process.ppid})`);
    assert.strictEqual(lines.some((l) => l.startsWith('startup failed:')), true);
    assert.deepStrictEqual(await readDaemonInfo(dir), owner);
  });
});
