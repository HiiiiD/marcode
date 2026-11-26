import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { readCredentials } from '../../sync/credentials';
import { encodeCode } from '../../sync/pairing-code';
import { hashSecret } from '../../sync-server/auth';
import { parseServerArgs } from '../../sync-server/run';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';
import { runSyncCommand } from '../../tui/sync-commands';

const cleanups: Array<() => Promise<void>> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

async function server(): Promise<{ url: string; code: string; store: SyncStore }> {
  const store = new SyncStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-cmd-')), 's.sqlite'));
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  const s = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await s.close(); store.close(); });
  return { url: s.url, code: encodeCode('MRB', bytes), store };
}

function io(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { home, out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); }, lines: out, errors: err };
}

const home = () => fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-home-'));

suite('marcode sync', () => {
  test('setup, pair, join, devices and revoke work end to end', async () => {
    const s = await server();
    const desk = io(await home());
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'setup', args: [s.url, s.code, '--name', 'desk'] }, desk), 0);
    const config = JSON.parse(await fs.readFile(path.join(desk.home, 'config.json'), 'utf8')) as { sync: unknown };
    assert.deepStrictEqual(config.sync, { server: s.url, deviceName: 'desk' });

    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'pair', args: [] }, desk), 0);
    const code = desk.lines.join('\n').match(/MRC-[0-9A-Z-]+/)?.[0];
    assert.strictEqual(typeof code, 'string');

    const laptop = io(await home());
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'join', args: [s.url, code!, '--name', 'laptop'] }, laptop), 0);
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'devices', args: [] }, desk), 0);
    const table = desk.lines.join('\n');
    assert.strictEqual(table.includes('desk') && table.includes('laptop') && table.includes('this device'), true);

    const laptopId = (await readCredentials(laptop.home))!.deviceId;
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'revoke', args: [laptopId.slice(0, 8)] }, desk), 0);
    assert.notStrictEqual(await runSyncCommand({ kind: 'sync', action: 'devices', args: [] }, laptop), 0);
  });

  test('revoke refuses an ambiguous prefix and this device', async () => {
    const s = await server();
    const desk = io(await home());
    await runSyncCommand({ kind: 'sync', action: 'setup', args: [s.url, s.code] }, desk);
    const self = (await readCredentials(desk.home))!.deviceId;
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'revoke', args: [self.slice(0, 8)] }, desk), 2);
    assert.strictEqual(desk.errors.join('\n').includes('sync leave'), true);
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'revoke', args: [''] }, desk), 2);
  });

  test('commands that need a paired device say so', async () => {
    const lonely = io(await home());
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'pair', args: [] }, lonely), 2);
    assert.strictEqual(lonely.errors.join('\n').includes('sync setup'), true);
  });

  test('leave removes this device everywhere', async () => {
    const s = await server();
    const desk = io(await home());
    await runSyncCommand({ kind: 'sync', action: 'setup', args: [s.url, s.code, '--name', 'desk'] }, desk);
    await runSyncCommand({ kind: 'sync', action: 'pair', args: [] }, desk);
    const code = desk.lines.join('\n').match(/MRC-[0-9A-Z-]+/)![0];
    const laptop = io(await home());
    await runSyncCommand({ kind: 'sync', action: 'join', args: [s.url, code, '--name', 'laptop'] }, laptop);
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'leave', args: [] }, desk), 0);
    assert.strictEqual(await readCredentials(desk.home), undefined);
    assert.strictEqual(desk.lines.join('\n').includes('left the sync server'), true);
    await runSyncCommand({ kind: 'sync', action: 'devices', args: [] }, laptop);
    assert.strictEqual(laptop.lines.some((l) => l.startsWith('desk') && l.includes('revoked')), true);
  });
});

suite('marcode sync revoke, interrupted', () => {
  test('revoking a device that is already revoked still rotates the key', async () => {
    const s = await server();
    const desk = io(await home());
    await runSyncCommand({ kind: 'sync', action: 'setup', args: [s.url, s.code, '--name', 'desk'] }, desk);
    await runSyncCommand({ kind: 'sync', action: 'pair', args: [] }, desk);
    const code = desk.lines.join('\n').match(/MRC-[0-9A-Z-]+/)![0];
    const laptop = io(await home());
    await runSyncCommand({ kind: 'sync', action: 'join', args: [s.url, code, '--name', 'laptop'] }, laptop);
    const laptopId = (await readCredentials(laptop.home))!.deviceId;
    s.store.revoke(laptopId);
    assert.strictEqual(await runSyncCommand({ kind: 'sync', action: 'revoke', args: [laptopId.slice(0, 8)] }, desk), 0);
    assert.deepStrictEqual((await readCredentials(desk.home))!.syncKeys.map((k) => k.epoch), [1, 2]);
  });
});

suite('sync-server flags', () => {
  test('defaults and overrides', () => {
    assert.deepStrictEqual(parseServerArgs([]), { kind: 'serve', data: path.resolve('marcode-sync'), port: 8787, host: '127.0.0.1' });
    assert.deepStrictEqual(parseServerArgs(['--data', '/d', '--port', '9000', '--host', '0.0.0.0']), { kind: 'serve', data: '/d', port: 9000, host: '0.0.0.0' });
    assert.deepStrictEqual(parseServerArgs(['--help']), { kind: 'help' });
    assert.strictEqual(parseServerArgs(['--port', 'abc']).kind, 'error');
    assert.strictEqual(parseServerArgs(['--wat']).kind, 'error');
  });
});
