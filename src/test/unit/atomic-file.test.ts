import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExclusive, writeFileAtomic } from '../../host/atomic-file';

suite('atomic-file', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-atomic-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('writeFileAtomic replaces the content and leaves no temp file', async () => {
    const file = path.join(dir, 'a.json');
    await writeFileAtomic(file, '1');
    await writeFileAtomic(file, '2');
    assert.strictEqual(await fs.readFile(file, 'utf8'), '2');
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('writeFileAtomic creates missing parent directories', async () => {
    const file = path.join(dir, 'x', 'y', 'a.json');
    await writeFileAtomic(file, 'ok');
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'ok');
  });

  test('createExclusive: the first caller wins and the loser does not overwrite', async () => {
    const file = path.join(dir, 'lock');
    assert.strictEqual(await createExclusive(file, 'first'), true);
    assert.strictEqual(await createExclusive(file, 'second'), false);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'first');
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('createExclusive: exactly one of many racers wins and the file is whole', async () => {
    const file = path.join(dir, 'race');
    const body = JSON.stringify({ pad: 'x'.repeat(4096) });
    const results = await Promise.all(Array.from({ length: 20 }, () => createExclusive(file, body)));
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual(await fs.readFile(file, 'utf8'), body);
  });
});
