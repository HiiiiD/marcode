import * as assert from 'assert';
import { ruleFor } from '../../host/permission-rules';
import type { ToolCall } from '../../providers/canonical/tool-call';

const cmd = (command: string, extra: object = {}): ToolCall => (
  { kind: 'command', label: 'Bash', command, ...extra }
);
const rule = (t: ToolCall) => ruleFor(t, '/w');

suite('ruleFor', () => {
  suite('shell commands', () => {
    test('an allow-listed verb keys on first word + subcommand', () => {
      assert.deepStrictEqual(rule(cmd('git status --short')), {
        key: 'command:git status', label: 'Always allow `git status`',
      });
      assert.strictEqual(rule(cmd('yarn test:unit'))?.key, 'command:yarn test:unit');
    });

    test('a read-only single-word tool keys on that word, with or without arguments', () => {
      assert.strictEqual(rule(cmd('ls'))?.key, 'command:ls');
      assert.strictEqual(rule(cmd('ls -la'))?.key, 'command:ls');
      assert.strictEqual(rule(cmd('cat a.txt'))?.key, 'command:cat');
    });

    test('a verb outside the allow-list gets no rule', () => {
      for (const c of [
        'timeout 60 yarn test', 'python a.py', 'node x.js', 'rm foo.txt', 'rm -rf x', 'find . -exec rm {} +',
        "awk 'BEGIN{system(\"id\")}' f", 'watch x', 'Get-ChildItem a.txt', '. ./x.sh', 'source x',
        'ssh host id', 'docker exec x y', 'curl http://x',
      ]) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('a path, .exe or wrapper spelling of the first word gets no rule', () => {
      for (const c of [
        '/usr/bin/env bash x', 'bash.exe x', 'cmd.exe /c del x', 'powershell.exe x.ps1', 'sudo ls', 'env ls',
        'bash x.sh', 'sh -c x', 'eval x', 'xargs ls', 'pwsh -c x', './ls', 'FOO=1 make',
      ]) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('git subcommands outside the list and flag-hidden verbs get no rule', () => {
      for (const c of ['git push', 'git config core.fsmonitor x', 'git reset --hard', 'git -C x status', 'git -c a=b log', 'git']) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('package-manager script runners get no rule', () => {
      for (const c of ['yarn run x', 'npm exec x', 'npx x', 'pnpm dlx x', 'yarn', 'npm publish']) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('exec-capable flags on an allow-listed verb get no rule', () => {
      for (const c of [
        'git diff --output=x', 'git log --open-files-in-pager=sh', 'rg --pre=sh foo', 'rg foo --pre sh',
        'git log -c x',
      ]) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('chained, piped, substituted, redirected, grouped and multi-line commands get no rule', () => {
      for (const c of [
        'git status && rm -rf x', 'ls || b', 'ls; b', 'ls | b', 'ls `x`', 'ls $(x)', 'ls (x)', 'ls {x}',
        'ls > f', 'cat < f', 'ls &', 'ls\nb', 'ls %VAR%',
      ]) {
        assert.strictEqual(rule(cmd(c)), undefined, c);
      }
    });

    test('a Skill call is never a shell rule', () => {
      assert.strictEqual(rule(cmd('git status', { skill: 'fix' })), undefined);
      assert.strictEqual(rule(cmd('fix the tests', { label: 'Skill', skill: 'fix' })), undefined);
    });

    test('an empty command gets no rule', () => {
      assert.strictEqual(rule(cmd('   ')), undefined);
    });
  });

  suite('file edits', () => {
    const edit = (path: string, op: 'create' | 'modify' | 'delete' | 'rename' = 'modify'): ToolCall => ({
      kind: 'file-edit', label: 'Edit', files: [{ path, op }],
    });

    test('create/modify inside the session cwd keys on the kind', () => {
      assert.deepStrictEqual(rule(edit('/w/src/a.ts')), { key: 'file-edit', label: 'Always allow file edits' });
      assert.strictEqual(rule(edit('/w/a.ts', 'create'))?.key, 'file-edit');
    });

    test('delete and rename get no rule', () => {
      assert.strictEqual(rule(edit('/w/a.ts', 'delete')), undefined);
      assert.strictEqual(rule(edit('/w/a.ts', 'rename')), undefined);
    });

    test('paths outside the cwd, relative, or escaping with .. get no rule', () => {
      for (const p of ['/etc/passwd', '/home/u/.bashrc', 'a.ts', '/w/../etc/x', '/wx/a.ts']) {
        assert.strictEqual(rule(edit(p)), undefined, p);
      }
    });

    test('files that configure the agent or its permissions get no rule', () => {
      for (const p of [
        '/w/.git/hooks/pre-commit', '/w/.git/config', '/w/.claude/settings.local.json', '/w/.codex/config.toml',
        '/w/.vscode/tasks.json', '/w/.opencode/x.json', '/w/opencode.json', '/w/sub/opencode.json', '/w/.mcp.json',
      ]) {
        assert.strictEqual(rule(edit(p)), undefined, p);
      }
    });

    test('every file in a multi-file edit must qualify', () => {
      const t: ToolCall = {
        kind: 'file-edit', label: 'Edit',
        files: [{ path: '/w/a.ts', op: 'modify' }, { path: '/etc/x', op: 'modify' }],
      };
      assert.strictEqual(rule(t), undefined);
      assert.strictEqual(rule({ kind: 'file-edit', label: 'Edit', files: [] }), undefined);
    });

    test('Windows separators and drive case resolve against the cwd', () => {
      assert.strictEqual(ruleFor(edit('C:\\w\\src\\a.ts'), 'C:\\w', true)?.key, 'file-edit');
      assert.strictEqual(ruleFor(edit('C:\\w\\.git\\config'), 'C:\\w', true), undefined);
    });
  });

  test('mcp keys on server + tool', () => {
    assert.deepStrictEqual(
      rule({ kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' }),
      { key: 'mcp:github:create_pr', label: 'Always allow github create_pr' },
    );
  });

  test('plan, other and the rest get no rule', () => {
    assert.strictEqual(rule({ kind: 'plan', label: 'Plan', text: 'x' }), undefined);
    assert.strictEqual(rule({ kind: 'other', label: 'X', raw: {} }), undefined);
    assert.strictEqual(rule({ kind: 'web', label: 'Fetch', url: 'https://x' }), undefined);
  });
});
