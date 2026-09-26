import * as assert from 'assert';
import { ruleFor } from '../../host/permission-rules';
import type { ToolCall } from '../../providers/canonical/tool-call';

const cmd = (command: string): ToolCall => ({ kind: 'command', label: 'Bash', command });

suite('ruleFor', () => {
  test('a shell command keys on first word + subcommand', () => {
    assert.deepStrictEqual(ruleFor(cmd('git status --short')), {
      key: 'command:git status', label: 'Always allow `git status`',
    });
  });

  test('a single-word command keys on that word', () => {
    assert.strictEqual(ruleFor(cmd('ls'))?.key, 'command:ls');
  });

  test('a flag as second token keys on the first word only when nothing else follows', () => {
    assert.strictEqual(ruleFor(cmd('ls -la'))?.key, 'command:ls');
    assert.strictEqual(ruleFor(cmd('git -C x status')), undefined);
  });

  test('chained, piped, substituted, redirected and multi-line commands get no rule', () => {
    for (const c of [
      'git status && rm -rf x', 'a || b', 'a; b', 'a | b', 'echo `x`', 'echo $(x)',
      'echo hi > f', 'cat < f', 'sleep 1 &', 'a\nb',
    ]) {
      assert.strictEqual(ruleFor(cmd(c)), undefined, c);
    }
  });

  test('env-prefixed and wrapper commands get no rule', () => {
    for (const c of ['FOO=1 make', 'sudo ls', 'env ls', 'bash x.sh', 'sh -c x', 'eval x', 'xargs ls', 'pwsh -c x']) {
      assert.strictEqual(ruleFor(cmd(c)), undefined, c);
    }
  });

  test('an empty command gets no rule', () => {
    assert.strictEqual(ruleFor(cmd('   ')), undefined);
  });

  test('create/modify edits key on the kind; delete/rename get no rule', () => {
    const edit = (op: 'create' | 'modify' | 'delete' | 'rename'): ToolCall => ({
      kind: 'file-edit', label: 'Edit', files: [{ path: '/a', op }],
    });
    assert.deepStrictEqual(ruleFor(edit('modify')), { key: 'file-edit', label: 'Always allow file edits' });
    assert.strictEqual(ruleFor(edit('create'))?.key, 'file-edit');
    assert.strictEqual(ruleFor(edit('delete')), undefined);
    assert.strictEqual(ruleFor(edit('rename')), undefined);
    assert.strictEqual(ruleFor({ kind: 'file-edit', label: 'Edit', files: [] }), undefined);
  });

  test('mcp keys on server + tool', () => {
    assert.deepStrictEqual(
      ruleFor({ kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' }),
      { key: 'mcp:github:create_pr', label: 'Always allow github create_pr' },
    );
  });

  test('plan, other and the rest get no rule', () => {
    assert.strictEqual(ruleFor({ kind: 'plan', label: 'Plan', text: 'x' }), undefined);
    assert.strictEqual(ruleFor({ kind: 'other', label: 'X', raw: {} }), undefined);
    assert.strictEqual(ruleFor({ kind: 'web', label: 'Fetch', url: 'https://x' }), undefined);
  });
});
