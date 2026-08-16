// Turning a provider's idea of a path into git's idea of a path.
//
// Pure, and tested hard, because this is where attribution silently fails:
// a path that does not match is not an error, it is a file that quietly
// belongs to nobody.

import * as assert from 'assert';
import { isAbsolute, join } from 'node:path';
import { claimedPaths, toRepoRelative } from '../../host/claim-paths';
import type { ToolCall } from '../../providers/canonical/tool-call';

const root = isAbsolute('/repo') && process.platform !== 'win32' ? '/repo' : 'C:\\repo';
const inRoot = (...parts: string[]) => join(root, ...parts);

function edit(...paths: string[]): ToolCall {
  return {
    kind: 'file-edit',
    label: 'Edit',
    files: paths.map((path) => ({ path, op: 'modify' as const })),
  };
}

suite('claim paths', () => {
  test('an absolute POSIX path from a provider resolves unchanged', () => {
    const posix = root.replace(/\\/g, '/');
    const claimed = claimedPaths(edit(`${posix}/src/a.ts`), root);
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(toRepoRelative(claimed[0], root), 'src/a.ts');
  });

  test('a relative path resolves against the session cwd', () => {
    const claimed = claimedPaths(edit('src/b.ts'), inRoot('nested'));
    assert.strictEqual(toRepoRelative(claimed[0], root), 'nested/src/b.ts');
  });

  test('a path outside the tree is dropped, never clamped', () => {
    const outside = process.platform === 'win32' ? 'C:\\elsewhere\\x.ts' : '/elsewhere/x.ts';
    assert.strictEqual(toRepoRelative(outside, root), undefined);
  });

  test('the root itself is not a file in the root', () => {
    assert.strictEqual(toRepoRelative(root, root), undefined);
  });

  test('a sibling directory sharing a prefix is not inside the root', () => {
    const sibling = `${root}-other`;
    assert.strictEqual(toRepoRelative(join(sibling, 'a.ts'), root), undefined);
  });

  test('every file in a multi-file edit is claimed', () => {
    const claimed = claimedPaths(edit('a.ts', 'b.ts', 'c.ts'), root);
    assert.strictEqual(claimed.length, 3);
  });

  test('a deletion is still a claim', () => {
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'gone.ts', op: 'delete' }],
    };
    assert.strictEqual(claimedPaths(tool, root).length, 1);
  });

  test('a rename claims both sides', () => {
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'new.ts', op: 'rename' }],
    };
    assert.strictEqual(claimedPaths(tool, root).length, 1);
  });

  test('a tool that is not a file edit claims nothing', () => {
    const tool: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
    assert.deepStrictEqual(claimedPaths(tool, root), []);
  });
});
