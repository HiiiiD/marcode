import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTerminalFileIndex } from '../../host/terminal-file-index';

suite('terminal file index', () => {
  let tmp: string;
  setup(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-fidx-')); });
  teardown(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  test('in a git repo it lists tracked and untracked files but not ignored ones', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret.txt\n');
    await fs.writeFile(path.join(tmp, 'app.ts'), '');
    await fs.writeFile(path.join(tmp, 'secret.txt'), '');
    const found = await createTerminalFileIndex(tmp).search('.');
    assert.deepStrictEqual(found.map((f) => f.path).sort(), ['.gitignore', 'app.ts']);
  });

  test('outside a repo it walks the tree, skipping node_modules and .git', async () => {
    await fs.mkdir(path.join(tmp, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'a', 'b', 'deep.ts'), '');
    await fs.mkdir(path.join(tmp, 'node_modules'));
    await fs.writeFile(path.join(tmp, 'node_modules', 'deep-dep.js'), '');
    const found = await createTerminalFileIndex(tmp).search('deep');
    assert.deepStrictEqual(found.map((f) => f.path), ['a/b/deep.ts']);
  });
});
