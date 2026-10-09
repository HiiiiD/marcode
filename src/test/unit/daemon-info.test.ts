import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { endpointFor } from '../../daemon/endpoint';
import { newToken, readDaemonInfo, removeDaemonInfo, writeDaemonInfo, type DaemonInfo } from '../../daemon/daemon-info';

suite('daemon info', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-dinfo-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const info = (pid = 42): DaemonInfo => ({
    pid, endpoint: 'e', token: 't', protocolVersion: 1, appVersion: '1.0.0', startedAt: 1,
  });

  test('windows endpoint is a pipe name derived from the dir', () => {
    const a = endpointFor('C:\\a', 'win32');
    assert.strictEqual(a.startsWith('\\\\.\\pipe\\marcode-'), true);
    assert.notStrictEqual(a, endpointFor('C:\\b', 'win32'));
    assert.strictEqual(a, endpointFor('C:\\a', 'win32'));
  });

  test('posix endpoint is a short socket path', () => {
    const p = endpointFor('/home/x/.marcode/workspaces/a-very-long-slug-name', 'linux');
    assert.strictEqual(p.endsWith('.sock'), true);
    assert.strictEqual(p.length < 100, true);
  });

  test('write then read round-trips; remove only removes our own pid', async () => {
    await writeDaemonInfo(dir, info(42));
    assert.deepStrictEqual(await readDaemonInfo(dir), info(42));
    await removeDaemonInfo(dir, 7);
    assert.strictEqual((await readDaemonInfo(dir))?.pid, 42);
    await removeDaemonInfo(dir, 42);
    assert.strictEqual(await readDaemonInfo(dir), undefined);
  });

  test('a corrupt or partial daemon.json reads as absent', async () => {
    await fs.writeFile(path.join(dir, 'daemon.json'), '{"pid":');
    assert.strictEqual(await readDaemonInfo(dir), undefined);
    await fs.writeFile(path.join(dir, 'daemon.json'), '{"pid":1}');
    assert.strictEqual(await readDaemonInfo(dir), undefined);
  });

  test('configSignature is optional, and round-trips when present', async () => {
    await writeDaemonInfo(dir, { ...info(), configSignature: 'sig' });
    assert.strictEqual((await readDaemonInfo(dir))?.configSignature, 'sig');
    await fs.writeFile(path.join(dir, 'daemon.json'), JSON.stringify({ ...info(), configSignature: 5 }));
    assert.strictEqual(await readDaemonInfo(dir), undefined);
  });

  test('tokens are long and distinct', () => {
    assert.strictEqual(newToken().length >= 32, true);
    assert.notStrictEqual(newToken(), newToken());
  });
});
