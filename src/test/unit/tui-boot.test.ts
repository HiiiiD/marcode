import * as assert from 'node:assert';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClientTransport } from '../../client-core/transport';
import { daemonInfoPath } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import { discover } from '../../daemon-client/discover';
import { requestAttachmentPath } from '../../tui/attachment-request';
import { bootHost, type BootOptions, type Booted } from '../../tui/boot';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';
import { loadConfig } from '../../host/config-file';
import { defaultHostConfig, reloadSignature } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';

const until = async (cond: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};

suite('tui boot', () => {
  let tmp: string;
  let booted: Booted | undefined;
  setup(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-boot-'))); });
  teardown(async () => { await booted?.shutdown(); booted = undefined; await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  const boot = async () => {
    booted = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'), inProcess: true,
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    return booted;
  };

  test('ready through the loopback hydrates with the fake provider in the catalog', async () => {
    const b = await boot();
    const got: HostToWebview[] = [];
    b.loopback.transport.onMessage((m) => got.push(m));
    b.loopback.transport.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 100));
    const hydrate = got.find((m) => m.t === 'hydrate');
    assert.strictEqual(hydrate?.t === 'hydrate' && hydrate.catalog.some((p) => p.id === 'fake'), true);
  });

  test('file-search through the loopback answers with files from the workspace', async () => {
    await fs.mkdir(path.join(tmp, 'src'));
    await fs.writeFile(path.join(tmp, 'src', 'composer.ts'), '');
    await fs.mkdir(path.join(tmp, 'node_modules'));
    await fs.writeFile(path.join(tmp, 'node_modules', 'composer-dep.js'), '');
    const b = await boot();
    const got: HostToWebview[] = [];
    b.loopback.transport.onMessage((m) => got.push(m));
    b.loopback.transport.post({ t: 'file-search', id: 's1', query: 'compos' });
    await new Promise((r) => setTimeout(r, 200));
    const result = got.find((m) => m.t === 'file-search-result');
    const paths = result?.t === 'file-search-result' ? result.files.map((f) => f.path) : [];
    assert.strictEqual(paths[0], 'src/composer.ts');
    assert.strictEqual(paths.some((p) => p.includes('node_modules')), false);
  });

  test('the workspace directory lives under the given home and is stable', async () => {
    const b = await boot();
    assert.strictEqual(b.workspaceRoot, tmp);
    const entries = await fs.readdir(path.join(tmp, 'home', 'workspaces'));
    assert.strictEqual(entries.length, 1);
  });

  test('a host that fails to init surfaces the error', async () => {
    const home = path.join(tmp, 'home');
    const dir = await resolveWorkspaceDir(home, tmp);
    await fs.writeFile(path.join(dir, 'index.json'), '{ not json');
    await assert.rejects(
      bootHost({ cwd: tmp, home, inProcess: true, config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } } }),
      /index\.json is not valid JSON/,
    );
  });

  test('a corrupt config.json is a warning and the defaults, not a failed boot', async () => {
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'home', 'config.json'), '{ not json');
    const b = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'), inProcess: true,
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    booted = b;
    assert.strictEqual(b.warnings.some((w) => w.includes('not valid JSON')), true);
  });

  test('fileConfig is what config.json says, not the boot overrides, so a config watch does not fire at once', async () => {
    const b = await boot();
    const fromFile = await loadConfig(b.configFile);
    assert.strictEqual(reloadSignature(b.fileConfig), reloadSignature(fromFile.config));
    assert.notStrictEqual(reloadSignature(b.fileConfig), reloadSignature({ ...fromFile.config, enabledProviders: ['fake'] }));
  });

  test('shutdown twice is harmless', async () => {
    const b = await boot();
    await b.shutdown();
    await b.shutdown();
    booted = undefined;
  });
});

suite('tui boot, daemon mode', function () {
  this.timeout(30000);
  let tmp: string;
  let home: string;
  let workspaceDir: string;
  let booted: Booted[];
  let daemons: RunningDaemon[];
  const config = { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } };

  setup(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-dboot-')));
    home = path.join(tmp, 'home');
    workspaceDir = await resolveWorkspaceDir(home, tmp);
    booted = []; daemons = [];
  });
  teardown(async () => {
    for (const b of booted) { await b.shutdown(); }
    for (const d of daemons) { await d.stop(); }
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const spawnDaemon = async (dir: string, roots: string[]) => {
    daemons.push(await runDaemon({ workspaceDir: dir, config, appVersion: 'test', initialRoots: roots, idleMsOverride: 600_000 }));
  };
  const boot = async (extra: Partial<BootOptions> = {}) => {
    const b = await bootHost({ cwd: tmp, home, notify: () => {}, config, spawnDaemon, ...extra });
    booted.push(b);
    return b;
  };
  const inbox = (b: Booted) => { const got: HostToWebview[] = []; b.loopback.transport.onMessage((m) => got.push(m)); return got; };
  const hydrated = async (b: Booted) => {
    const got = inbox(b);
    b.loopback.transport.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'hydrate'));
    const h = got.find((m) => m.t === 'hydrate');
    return h?.t === 'hydrate' ? h : undefined;
  };

  test('attaches to a spawned daemon; ready hydrates with fake; shutdown leaves the daemon running', async () => {
    const b = await boot();
    assert.strictEqual(b.mode, 'daemon');
    assert.strictEqual(b.warnings.length, 0);
    const h = await hydrated(b);
    assert.strictEqual(h?.catalog.some((p) => p.id === 'fake'), true);
    await b.shutdown();
    assert.strictEqual(daemons.length, 1);
    assert.strictEqual(existsSync(daemonInfoPath(workspaceDir)), true);
    assert.strictEqual((await discover(workspaceDir))?.pid, process.pid);
  });

  test('quitting with a session awaiting approval leaves it parked for the next client', async () => {
    const first = await boot();
    const got = inbox(first);
    first.loopback.transport.post({ t: 'create-session', providerId: 'fake', cwd: tmp, seed: { text: 'permission fixture' } });
    await until(() => got.some((m) => m.t === 'session-status' && m.status === 'awaiting-approval'));
    const parked = got.find((m) => m.t === 'session-status' && m.status === 'awaiting-approval');
    const id = parked?.t === 'session-status' ? parked.id : '';
    await first.shutdown();

    const second = await boot();
    assert.strictEqual(second.mode, 'daemon');
    const h = await hydrated(second);
    assert.strictEqual(h?.sessions.find((s) => s.id === id)?.status, 'awaiting-approval');
    assert.strictEqual(daemons.length, 1);
  });

  test('daemon.enabled false boots in-process and writes no daemon.json', async () => {
    const b = await boot({ config: { ...config, daemon: { enabled: false, idleMinutes: 10 } } });
    assert.strictEqual(b.mode, 'in-process');
    assert.strictEqual(daemons.length, 0);
    assert.strictEqual(existsSync(daemonInfoPath(workspaceDir)), false);
  });

  test('a daemon that cannot start falls back in-process with one background-host warning', async () => {
    const b = await boot({ spawnDaemon: async () => { throw new Error('no binary'); } });
    assert.strictEqual(b.mode, 'in-process');
    assert.strictEqual(b.warnings.length, 1);
    assert.strictEqual(/background host/.test(b.warnings[0]), true);
    const h = await hydrated(b);
    assert.strictEqual(h?.catalog.some((p) => p.id === 'fake'), true);
  });

  test('open-attachment for a missing attachment warns through the daemon round-trip', async () => {
    const warned: string[] = [];
    const b = await boot({ notify: (m) => warned.push(m) });
    assert.strictEqual(b.mode, 'daemon');
    b.loopback.transport.post({ t: 'open-attachment', id: 'nope', attachmentId: 'nope' });
    await until(() => warned.length > 0);
    assert.deepStrictEqual(warned, ['attachment not found']);
  });
});

suite('attachment path request', () => {
  const silent = () => {
    const listeners = new Set<(m: HostToWebview) => void>();
    const posted: WebviewToHost[] = [];
    const transport: ClientTransport = {
      post: (m) => { posted.push(m); },
      onMessage: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    return { transport, listeners, posted };
  };

  test('a reply that never comes times out as not found and unsubscribes', async () => {
    const t = silent();
    const t0 = Date.now();
    const got = await requestAttachmentPath(t.transport, { id: 's', attachmentId: 'a' }, 50);
    assert.strictEqual(got, null);
    assert.strictEqual(Date.now() - t0 < 2000, true);
    assert.strictEqual(t.listeners.size, 0);
  });

  test('only the reply with the matching reqId resolves it', async () => {
    const t = silent();
    const pending = requestAttachmentPath(t.transport, { id: 's', attachmentId: 'a', itemId: 'i' }, 2000);
    const req = t.posted[0];
    const reqId = req?.t === 'request-attachment-path' ? req.reqId : -1;
    for (const l of [...t.listeners]) { l({ t: 'attachment-path', reqId: reqId + 1, path: '/wrong' }); }
    for (const l of [...t.listeners]) { l({ t: 'attachment-path', reqId, path: '/right' }); }
    assert.strictEqual(await pending, '/right');
    assert.strictEqual(req?.t === 'request-attachment-path' && req.itemId, 'i');
    assert.strictEqual(t.listeners.size, 0);
  });

  test('request ids increase across calls', async () => {
    const t = silent();
    void requestAttachmentPath(t.transport, { id: 's', attachmentId: 'a' }, 10);
    void requestAttachmentPath(t.transport, { id: 's', attachmentId: 'b' }, 10);
    const ids = t.posted.map((m) => (m.t === 'request-attachment-path' ? m.reqId : -1));
    assert.strictEqual(ids[1] > ids[0], true);
    await new Promise((r) => setTimeout(r, 30));
  });
});
