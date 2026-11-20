import * as assert from 'assert';
import { splitCommandLine } from '../../client-core/mcp/split-command';
import { planOpener } from '../../tui/tui-hooks';

suite('planOpener', () => {
  const calls: { command: string; args: string[]; shell: unknown }[] = [];
  const run = (command: string, args: string[], options: { shell?: unknown }) => {
    calls.push({ command, args, shell: options.shell });
    return { on: () => ({}) as never, unref: () => {} };
  };
  setup(() => { calls.length = 0; });

  test('splits quoted command into argv', () => {
    assert.deepStrictEqual(splitCommandLine('"C:\\Program Files\\vim\\vim.exe" -p'), { command: 'C:\\Program Files\\vim\\vim.exe', args: ['-p'] });
  });

  test('a path with shell metacharacters stays one argument and no shell runs', () => {
    const evil = '/tmp/a"; $(touch pwned) `id`.md';
    planOpener('code -r', run)?.('text', evil);
    assert.deepStrictEqual(calls, [{ command: 'code', args: ['-r', evil], shell: false }]);
  });

  test('no command configured spawns nothing', () => {
    planOpener(undefined, run)?.('text', '/tmp/p.md');
    planOpener('"unclosed', run)?.('text', '/tmp/p.md');
    assert.strictEqual(calls.length, 0);
  });
});
