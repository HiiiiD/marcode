import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runConfig, runLogin, runMigrate, type SubIo } from '../../tui/subcommands';
import { TRANSCRIPT_VERSION } from '../../host/transcript-store';

suite('tui subcommands', () => {
  let tmp: string;
  setup(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-sub-'))); });
  teardown(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const io = (over: Partial<SubIo> = {}) => {
    const out: string[] = []; const err: string[] = []; const ran: string[] = [];
    const base: SubIo = {
      home: path.join(tmp, 'home'),
      out: (l) => out.push(l), err: (l) => err.push(l),
      spawn: async (c) => { ran.push(c); return 0; },
      editor: () => undefined,
      bootConfig: { enabledProviders: ['claude', 'codex'] },
      ...over,
    };
    return { base, out, err, ran };
  };

  test('login for an unknown provider lists the known ones and exits 1', async () => {
    const t = io();
    const code = await runLogin('nope', tmp, t.base);
    assert.strictEqual(code, 1);
    assert.strictEqual(t.err.some((l) => l.includes('no sign-in flow for nope; known: ')), true);
    assert.strictEqual(t.ran.length, 0);
  });

  test('login for claude runs its recipe command and returns its exit code', async () => {
    const t = io({ spawn: async (c) => { t.ran.push(c); return 7; } });
    const code = await runLogin('claude', tmp, t.base);
    assert.strictEqual(code, 7);
    assert.strictEqual(t.ran.some((c) => c.includes('auth login')), true);
  });

  test('config creates the file and prints its path when no editor is set', async () => {
    const t = io();
    const code = await runConfig(t.base);
    assert.strictEqual(code, 0);
    assert.strictEqual(t.out.some((l) => l.endsWith('config.json')), true);
    await fs.access(path.join(tmp, 'home', 'config.json'));
  });

  test('config opens the editor with the path quoted when a home has a space', async () => {
    const home = path.join(tmp, 'my home');
    const t = io({ home, editor: () => 'vim' });
    assert.strictEqual(await runConfig(t.base), 0);
    assert.deepStrictEqual(t.ran, [`vim "${path.join(home, 'config.json')}"`]);
  });

  test('config never overwrites an existing file', async () => {
    const home = path.join(tmp, 'home');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'config.json'), '{"favoriteModels":["x"]}');
    await runConfig(io().base);
    assert.strictEqual(await fs.readFile(path.join(home, 'config.json'), 'utf8'), '{"favoriteModels":["x"]}');
  });

  test('config on an unwritable home reports and exits 1', async () => {
    const blocker = path.join(tmp, 'file');
    await fs.writeFile(blocker, 'x');
    const t = io({ home: path.join(blocker, 'sub') });
    assert.strictEqual(await runConfig(t.base), 1);
    assert.strictEqual(t.err.length > 0, true);
  });

  suite('migrate', () => {
    const makeOld = async () => {
      const old = path.join(tmp, 'old');
      await fs.mkdir(path.join(old, 'sessions'), { recursive: true });
      await fs.writeFile(path.join(old, 'index.json'), JSON.stringify({ version: TRANSCRIPT_VERSION, sessions: [{ id: 's1' }] }));
      await fs.writeFile(path.join(old, 'sessions', 's1.jsonl'), '{}\n');
      return old;
    };
    const jsonls = async (home: string) => {
      const found: string[] = [];
      const walk = async (d: string): Promise<void> => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) { await walk(path.join(d, e.name)); } else if (e.name === 's1.jsonl') { found.push(path.join(d, e.name)); }
        }
      };
      await walk(home);
      return found;
    };

    test('imports sessions into the workspace dir and re-running is harmless', async () => {
      const old = await makeOld();
      const t = io();
      assert.strictEqual(await runMigrate(old, tmp, t.base), 0);
      assert.strictEqual(t.out.some((l) => l.includes('Imported 1 session')), true);
      assert.strictEqual((await jsonls(t.base.home!)).length, 1);
      const again = io();
      assert.strictEqual(await runMigrate(old, tmp, again.base), 0);
      assert.strictEqual((await jsonls(t.base.home!)).length, 1);
    });

    test('a missing old dir has nothing to import and exits 0 with a message', async () => {
      const t = io();
      assert.strictEqual(await runMigrate(path.join(tmp, 'absent'), tmp, t.base), 0);
      assert.strictEqual(t.out.some((l) => l.includes('nothing to import from')), true);
    });

    test('a version mismatch prints the reason and exits 1', async () => {
      const old = path.join(tmp, 'old2');
      await fs.mkdir(old, { recursive: true });
      await fs.writeFile(path.join(old, 'index.json'), JSON.stringify({ version: 999, sessions: [{ id: 'a' }] }));
      const t = io();
      assert.strictEqual(await runMigrate(old, tmp, t.base), 1);
      assert.strictEqual(t.err.some((l) => l.includes('version 999')), true);
    });
  });
});
