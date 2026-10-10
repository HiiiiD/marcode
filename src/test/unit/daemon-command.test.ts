import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import { writeDaemonInfo } from '../../daemon/daemon-info';
import { defaultHostConfig } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';
import { runDaemonCommand, type SubIo } from '../../tui/subcommands';
import { findGitRoot } from '../../tui/workspace-root';

suite('marcode daemon --status/--stop', function () {
  this.timeout(15000);
  let home: string;
  let cwd: string;
  let workspaceDir: string;
  let daemon: RunningDaemon | undefined;
  let out: string[];
  let io: SubIo;

  setup(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dhome-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-dcwd-'));
    workspaceDir = await resolveWorkspaceDir(home, await findGitRoot(cwd));
    out = [];
    io = { home, out: (l) => out.push(l), err: (l) => out.push(`err:${l}`), spawn: async () => 0, editor: () => undefined };
  });
  teardown(async () => {
    await daemon?.stop();
    daemon = undefined;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const start = async () => {
    daemon = await runDaemon({
      workspaceDir, appVersion: '1', initialRoots: [cwd],
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    return daemon;
  };

  test('status with nothing running', async () => {
    assert.strictEqual(await runDaemonCommand({ kind: 'daemon', action: 'status', roots: [] }, cwd, io), 1);
    assert.deepStrictEqual(out, ['not running']);
  });

  test('status ignores a daemon.json whose pid is dead', async () => {
    await writeDaemonInfo(workspaceDir, { pid: 2 ** 22 + 12345, endpoint: 'x', token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 });
    await runDaemonCommand({ kind: 'daemon', action: 'status', roots: [] }, cwd, io);
    assert.deepStrictEqual(out, ['not running']);
  });

  test('status reports a running daemon', async () => {
    const d = await start();
    assert.strictEqual(await runDaemonCommand({ kind: 'daemon', action: 'status', roots: [] }, cwd, io), 0);
    assert.deepStrictEqual(out, [`running pid=${process.pid} protocol=${d.info.protocolVersion} started=${new Date(d.info.startedAt).toISOString()}`]);
  });

  test('stop on an idle daemon prints stopped and the daemon exits', async () => {
    const d = await start();
    assert.strictEqual(await runDaemonCommand({ kind: 'daemon', action: 'stop', roots: [] }, cwd, io), 0);
    assert.deepStrictEqual(out, ['stopped']);
    await d.done;
  });

  test('stop with nothing running', async () => {
    assert.strictEqual(await runDaemonCommand({ kind: 'daemon', action: 'stop', roots: [] }, cwd, io), 0);
    assert.deepStrictEqual(out, ['not running']);
  });

  test('stop on an unreachable endpoint fails', async () => {
    await writeDaemonInfo(workspaceDir, { pid: process.pid, endpoint: path.join(cwd, 'nope.sock'), token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 });
    assert.strictEqual(await runDaemonCommand({ kind: 'daemon', action: 'stop', roots: [] }, cwd, io), 1);
    assert.deepStrictEqual(out, ['err:unreachable']);
  });
});
