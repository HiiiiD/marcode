import * as assert from 'assert';
import { detectWorktreeAdd } from '../../host/worktree-detect';
import type { ToolCall } from '../../providers/canonical/tool-call';

function cmd(command: string): ToolCall {
  return { kind: 'command', label: 'Bash', command };
}

suite('detectWorktreeAdd', () => {
  test('finds the path with -b', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add ../trees/feat-x -b feat-x'), true),
      '../trees/feat-x',
    );
  });

  test('finds the path before a commitish', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add ../trees/hotfix origin/main'), true),
      '../trees/hotfix',
    );
  });

  test('handles --detach', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add --detach ../trees/probe'), true),
      '../trees/probe',
    );
  });

  test('handles a quoted path with spaces', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add "../my trees/feat x" -b feat-x'), true),
      '../my trees/feat x',
    );
  });

  test('finds it in an && chain', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('cd /repo && git worktree add ../t/a -b a && cd ../t/a'), true),
      '../t/a',
    );
  });

  test('ignores a failed command', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add ../t/a'), false), undefined);
  });

  test('ignores other worktree subcommands', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree list'), true), undefined);
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree remove ../t/a'), true), undefined);
  });

  test('ignores every non-command kind', () => {
    const read: ToolCall = { kind: 'file-read', label: 'Read', path: '/a/b.ts' };
    assert.strictEqual(detectWorktreeAdd(read, true), undefined);
  });

  test('returns nothing when no path can be read', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add'), true), undefined);
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add -b only-a-branch'), true), undefined);
  });
});
