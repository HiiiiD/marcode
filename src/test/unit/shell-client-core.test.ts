import * as assert from 'assert';
import { parseShellCommand } from '../../client-core/shell-command';
import { shellCard } from '../../client-core/shell-card';
import type { ShellItem } from '../../protocol/messages';

const item = (over: Partial<ShellItem> = {}): ShellItem => ({
  id: 'sh1', ts: 1, role: 'shell', command: 'ls', state: 'done', output: 'a\n', exitCode: 0, ...over,
});

suite('parseShellCommand', () => {
  test('returns the text after a leading bang', () => {
    assert.strictEqual(parseShellCommand('!git status'), 'git status');
    assert.strictEqual(parseShellCommand('  !ls -la  '), 'ls -la');
  });
  test('a lone bang, a double bang and prose are not commands', () => {
    assert.strictEqual(parseShellCommand('!'), undefined);
    assert.strictEqual(parseShellCommand('! ls'), undefined);
    assert.strictEqual(parseShellCommand('!!'), undefined);
    assert.strictEqual(parseShellCommand('hello !ls'), undefined);
    assert.strictEqual(parseShellCommand(''), undefined);
  });
});

suite('shellCard', () => {
  test('running', () => {
    const c = shellCard(item({ state: 'running', exitCode: undefined }));
    assert.deepStrictEqual([c.running, c.failed, c.footer], [true, false, 'running…']);
  });
  test('exit codes', () => {
    assert.strictEqual(shellCard(item()).footer, 'exit 0');
    const bad = shellCard(item({ exitCode: 2 }));
    assert.deepStrictEqual([bad.failed, bad.footer], [true, 'exit 2']);
  });
  test('cancelled, timed out, truncated and error compose', () => {
    assert.strictEqual(shellCard(item({ state: 'cancelled', exitCode: undefined })).footer, 'cancelled');
    assert.strictEqual(shellCard(item({ timedOut: true, exitCode: undefined })).footer, 'timed out');
    assert.strictEqual(shellCard(item({ truncated: true })).footer, 'exit 0 · output truncated');
    const err = shellCard(item({ exitCode: undefined, error: 'spawn failed' }));
    assert.deepStrictEqual([err.failed, err.footer], [true, 'spawn failed']);
  });
});
