import * as assert from 'assert';
import { detectWorktreeAdd } from '../../host/worktree-detect';
import type { ToolCall, ToolOutput } from '../../providers/canonical/tool-call';

function cmd(command: string): ToolCall {
  return { kind: 'command', label: 'Bash', command };
}

function enterWorktree(name: string): ToolCall {
  return { kind: 'other', label: 'EnterWorktree', raw: { name } };
}

function text(value: string): ToolOutput {
  return { kind: 'text', text: value };
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

  // The built-in EnterWorktree tool never runs a shell command, and its input
  // carries only the worktree's name — the path exists solely in its output.
  test('reads the path out of an EnterWorktree result', () => {
    assert.strictEqual(
      detectWorktreeAdd(enterWorktree('session-attachments'), true, text(
        'Created worktree at E:\\repo\\.claude\\worktrees\\session-attachments on branch '
        + 'worktree-session-attachments. The session is now working in the worktree.',
      )),
      'E:\\repo\\.claude\\worktrees\\session-attachments',
    );
  });

  test('reads an EnterWorktree path containing spaces', () => {
    assert.strictEqual(
      detectWorktreeAdd(enterWorktree('feat x'), true, text(
        'Created worktree at /home/me/my trees/feat x on branch worktree-feat-x.',
      )),
      '/home/me/my trees/feat x',
    );
  });

  test('ignores a failed or unreadable EnterWorktree', () => {
    assert.strictEqual(
      detectWorktreeAdd(enterWorktree('a'), false, text('Created worktree at /t/a on branch b.')),
      undefined,
    );
    assert.strictEqual(detectWorktreeAdd(enterWorktree('a'), true, { kind: 'none' }), undefined);
    assert.strictEqual(detectWorktreeAdd(enterWorktree('a'), true, undefined), undefined);
    assert.strictEqual(
      detectWorktreeAdd(enterWorktree('a'), true, text('Worktree a already exists.')),
      undefined,
    );
  });

  test('ignores other built-in tools with the same output shape', () => {
    const exit: ToolCall = { kind: 'other', label: 'ExitWorktree', raw: {} };
    assert.strictEqual(
      detectWorktreeAdd(exit, true, text('Created worktree at /t/a on branch b.')),
      undefined,
    );
  });
});
