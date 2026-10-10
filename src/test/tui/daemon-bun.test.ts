import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDaemonInfo } from '../../daemon/daemon-info';
import { PROTOCOL_VERSION } from '../../daemon/protocol';
import { requestShutdown } from '../../daemon/request-shutdown';
import { connectOrSpawn } from '../../daemon-client/connect-or-spawn';
import type { DaemonClient } from '../../daemon-client/daemon-client';
import type { HostToWebview } from '../../protocol/messages';

const REPO = path.resolve(import.meta.dir, '../../..');
const ENTRY = path.join(REPO, 'src', 'daemon', 'daemon-main.ts');

let child: ChildProcess | undefined;
let daemonPid: number | undefined;
let client: DaemonClient | undefined;
let tmp: string | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => { child?.once('exit', r); setTimeout(r, 3000); });
  }
  child = undefined;
  // Under yarn, `node` is a shim, so the daemon may be a grandchild that killing `child` misses.
  if (daemonPid !== undefined) { try { process.kill(daemonPid); } catch { /* already gone */ } }
  daemonPid = undefined;
  if (tmp) { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); tmp = undefined; }
});

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await probe();
    if (v !== undefined) { return v; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function attachTo(runtime: 'node' | 'bun'): Promise<void> {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mar-xrt-${runtime}-`)));
  const home = path.join(tmp, 'home');
  const ws = path.join(home, 'workspaces', 'w');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({
    enabledProviders: ['fake'], memory: { enabled: false },
  }));
  const serve = ['daemon', '--serve', '--workspace-dir', ws, '--root', tmp];
  const [command, args] = runtime === 'node'
    ? ['node', ['--require', 'tsx/cjs', ENTRY, ...serve]]
    : [process.execPath, [ENTRY, ...serve]];
  child = spawn(command, args, {
    cwd: REPO, env: { ...process.env, MARCODE_HOME: home }, stdio: 'ignore', windowsHide: true,
  });
  const exited = { code: null as number | null };
  child.once('exit', (code) => { exited.code = code ?? -1; });

  const info = await waitFor(async () => {
    if (exited.code !== null) { throw new Error(`daemon exited early with ${exited.code}`); }
    return readDaemonInfo(ws);
  }, 'daemon.json');
  daemonPid = info.pid;

  const r = await connectOrSpawn({
    workspaceDir: ws, clientKind: 'tui', roots: [tmp], defaultCwd: tmp,
    identity: { protocolVersion: PROTOCOL_VERSION, appVersion: 'test' }, hooks: {},
    spawn: () => { throw new Error('spawn must not run: the daemon is already up'); },
  });
  expect(r.kind === 'fallback' ? r.message : r.kind).toBe('attached');
  if (r.kind !== 'attached') { return; }
  client = r.client;
  const got: HostToWebview[] = [];
  client.onMessage((m) => { got.push(m); });
  client.post({ t: 'ready' });

  const hasFake = (m: HostToWebview) => (m.t === 'hydrate' || m.t === 'catalog') && m.catalog.some((p) => p.id === 'fake');
  await waitFor(() => (got.some((m) => m.t === 'hydrate') && got.some(hasFake) ? true : undefined), 'hydrate with the fake provider', 15_000);
  expect(got.filter((m) => m.t === 'hydrate').length).toBe(1);
  expect(got.some(hasFake)).toBe(true);

  client.close();
  client = undefined;
  expect(await requestShutdown(info.endpoint, info.token)).toBe('bye');
  const code = await waitFor(() => exited.code ?? undefined, 'daemon exit', 15_000);
  expect(code).toBe(0);
  daemonPid = undefined;
}

test('a Bun client attaches to a daemon served by Node', async () => { await attachTo('node'); }, 90_000);

test('a Bun client attaches to a daemon served by Bun', async () => { await attachTo('bun'); }, 90_000);
