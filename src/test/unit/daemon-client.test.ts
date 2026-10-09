import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonInfoPath, readDaemonInfo, writeDaemonInfo } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon, type RunDaemonOptions } from '../../daemon/run-daemon';
import { attach, type ClientStatus, type DaemonClient } from '../../daemon-client/daemon-client';
import { connectOrSpawn, type ConnectOptions } from '../../daemon-client/connect-or-spawn';
import { daemonSpawnCommand } from '../../daemon-client/spawn-daemon';
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
    daemons = []; clients = []; servers = []; spawns = 0;
  });
  teardown(async () => {
    for (const c of clients) { c.close(); }
    for (const d of daemons) { await d.stop(); }
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

  test('a daemon that never completes the handshake times out and the spawn path takes over', async () => {
    const endpoint = nowhere(dir, 'mute');
    const held: net.Socket[] = [];
    const mute = net.createServer((s) => { held.push(s); s.on('error', () => {}); });
    servers.push(mute);
    await new Promise<void>((r) => mute.listen(endpoint, r));
    await writeDaemonInfo(dir, { pid: process.pid, endpoint, token: 't', protocolVersion: 1, appVersion: '0', startedAt: 0 });
    const t0 = Date.now();
    await connected({ handshakeTimeoutMs: 300 });
    assert.strictEqual(spawns, 1);
    assert.strictEqual(Date.now() - t0 < 5000, true);
    for (const s of held) { s.destroy(); }
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

  test('a killed daemon is respawned: reconnecting, connected, then a hydrate', async () => {
    const c = await connected({ retryBaseMs: 20 });
    const statuses: ClientStatus[] = [];
    c.onStatus((s) => statuses.push(s));
    const got = inbox(c);
    await daemons[0].stop();
    c.post({ t: 'ready' });
    await until(() => statuses.includes('connected') && got.some((m) => m.t === 'hydrate'), 15000);
    assert.deepStrictEqual(statuses, ['reconnecting', 'connected']);
    assert.strictEqual(got.some((m) => m.t === 'hydrate'), true);
    assert.strictEqual(spawns, 2);
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
