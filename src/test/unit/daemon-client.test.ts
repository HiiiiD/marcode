import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonInfoPath, readDaemonInfo, writeDaemonInfo } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon, type RunDaemonOptions } from '../../daemon/run-daemon';
import { attach, SocketDaemonClient, type ClientStatus, type DaemonClient } from '../../daemon-client/daemon-client';
import { Link } from '../../daemon-client/daemon-link';
import { connectOrSpawn, type ConnectOptions } from '../../daemon-client/connect-or-spawn';
import { daemonSpawnCommand, daemonSpawnOptions } from '../../daemon-client/spawn-daemon';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};
const settled = (p: Promise<void>) => { let done = false; void p.then(() => { done = true; }); return () => done; };
const ME = { protocolVersion: 1, appVersion: '9.9.9' };
const nowhere = (dir: string, tag: string) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\marcode-test-${tag}-${process.pid}-${Date.now()}`
  : path.join(dir, `${tag}.sock`));

suite('daemon client', function () {
  this.timeout(30000);
  let dir: string;
  let daemons: RunningDaemon[];
  let clients: DaemonClient[];
  let servers: net.Server[];
  let held: net.Socket[];
  let spawns: number;

  const start = async (extra: Partial<RunDaemonOptions> = {}) => {
    const d = await runDaemon({
      workspaceDir: dir,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      appVersion: '9.9.9',
      initialRoots: [dir],
      idleMsOverride: 600_000,
      ...extra,
    });
    daemons.push(d);
    return d;
  };
  const spawn = async () => { spawns++; await start(); };
  const opts = (extra: Partial<ConnectOptions> = {}): ConnectOptions => ({
    workspaceDir: dir, clientKind: 'tui', roots: [dir], defaultCwd: dir, identity: ME, hooks: {}, spawn, ...extra,
  });
  const track = (c: DaemonClient) => { clients.push(c); return c; };
  const inbox = (c: DaemonClient) => { const got: HostToWebview[] = []; c.onMessage((m) => got.push(m)); return got; };
  const connected = async (extra: Partial<ConnectOptions> = {}) => {
    const r = await connectOrSpawn(opts(extra));
    assert.strictEqual(r.kind, 'attached', r.kind === 'fallback' ? r.message : '');
    return track((r as { client: DaemonClient }).client);
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dcl-'));
    daemons = []; clients = []; servers = []; held = []; spawns = 0;
  });
  teardown(async () => {
    for (const c of clients) { c.close(); }
    for (const d of daemons) { await d.stop(); }
    for (const s of held) { s.destroy(); }
    for (const s of servers) { await new Promise((r) => s.close(r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('attach to a running daemon: ready yields a hydrate', async () => {
    const d = await start();
    const r = await attach(d.info, { clientKind: 'tui', roots: [dir], defaultCwd: dir }, {}, ME);
    assert.strictEqual('client' in r, true);
    const c = track((r as { client: DaemonClient }).client);
    const got = inbox(c);
    c.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'hydrate'));
    assert.strictEqual(got.some((m) => m.t === 'hydrate'), true);
  });

  test('no daemon: spawns once and attaches', async () => {
    const c = await connected();
    assert.strictEqual(spawns, 1);
    const got = inbox(c);
    c.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'hydrate'));
    assert.strictEqual(got.some((m) => m.t === 'hydrate'), true);
  });

  test('two simultaneous connectOrSpawn calls produce exactly one spawn', async () => {
    const [a, b] = await Promise.all([connectOrSpawn(opts()), connectOrSpawn(opts())]);
    if (a.kind === 'attached') { track(a.client); }
    if (b.kind === 'attached') { track(b.client); }
    assert.strictEqual(a.kind, 'attached');
    assert.strictEqual(b.kind, 'attached');
    assert.strictEqual(spawns, 1);
    assert.strictEqual(daemons.length, 1);
  });

  test('a daemon.json left by a dead pid is recovered', async () => {
    await writeDaemonInfo(dir, { pid: 2_000_000_000, endpoint: nowhere(dir, 'dead'), token: 't', protocolVersion: 1, appVersion: '0', startedAt: 0 });
    await connected();
    assert.strictEqual(spawns, 1);
  });

  test('a live pid with nothing listening falls through to the spawn path', async () => {
    await writeDaemonInfo(dir, { pid: process.ppid, endpoint: nowhere(dir, 'empty'), token: 't', protocolVersion: 1, appVersion: '0', startedAt: 0 });
    await connected();
    assert.strictEqual(spawns, 1);
    assert.strictEqual((await readDaemonInfo(dir))?.pid, process.pid);
  });

  const muteDaemon = async (protocolVersion: number) => {
    const endpoint = nowhere(dir, 'mute');
    const mute = net.createServer((s) => { held.push(s); s.on('error', () => {}); });
    servers.push(mute);
    await new Promise<void>((r) => mute.listen(endpoint, r));
    await writeDaemonInfo(dir, { pid: process.pid, endpoint, token: 't', protocolVersion, appVersion: '0', startedAt: 0 });
    return fs.readFileSync(daemonInfoPath(dir), 'utf8');
  };

  test('a live daemon that accepts but never answers is waited on, never replaced', async () => {
    const before = await muteDaemon(1);
    const t0 = Date.now();
    const r = await connectOrSpawn(opts({ handshakeTimeoutMs: 200, timeoutMs: 1500 }));
    assert.strictEqual(r.kind === 'fallback' && r.reason, 'unresponsive-daemon');
    assert.strictEqual(Date.now() - t0 < 5000, true);
    assert.strictEqual(spawns, 0);
    assert.strictEqual(fs.readFileSync(daemonInfoPath(dir), 'utf8'), before);
  });

  test('an older-protocol daemon that never answers shutdown is waited on, never replaced', async () => {
    const before = await muteDaemon(0);
    const r = await connectOrSpawn(opts({ handshakeTimeoutMs: 200, timeoutMs: 1500 }));
    assert.strictEqual(r.kind === 'fallback' && r.reason, 'unresponsive-daemon');
    assert.strictEqual(spawns, 0);
    assert.strictEqual(fs.readFileSync(daemonInfoPath(dir), 'utf8'), before);
  });

  test('a link that drops while being adopted during reconnect never reports connected', async () => {
    const welcome = { f: 'welcome' as const, clientId: 'x', loginRecipes: [], protocolVersion: 1, appVersion: 'x' };
    const deadLink = () => { const l = new Link(new net.Socket()); l.dropped(); return l; };
    let reopens = 0;
    const first = new Link(new net.Socket());
    const c = track(new SocketDaemonClient({ link: first, welcome }, {}, async () => { reopens++; return { link: deadLink(), welcome }; }, { attempts: 3, baseMs: 1 }));
    const statuses: ClientStatus[] = [];
    c.onStatus((s) => statuses.push(s));
    first.dropped();
    await until(() => statuses.includes('lost'));
    assert.deepStrictEqual(statuses, ['reconnecting', 'lost']);
    assert.strictEqual(reopens, 3);
  });

  test('a daemon req reaches hooks.ask and its res comes back; an act reaches hooks.act', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'hi');
    const asked: string[] = [];
    const acted: Array<[string, unknown[]]> = [];
    const c = await connected({
      hooks: {
        ask: async (op) => { asked.push(op); return [file]; },
        act: (op, args) => { acted.push([op, args]); },
      },
    });
    const got = inbox(c);
    c.post({ t: 'create-session', providerId: 'fake', cwd: dir } as never);
    const roster = () => got.find((m) => m.t === 'sessions-changed' && m.sessions.length > 0);
    await until(() => roster() !== undefined);
    const r = roster();
    const id = r?.t === 'sessions-changed' ? r.sessions[0].id : '';
    c.post({ t: 'attach-pick', id });
    await until(() => got.some((m) => m.t === 'session-attachments' || m.t === 'attachments-rejected'));
    assert.deepStrictEqual(asked, ['pick']);
    const attached = got.find((m) => m.t === 'session-attachments');
    assert.strictEqual(attached?.t === 'session-attachments' ? attached.attachments.length : -1, 1);
    c.post({ t: 'open-external', url: 'https://example.com' });
    await until(() => acted.length > 0);
    assert.deepStrictEqual(acted, [['openExternal', ['https://example.com']]]);
  });

  test('an idle older-protocol daemon is replaced', async () => {
    const old = await start({ protocolVersionOverride: 0 });
    await connected();
    assert.strictEqual(spawns, 1);
    await old.done;
    assert.strictEqual((await readDaemonInfo(dir))?.protocolVersion, 1);
  });

  test('a newer-protocol daemon is left alone: fallback newer-daemon', async () => {
    const d = await start({ protocolVersionOverride: 2 });
    const r = await connectOrSpawn(opts());
    assert.strictEqual(r.kind, 'fallback');
    assert.strictEqual(r.kind === 'fallback' && r.reason, 'newer-daemon');
    assert.strictEqual(spawns, 0);
    const again = await attach(d.info, { clientKind: 'tui', roots: [], defaultCwd: dir }, {}, { protocolVersion: 2, appVersion: 'x' });
    assert.strictEqual('client' in again, true);
    if ('client' in again) { track(again.client); }
  });

  test('a busy older-protocol daemon is left alone: fallback busy-daemon', async () => {
    const d = await start({ protocolVersionOverride: 0 });
    const r0 = await attach(d.info, { clientKind: 'tui', roots: [], defaultCwd: dir }, {}, { protocolVersion: 0, appVersion: 'x' });
    assert.strictEqual('client' in r0, true);
    const c = track((r0 as { client: DaemonClient }).client);
    const got = inbox(c);
    c.post({ t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } as never);
    await until(() => got.some((m) => m.t === 'session-status' && m.status === 'awaiting-approval'));
    const r = await connectOrSpawn(opts());
    assert.strictEqual(r.kind === 'fallback' && r.reason, 'busy-daemon');
    assert.strictEqual(spawns, 0);
    const isDone = settled(d.done);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(isDone(), false);
    assert.strictEqual(fs.existsSync(daemonInfoPath(dir)), true);
    const again = await attach(d.info, { clientKind: 'tui', roots: [], defaultCwd: dir }, {}, { protocolVersion: 0, appVersion: 'x' });
    assert.strictEqual('client' in again, true);
    if ('client' in again) { track(again.client); }
  });

  test('a killed daemon is respawned: reconnecting, connected, a hydrate, then live patches for the shown pane', async () => {
    const c = await connected({ retryBaseMs: 20 });
    const statuses: ClientStatus[] = [];
    c.onStatus((s) => statuses.push(s));
    const got = inbox(c);
    c.post({ t: 'create-session', providerId: 'fake', cwd: dir } as never);
    await until(() => got.some((m) => m.t === 'session-snapshot'));
    const snap = got.find((m) => m.t === 'session-snapshot');
    const id = snap?.t === 'session-snapshot' ? snap.session.id : '';
    c.post({ t: 'set-visible', sessionIds: [id] });
    c.post({ t: 'send', id, text: 'hello' });
    await until(() => got.some((m) => m.t === 'session-status' && m.id === id && m.status === 'idle' && got.some((p) => p.t === 'session-patch')));
    await daemons[0].stop();
    got.length = 0;
    await until(() => statuses.includes('connected') && got.some((m) => m.t === 'hydrate'), 15000);
    assert.deepStrictEqual(statuses, ['reconnecting', 'connected']);
    assert.strictEqual(spawns, 2);
    c.post({ t: 'send', id, text: 'again' });
    await until(() => got.some((m) => m.t === 'session-patch' && m.id === id));
    assert.strictEqual(got.some((m) => m.t === 'session-patch' && m.id === id), true);
  });

  test('pushContext sends a ctx frame the daemon serves back as editor-context', async () => {
    const c = await connected();
    const got = inbox(c);
    const ctx = { path: 'a.ts', languageId: 'typescript' };
    c.pushContext(ctx);
    c.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'editor-context'));
    const ec = got.find((m) => m.t === 'editor-context');
    assert.deepStrictEqual(ec?.t === 'editor-context' ? ec.ctx : 'missing', ctx);
  });

  test('hooks.context is pushed right after welcome', async () => {
    const ctx = { path: 'b.ts', languageId: 'typescript' };
    const c = await connected({ hooks: { context: () => ctx } });
    const got = inbox(c);
    c.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'editor-context'));
    const ec = got.find((m) => m.t === 'editor-context');
    assert.deepStrictEqual(ec?.t === 'editor-context' ? ec.ctx : 'missing', ctx);
  });

  test('close() is final: no reconnect, no callbacks, post does not throw', async () => {
    const c = await connected({ retryBaseMs: 20 });
    const statuses: ClientStatus[] = [];
    let messages = 0;
    c.onStatus((s) => statuses.push(s));
    c.onMessage(() => { messages++; });
    c.close();
    await daemons[0].stop();
    c.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(statuses, []);
    assert.strictEqual(messages, 0);
    assert.strictEqual(spawns, 1);
  });

  test('waiting on a spawned daemon keeps the process alive until connectOrSpawn settles', () => {
    const script = `require(${JSON.stringify(path.resolve('src/daemon-client/connect-or-spawn.ts'))}).connectOrSpawn({
      workspaceDir: process.argv[1], clientKind: 'tui', roots: [], defaultCwd: '.',
      identity: { protocolVersion: 1, appVersion: 'x' }, hooks: {}, spawn: async () => {}, timeoutMs: 800,
    }).then((r) => console.log('settled ' + r.kind));`;
    const r = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', script, dir], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.stdout.trim(), 'settled fallback');
  });

  test('the detached daemon runs in its workspace dir, not the client cwd', () => {
    const o = daemonSpawnOptions('/w', 7);
    assert.strictEqual(o.cwd, '/w');
    assert.strictEqual(o.detached, true);
  });

  test('daemonSpawnCommand: a Bun script re-runs its entry, a compiled binary runs itself', () => {
    const bun = daemonSpawnCommand('/w', ['/r1', '/r2'], { execPath: '/x/bun.exe', argv1: '/src/main.tsx' });
    assert.deepStrictEqual(bun, {
      command: '/x/bun.exe',
      args: ['/src/main.tsx', 'daemon', '--serve', '--workspace-dir', '/w', '--root', '/r1', '--root', '/r2'],
    });
    const bin = daemonSpawnCommand('/w', ['/r'], { execPath: '/x/marcode.exe', argv1: '/ignored' });
    assert.deepStrictEqual(bin, { command: '/x/marcode.exe', args: ['daemon', '--serve', '--workspace-dir', '/w', '--root', '/r'] });
  });
});
