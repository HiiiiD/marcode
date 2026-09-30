import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import { countOldSessions, declineMigration, importOldStorage, migrateStorage, readMigrationMarker } from '../../host/migrate-storage';

const idx = (ids: string[], layoutId = 'x') => JSON.stringify({
  version: 2,
  sessions: ids.map((id) => ({ id, title: id, name: id })),
  layout: { root: { kind: 'leaf', sessionId: layoutId, size: 100 }, presets: [] },
});

suite('migrate-storage', () => {
  let oldDir: string;
  let newDir: string;
  setup(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-mig-'));
    oldDir = path.join(base, 'old');
    newDir = path.join(base, 'new');
    await fs.mkdir(path.join(oldDir, 'sessions'), { recursive: true });
    await fs.mkdir(newDir, { recursive: true });
  });
  teardown(async () => { await fs.rm(path.dirname(oldDir), { recursive: true, force: true }); });

  const seedOld = async () => {
    await fs.writeFile(path.join(oldDir, 'index.json'), idx(['s1', 's2']));
    await fs.writeFile(path.join(oldDir, 'catalog.json'), '{"providers":{}}');
    await fs.writeFile(path.join(oldDir, 'sessions', 's1.jsonl'), 'line1\n');
    await fs.writeFile(path.join(oldDir, 'sessions', 's2.jsonl'), 'line2\n');
  };

  test('countOldSessions reads the roster size, and is 0 with nothing there', async () => {
    assert.strictEqual(await countOldSessions(oldDir), 0);
    await seedOld();
    assert.strictEqual(await countOldSessions(oldDir), 2);
  });

  test('it copies everything, leaves the old directory untouched and writes the marker', async () => {
    await seedOld();
    const before = await fs.readFile(path.join(oldDir, 'index.json'), 'utf8');
    const r = await migrateStorage(oldDir, newDir, () => 42);
    assert.deepStrictEqual(r, { ok: true, sessions: 2 });
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions', 's1.jsonl'), 'utf8'), 'line1\n');
    assert.strictEqual(await fs.readFile(path.join(oldDir, 'index.json'), 'utf8'), before);
    assert.deepStrictEqual(await readMigrationMarker(newDir), { from: oldDir, at: 42, sessions: 2 });
  });

  test('a destination that already holds a session keeps it and gains the rest', async () => {
    await seedOld();
    await fs.writeFile(path.join(newDir, 'index.json'), idx(['s2', 's9'], 'kept'));
    await fs.mkdir(path.join(newDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(newDir, 'sessions', 's2.jsonl'), 'DEST\n');
    await migrateStorage(oldDir, newDir);
    const merged = JSON.parse(await fs.readFile(path.join(newDir, 'index.json'), 'utf8')) as { sessions: { id: string }[] };
    assert.deepStrictEqual(merged.sessions.map((s) => s.id).sort(), ['s1', 's2', 's9']);
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions', 's2.jsonl'), 'utf8'), 'DEST\n');
  });

  test('a failure halfway removes what this run created and writes no marker', async () => {
    await seedOld();
    await fs.mkdir(path.join(oldDir, 'sessions', 's3.jsonl'));
    const r = await migrateStorage(oldDir, newDir);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(await readMigrationMarker(newDir), undefined);
    assert.deepStrictEqual(await fs.readdir(newDir), []);
  });

  test('running it twice is a no-op the second time', async () => {
    await seedOld();
    await migrateStorage(oldDir, newDir);
    const again = await migrateStorage(oldDir, newDir);
    assert.deepStrictEqual(again, { ok: true, sessions: 2 });
  });

  test('no old directory is a clear reason, not a throw', async () => {
    const r = await migrateStorage(path.join(oldDir, 'missing'), newDir);
    assert.strictEqual(r.ok, false);
  });

  test('a declined migration is remembered', async () => {
    await declineMigration(newDir, oldDir);
    assert.strictEqual((await readMigrationMarker(newDir))?.declined, true);
  });

  test('an old index at another transcript version is refused with a reason, copies nothing, and is not offered again', async () => {
    await seedOld();
    await fs.writeFile(path.join(oldDir, 'index.json'), JSON.stringify({ version: 1, sessions: [{ id: 's1' }], layout: {} }));
    const r = await importOldStorage(oldDir, newDir);
    assert.strictEqual(r.kind, 'failed');
    assert.strictEqual(r.kind === 'failed' && r.reason.includes('version'), true);
    assert.deepStrictEqual((await fs.readdir(newDir)).filter((n) => n !== 'migrated.json'), []);
    assert.deepStrictEqual(await importOldStorage(oldDir, newDir), { kind: 'none' });
  });

  test('importing before the host starts puts the old sessions in the roster it reads at init, no reload needed', async () => {
    const row = (id: string) => ({
      id, providerId: 'fake', model: 'm', title: id, name: id, cwd: newDir, status: 'idle',
      permissionMode: 'default', includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1,
    });
    await fs.writeFile(path.join(oldDir, 'index.json'), JSON.stringify({
      version: 2, sessions: [row('s1'), row('s2')], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] },
    }));
    assert.deepStrictEqual(await importOldStorage(oldDir, newDir), { kind: 'imported', sessions: 2 });
    const host = await createHost({
      workspaceDir: newDir, hostKind: 'vscode', workspaceRoots: () => [newDir], emit: () => {}, notify: { warn: () => {} },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    try {
      await host.init();
      assert.deepStrictEqual(host.manager.summaries().map((x) => x.id).sort(), ['s1', 's2']);
    } finally {
      await host.dispose();
    }
  });

  test('importing is skipped once a marker exists, and when the old directory is the new one', async () => {
    await seedOld();
    await declineMigration(newDir, oldDir);
    assert.deepStrictEqual(await importOldStorage(oldDir, newDir), { kind: 'none' });
    assert.deepStrictEqual(await importOldStorage(oldDir, oldDir), { kind: 'none' });
  });
});
