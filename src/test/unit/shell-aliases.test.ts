import * as assert from 'assert';
import { DEFAULT_SHELL_ALIASES, parseShellAliases, resolveShellCommand } from '../../host/shell/shell-aliases';
import { parseHostConfig } from '../../host/host-config';

suite('shell aliases', () => {
  test('undefined gives the defaults', () => {
    assert.deepStrictEqual(parseShellAliases(undefined).aliases, DEFAULT_SHELL_ALIASES);
  });
  test('a user entry replaces a default, null removes it, a new one is added', () => {
    const { aliases } = parseShellAliases({
      pwsh: { command: '/opt/pwsh', args: ['-c'] }, powershell: null, zsh: { command: 'zsh', args: ['-c'] },
    });
    assert.deepStrictEqual(aliases.pwsh, { command: '/opt/pwsh', args: ['-c'] });
    assert.strictEqual('powershell' in aliases, false);
    assert.deepStrictEqual(aliases.zsh, { command: 'zsh', args: ['-c'] });
  });
  test('malformed entries are dropped with a warning and the rest survive', () => {
    const { aliases, warnings } = parseShellAliases({
      bad1: { command: 3, args: [] }, bad2: { command: 'x', args: [1] }, '-x': { command: 'x', args: [] },
      'a b': { command: 'x', args: [] }, ok: { command: 'ok', args: [] },
    });
    assert.deepStrictEqual(Object.keys(aliases).sort(), ['ok', 'powershell', 'pwsh']);
    assert.strictEqual(warnings.length, 4);
  });
  test('a non-object is ignored with a warning', () => {
    const r = parseShellAliases(['x']);
    assert.deepStrictEqual(r.aliases, DEFAULT_SHELL_ALIASES);
    assert.strictEqual(r.warnings.length, 1);
  });
  test('resolve: first token plus the rest becomes the final argument', () => {
    assert.deepStrictEqual(resolveShellCommand('pwsh Get-Date -Utc', DEFAULT_SHELL_ALIASES),
      { kind: 'alias', file: 'pwsh', args: ['-NoProfile', '-Command', 'Get-Date -Utc'] });
  });
  test('resolve: everything else, and an alias with nothing after it, is bash', () => {
    assert.deepStrictEqual(resolveShellCommand('git status', DEFAULT_SHELL_ALIASES), { kind: 'bash', script: 'git status' });
    assert.deepStrictEqual(resolveShellCommand('pwsh', DEFAULT_SHELL_ALIASES), { kind: 'bash', script: 'pwsh' });
    assert.deepStrictEqual(resolveShellCommand('toString x', DEFAULT_SHELL_ALIASES), { kind: 'bash', script: 'toString x' });
  });
  test('resolve: an alias name later in the line is plain bash, so the real program runs', () => {
    assert.deepStrictEqual(
      resolveShellCommand("bash -c 'pwsh --version'", DEFAULT_SHELL_ALIASES),
      { kind: 'bash', script: "bash -c 'pwsh --version'" },
    );
    assert.deepStrictEqual(resolveShellCommand('echo pwsh Get-Date', DEFAULT_SHELL_ALIASES), { kind: 'bash', script: 'echo pwsh Get-Date' });
  });
  test('host config reads shell.aliases', () => {
    const { config } = parseHostConfig({ shell: { aliases: { zsh: { command: 'zsh', args: ['-c'] } } } });
    assert.deepStrictEqual(config.shell.aliases.zsh, { command: 'zsh', args: ['-c'] });
    assert.deepStrictEqual(parseHostConfig({}).config.shell.aliases, DEFAULT_SHELL_ALIASES);
  });
});
