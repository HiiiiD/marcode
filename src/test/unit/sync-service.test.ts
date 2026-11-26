import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { configPath } from '../../host/config-file';
import type { ProjectRef } from '../../host/project/project-resolver';
import { applyProjectChoice, projectRows } from '../../host/sync/project-rows';
import { SyncService } from '../../host/sync/sync-service';
import type { HostToWebview, SyncPanel } from '../../protocol/messages';
import { readCredentials } from '../../sync/credentials';
import { encodeCode } from '../../sync/pairing-code';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

interface Srv { url: string; code: string; store: SyncStore; stop(): Promise<void>; restart(): Promise<void> }
async function server(): Promise<Srv> {
  const store = new SyncStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-svc-')), 's.sqlite'));
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  let s = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
  const port = Number(new URL(s.url).port);
  let running = true;
  cleanups.push(async () => { if (running) { await s.close(); } store.close(); });
  return {
    url: s.url, code: encodeCode('MRB', bytes), store,
    stop: async () => { running = false; await s.close(); },
    restart: async () => { s = await startSyncServer({ store, host: '127.0.0.1', port }); running = true; },
  };
}

async function service(opts: { roots?: string[]; resolve?: (cwd: string) => Promise<ProjectRef | undefined>; healthMs?: number } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-svc-home-'));
  await fs.writeFile(configPath(home), JSON.stringify({ theme: {} }));
  const broadcasts: HostToWebview[] = [];
  const svc = new SyncService({
    home, configFile: configPath(home), roots: () => opts.roots ?? [], overrides: [],
    resolve: opts.resolve ?? (async () => undefined), broadcast: (m) => { broadcasts.push(m); },
    hostname: () => 'desk', healthMs: opts.healthMs ?? 60_000, clientOptions: { timeoutMs: 2000 },
  });
  cleanups.push(() => svc.dispose());
  const handle = (msg: Parameters<SyncService['handle']>[0]) => svc.handle(msg, () => {});
  return { home, svc, broadcasts, handle };
}

const paired = (p: SyncPanel) => { assert.strictEqual(p.state, 'paired'); return p as Extract<SyncPanel, { state: 'paired' }>; };
const until = async (done: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) { throw new Error('timed out'); } await new Promise((r) => setTimeout(r, 10)); }
};

suite('SyncService', () => {
  test('an unpaired machine offers its hostname as the device name', async () => {
    const { handle } = await service();
    assert.deepStrictEqual(await handle({ t: 'sync-open' }), { state: 'unpaired', defaultName: 'desk' });
  });

  test('setup errors land on the field they are about', async () => {
    const s = await server();
    const { handle } = await service();
    const wrong = await handle({ t: 'sync-setup', server: s.url, code: encodeCode('MRB', randomBytes(16)), name: 'desk' });
    assert.strictEqual(wrong.state === 'unpaired' && wrong.error?.field, 'code');
    const plain = await handle({ t: 'sync-setup', server: 'http://sync.example.com', code: s.code, name: 'desk' });
    assert.strictEqual(plain.state === 'unpaired' && plain.error?.field, 'server');
    assert.strictEqual(plain.state === 'unpaired' && plain.error?.message.includes('https'), true);
  });

  test('setup pairs the machine and remembers the server in config.json', async () => {
    const s = await server();
    const { home, handle } = await service();
    const p = paired(await handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' }));
    assert.strictEqual(p.connection, 'connected');
    assert.deepStrictEqual(p.devices.map((d) => [d.name, d.self]), [['desk', true]]);
    const config = JSON.parse(await fs.readFile(configPath(home), 'utf8')) as { sync: unknown; theme: unknown };
    assert.deepStrictEqual(config.sync, { server: s.url, deviceName: 'desk' });
    assert.deepStrictEqual(config.theme, {});
  });

  test('pairing shows a code another machine can join with', async () => {
    const s = await server();
    const desk = await service();
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    const p = paired(await desk.handle({ t: 'sync-pair' }));
    assert.strictEqual(p.pairing?.code.startsWith('MRC-'), true);
    assert.strictEqual(p.pairing!.joinCommand, `marcode sync join ${s.url} ${p.pairing!.code}`);
    const laptop = await service();
    const joined = paired(await laptop.handle({ t: 'sync-join', server: s.url, code: p.pairing!.code, name: 'laptop' }));
    assert.deepStrictEqual(joined.devices.map((d) => d.name).sort(), ['desk', 'laptop']);
  });

  test('two pair requests in flight make one pairing', async () => {
    const s = await server();
    const desk = await service();
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    const [a, b] = await Promise.all([desk.handle({ t: 'sync-pair' }), desk.handle({ t: 'sync-pair' })]);
    assert.strictEqual(paired(a).pairing!.code, paired(b).pairing!.code);
  });

  test('revoke, and finishing a revoke whose key change never happened', async () => {
    const s = await server();
    const desk = await service();
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    const join = async (name: string) => {
      const code = paired(await desk.handle({ t: 'sync-pair' })).pairing!.code;
      const other = await service();
      await other.handle({ t: 'sync-join', server: s.url, code, name });
      return (await readCredentials(other.home))!.deviceId;
    };
    const laptop = await join('laptop');
    const revoked = paired(await desk.handle({ t: 'sync-revoke', deviceId: laptop }));
    assert.strictEqual(revoked.devices.find((d) => d.deviceId === laptop)?.revoked, true);
    assert.strictEqual(revoked.devices.find((d) => d.deviceId === laptop)?.unfinishedRevoke, undefined);
    const tower = await join('tower');
    s.store.revoke(tower);
    const half = paired(await desk.handle({ t: 'sync-open' }));
    assert.strictEqual(half.devices.find((d) => d.deviceId === tower)?.unfinishedRevoke, true);
    const done = paired(await desk.handle({ t: 'sync-revoke', deviceId: tower }));
    assert.strictEqual(done.devices.find((d) => d.deviceId === tower)?.unfinishedRevoke, undefined);
  });

  test('the health check reports offline, recovery and revocation', async () => {
    const s = await server();
    const desk = await service({ healthMs: 50 });
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    desk.svc.start();
    const statuses = () => desk.broadcasts.flatMap((m) => (m.t === 'sync-status' ? [m.status] : []));
    await until(() => desk.svc.status() === 'ok');
    await s.stop();
    await until(() => statuses().includes('offline'));
    await s.restart();
    await until(() => statuses().lastIndexOf('ok') > statuses().indexOf('offline'));
    s.store.revoke((await readCredentials(desk.home))!.deviceId);
    await until(() => desk.svc.status() === 'revoked');
    assert.strictEqual(paired(await desk.handle({ t: 'sync-open' })).connection, 'revoked');
  });

  test('forget and leave return the machine to unpaired', async () => {
    const s = await server();
    const desk = await service();
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    assert.strictEqual((await desk.handle({ t: 'sync-leave' })).state, 'unpaired');
    assert.strictEqual(await readCredentials(desk.home), undefined);
    assert.strictEqual(desk.svc.status(), 'off');
  });

  test('a project choice is written to config.json, other keys kept', async () => {
    const s = await server();
    const resolve = async (cwd: string) => ({ projectId: 'github.com/a/b', root: cwd });
    const desk = await service({ roots: ['/w/repo'], resolve });
    await desk.handle({ t: 'sync-setup', server: s.url, code: s.code, name: 'desk' });
    const p = paired(await desk.handle({ t: 'sync-project', path: '/w/repo', choice: 'own' }));
    assert.strictEqual(p.projects[0].choice, 'own');
    const config = JSON.parse(await fs.readFile(configPath(desk.home), 'utf8')) as { projects: unknown; theme: unknown };
    assert.deepStrictEqual(config.projects, { overrides: [{ path: '/w/repo', project: 'own' }] });
    assert.deepStrictEqual(config.theme, {});
  });

  test('nothing rejects: a garbage join is an error panel', async () => {
    const { handle } = await service();
    const p = await handle({ t: 'sync-join', server: 'https://127.0.0.1:1', code: 'nonsense', name: 'x' });
    assert.strictEqual(p.state === 'unpaired' && p.error !== undefined, true);
  });
});

suite('project rows', () => {
  const refs: Record<string, ProjectRef | undefined> = {
    '/w/a': { projectId: 'github.com/x/a', root: '/w/a' },
    '/w/b': { projectId: 'local:/w/b', root: '/w/b' },
    '/w/c': { projectId: 'github.com/x/a', root: '/w/c' },
    '/w/d': undefined,
  };
  const resolve = async (cwd: string) => refs[cwd];

  test('each root says whether its memory is shared', async () => {
    const rows = await projectRows(['/w/a', '/w/b', '/w/c', '/w/d'], [
      { path: '/w/b', project: 'own' }, { path: '/w/c', project: 'github.com/x/a' },
    ], resolve);
    assert.deepStrictEqual(rows.map((r) => [r.name, r.choice, r.projectId]), [
      ['a', 'shared', 'github.com/x/a'], ['b', 'own', 'local:/w/b'], ['c', 'linked', 'github.com/x/a'], ['d', 'none', undefined],
    ]);
  });

  test('a choice replaces that root entry, and shared removes it', () => {
    const start = [{ path: '/w/a', project: 'own' }, { path: '/w/z', project: 'own' }];
    assert.deepStrictEqual(applyProjectChoice(start, '/w/a', { link: 'github.com/q/r' }), [
      { path: '/w/z', project: 'own' }, { path: '/w/a', project: 'github.com/q/r' },
    ]);
    assert.deepStrictEqual(applyProjectChoice(start, '/w/a', 'shared'), [{ path: '/w/z', project: 'own' }]);
  });
});
