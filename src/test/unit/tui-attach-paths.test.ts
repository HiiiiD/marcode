import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existingFileUris } from '../../tui/attach-paths';

suite('tui attach paths', () => {
  let dir = '';
  setup(() => { dir = mkdtempSync(join(tmpdir(), 'marcode-attach-')); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  test('existing regular files become file URIs', () => {
    const a = join(dir, 'a b.txt');
    writeFileSync(a, 'x');
    assert.deepStrictEqual(existingFileUris([a]), [pathToFileURL(a).href]);
  });
  test('a missing path, a directory or no paths yields undefined', () => {
    const a = join(dir, 'a.txt');
    writeFileSync(a, 'x');
    assert.strictEqual(existingFileUris([a, join(dir, 'missing.txt')]), undefined);
    assert.strictEqual(existingFileUris([dir]), undefined);
    assert.strictEqual(existingFileUris([]), undefined);
  });
});
