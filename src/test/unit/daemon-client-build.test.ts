import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDaemonInfo } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon, type RunDaemonOptions } from '../../daemon/run-daemon';
import { attach, type DaemonClient } from '../../daemon-client/daemon-client';
import { connectOrSpawn, STALE_BUILD_WARNING, type ConnectOptions } from '../../daemon-client/connect-or-spawn';
import { isOlderBuild } from '../../daemon-client/version-policy';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';
import { until } from '../fixtures/daemon-raw-client';

const ME = { protocolVersion: 1, appVersion: '0.0.2' };

suite('daemon client: app version', function () {
  this.timeout(30000);
  let dir: string;
  let daemons: RunningDaemon[];
  let clients: DaemonClient[];
  let spawns: number;

  const start = async (appVersion: string, extra: Partial<RunDaemonOptions> = {}) => {
    const d = await runDaemon({
      workspaceDir: dir,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      appVersion, initialRoots: [dir], idleMsOverride: 600_000, ...extra,
    });
    daemons.push(d);
    return d;
  };
  const connect = async (extra: Partial<ConnectOptions> = {}) => {
    const r = await connectOrSpawn({
      workspaceDir: dir, clientKind: 'tui', roots: [dir], defaultCwd: dir, identity: ME, hooks: {},
      replaceOlderBuild: true, spawn: async () => { spawns++; await start('0.0.2'); }, ...extra,
    });
    assert.strictEqual(r.kind, 'attached', r.kind === 'fallback' ? r.message : '');
    if (r.kind !== 'attached') { throw new Error('not attached'); }
    clients.push(r.client);
    return r;
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dcb-'));
    daemons = []; clients = []; spawns = 0;
  });
  teardown(async () => {
    for (const c of clients) { c.close(); }
    for (const d of daemons) { await d.stop(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('isOlderBuild compares plain semver and ignores anything else', () => {
    assert.strictEqual(isOlderBuild('0.0.56', '0.0.57'), true);
    assert.strictEqual(isOlderBuild('0.0.57', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.1.0', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.0.0-dev', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.0.56', 'dev'), false);
    assert.strictEqual(isOlderBuild('0.0.9', '0.0.10'), true);
  });

  test('an idle daemon from an older build is replaced', async () => {
    const old = await start('0.0.1');
    await connect();
    await old.done;
    assert.strictEqual(spawns, 1);
    assert.strictEqual((await readDaemonInfo(dir))?.appVersion, '0.0.2');
  });

  test('a busy daemon from an older build is attached with one warning', async () => {
    const old = await start('0.0.1');
    const r0 = await attach(old.info, { clientKind: 'tui', roots: [], defaultCwd: dir }, {}, { protocolVersion: 1, appVersion: '0.0.1' });
    if (!('client' in r0)) { throw new Error('no client'); }
    clients.push(r0.client);
    const got: HostToWebview[] = [];
    r0.client.onMessage((m) => got.push(m));
    r0.client.post({ t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } as never);
    await until(() => got.some((m) => m.t === 'session-status' && m.status === 'awaiting-approval'));
    const r = await connect();
    assert.strictEqual(spawns, 0);
    assert.deepStrictEqual(r.warnings, [STALE_BUILD_WARNING]);
    assert.strictEqual((await readDaemonInfo(dir))?.token, old.info.token);
  });

  test('the rule is off unless asked for, and a dev build never triggers it', async () => {
    const old = await start('0.0.1');
    await connect({ replaceOlderBuild: false });
    assert.strictEqual(spawns, 0);
    assert.strictEqual((await readDaemonInfo(dir))?.token, old.info.token);
    await connect({ identity: { protocolVersion: 1, appVersion: '0.0.0-dev' } });
    assert.strictEqual(spawns, 0);
  });
});
