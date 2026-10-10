import * as assert from 'assert';
import { parseShellCommand } from '../../client-core/shell-command';
import { runningShell } from '../../client-core/running-shell';
import { shellAsTool } from '../../client-core/shell-as-tool';
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

suite('runningShell', () => {
  test('finds the last running shell item, ignoring finished ones', () => {
    const items = [item({ id: 'a', state: 'running' }), item({ id: 'b' }), item({ id: 'c', state: 'running' }), item({ id: 'd' })];
    assert.strictEqual(runningShell(items)?.id, 'c');
  });
  test('is undefined when nothing runs', () => {
    assert.strictEqual(runningShell([item()]), undefined);
    assert.strictEqual(runningShell([]), undefined);
  });
});

suite('shellAsTool', () => {
  test('maps to a command tool card labelled You ran', () => {
    const t = shellAsTool(item({ command: 'git status', output: 'clean\n' }));
    assert.deepStrictEqual([t.role, t.tool.kind, t.tool.kind === 'command' && t.tool.command, t.toolId], ['tool', 'command', 'git status', 'sh1']);
    assert.strictEqual(t.tool.label, 'You ran');
    assert.deepStrictEqual([t.state, t.output], ['ok', { kind: 'text', text: 'clean\n' }]);
  });
  test('running stays running and keeps its output so far', () => {
    const t = shellAsTool(item({ state: 'running', exitCode: undefined, output: 'partial' }));
    assert.deepStrictEqual([t.state, t.output], ['running', { kind: 'text', text: 'partial' }]);
  });
  test('a non-zero exit, a timeout, a signal and an error are failures with a status line', () => {
    const bad = shellAsTool(item({ exitCode: 2, output: 'boom\n' }));
    assert.strictEqual(bad.state, 'error');
    assert.strictEqual(bad.output?.kind === 'text' && bad.output.text, 'boom\n\n[exit 2]');
    assert.strictEqual(shellAsTool(item({ timedOut: true, exitCode: undefined })).state, 'error');
    assert.strictEqual(shellAsTool(item({ signal: 'SIGKILL', exitCode: undefined })).state, 'error');
    const err = shellAsTool(item({ error: 'spawn failed', exitCode: undefined, output: '' }));
    assert.deepStrictEqual([err.state, err.output?.kind === 'text' && err.output.text], ['error', '[spawn failed]']);
  });
  test('cancelled is not a failure and says so', () => {
    const t = shellAsTool(item({ state: 'cancelled', exitCode: undefined, output: 'x' }));
    assert.deepStrictEqual([t.state, t.output?.kind === 'text' && t.output.text], ['ok', 'x\n\n[cancelled]']);
  });
  test('truncation is noted and a clean empty run has no output block', () => {
    const t = shellAsTool(item({ truncated: true, output: 'tail' }));
    assert.strictEqual(t.output?.kind === 'text' && t.output.text, 'tail\n\n[output truncated]');
    assert.deepStrictEqual(shellAsTool(item({ output: '' })).output, { kind: 'none' });
  });
});
