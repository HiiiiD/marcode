import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGitRoot } from '../../tui/workspace-root';

suite('tui workspace root', () => {
  let dir: string;
  setup(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-root-'))); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a subfolder of a repo resolves to the repo root', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const sub = path.join(dir, 'a', 'b');
    await fs.mkdir(sub, { recursive: true });
    assert.strictEqual(path.resolve(await findGitRoot(sub)), path.resolve(dir));
  });
  test('outside a repo the cwd is the root, with no throw', async () => {
    assert.strictEqual(path.resolve(await findGitRoot(dir)), path.resolve(dir));
  });
  test('a missing directory falls back to itself', async () => {
    const gone = path.join(dir, 'nope');
    assert.strictEqual(await findGitRoot(gone), gone);
  });
});
