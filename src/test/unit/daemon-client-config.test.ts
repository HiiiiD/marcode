import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDaemonInfo } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon, type RunDaemonOptions } from '../../daemon/run-daemon';
import { attach, type DaemonClient } from '../../daemon-client/daemon-client';
import { connectOrSpawn, STALE_CONFIG_WARNING, type ConnectOptions } from '../../daemon-client/connect-or-spawn';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';
import { until } from '../fixtures/daemon-raw-client';

const ME = { protocolVersion: 1, appVersion: '9.9.9' };

suite('daemon client: config signature', function () {
  this.timeout(30000);
  let dir: string;
  let daemons: RunningDaemon[];
  let clients: DaemonClient[];
  let spawns: number;

  const start = async (extra: Partial<RunDaemonOptions> = {}) => {
    const d = await runDaemon({
      workspaceDir: dir,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      appVersion: '9.9.9', initialRoots: [dir], idleMsOverride: 600_000, ...extra,
    });
    daemons.push(d);
    return d;
  };
  const opts = (): ConnectOptions => ({
    workspaceDir: dir, clientKind: 'tui', roots: [dir], defaultCwd: dir, identity: ME, hooks: {},
    configSignature: 'new', spawn: async () => { spawns++; await start({ configSignature: 'new' }); },
  });
  const connect = async () => {
    const r = await connectOrSpawn(opts());
    assert.strictEqual(r.kind, 'attached', r.kind === 'fallback' ? r.message : '');
    if (r.kind !== 'attached') { throw new Error('not attached'); }
    clients.push(r.client);
    return r;
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dcc-'));
    daemons = []; clients = []; spawns = 0;
  });
  teardown(async () => {
    for (const c of clients) { c.close(); }
    for (const d of daemons) { await d.stop(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an idle daemon started with another config.json is replaced', async () => {
    const old = await start({ configSignature: 'old' });
    const r = await connect();
    await old.done;
    assert.strictEqual(spawns, 1);
    assert.strictEqual((await readDaemonInfo(dir))?.configSignature, 'new');
    assert.deepStrictEqual(r.warnings ?? [], []);
  });

  test('a busy daemon started with another config.json is attached, with one warning', async () => {
    const old = await start({ configSignature: 'old' });
    const r0 = await attach(old.info, { clientKind: 'tui', roots: [], defaultCwd: dir }, {}, ME);
    if (!('client' in r0)) { throw new Error('no client'); }
    clients.push(r0.client);
    const got: HostToWebview[] = [];
    r0.client.onMessage((m) => got.push(m));
    r0.client.post({ t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } as never);
    await until(() => got.some((m) => m.t === 'session-status' && m.status === 'awaiting-approval'));
    const r = await connect();
    assert.strictEqual(spawns, 0);
    assert.deepStrictEqual(r.warnings, [STALE_CONFIG_WARNING]);
    assert.strictEqual((await readDaemonInfo(dir))?.token, old.info.token);
  });

  test('a daemon with the same config signature is attached silently', async () => {
    const d = await start({ configSignature: 'new' });
    const r = await connect();
    assert.strictEqual(spawns, 0);
    assert.deepStrictEqual(r.warnings ?? [], []);
    assert.strictEqual((await readDaemonInfo(dir))?.token, d.info.token);
  });
});
