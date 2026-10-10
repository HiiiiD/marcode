import * as assert from 'node:assert';
import { parseArgs } from '../../tui/cli';

suite('tui cli', () => {
  test('no args resumes', () => {
    assert.deepStrictEqual(parseArgs([]), { kind: 'run', forceNew: false });
  });
  test('a quoted prompt is the prompt; extra words are joined', () => {
    assert.deepStrictEqual(parseArgs(['fix', 'the', 'tests']), { kind: 'run', prompt: 'fix the tests', forceNew: false });
  });
  test('--new alone and with a prompt', () => {
    assert.deepStrictEqual(parseArgs(['--new']), { kind: 'run', forceNew: true });
    assert.deepStrictEqual(parseArgs(['--new', 'go']), { kind: 'run', prompt: 'go', forceNew: true });
  });
  test('subcommands', () => {
    assert.deepStrictEqual(parseArgs(['login', 'claude']), { kind: 'login', provider: 'claude' });
    assert.deepStrictEqual(parseArgs(['config']), { kind: 'config' });
    assert.deepStrictEqual(parseArgs(['migrate', 'C:\\old']), { kind: 'migrate', oldDir: 'C:\\old' });
    assert.deepStrictEqual(parseArgs(['--help']), { kind: 'help' });
  });
  test('missing operands and unknown flags are errors, never throws', () => {
    assert.strictEqual(parseArgs(['login']).kind, 'error');
    assert.strictEqual(parseArgs(['migrate']).kind, 'error');
    assert.strictEqual(parseArgs(['--bogus']).kind, 'error');
  });
  test('daemon actions', () => {
    assert.deepStrictEqual(parseArgs(['daemon', '--serve', '--workspace-dir', '/w', '--root', '/r']),
      { kind: 'daemon', action: 'serve', workspaceDir: '/w', roots: ['/r'] });
    assert.deepStrictEqual(parseArgs(['daemon', '--serve', '--workspace-dir', '/w', '--root', '/a', '--root', '/b']),
      { kind: 'daemon', action: 'serve', workspaceDir: '/w', roots: ['/a', '/b'] });
    assert.deepStrictEqual(parseArgs(['daemon', '--status']), { kind: 'daemon', action: 'status', roots: [] });
    assert.deepStrictEqual(parseArgs(['daemon', '--stop']), { kind: 'daemon', action: 'stop', roots: [] });
  });
  test('daemon misuse is an error', () => {
    const bare = parseArgs(['daemon']);
    assert.strictEqual(bare.kind, 'error');
    const msg = bare.kind === 'error' ? bare.message : '';
    assert.strictEqual(['--serve', '--status', '--stop'].every((f) => msg.includes(f)), true);
    assert.strictEqual(parseArgs(['daemon', '--serve']).kind, 'error');
    assert.strictEqual(parseArgs(['daemon', '--serve', '--workspace-dir']).kind, 'error');
    assert.strictEqual(parseArgs(['daemon', '--status', '--stop']).kind, 'error');
    assert.strictEqual(parseArgs(['daemon', '--bogus']).kind, 'error');
  });
  test('a prompt that begins with a login-like word needs --', () => {
    assert.deepStrictEqual(parseArgs(['--', 'login', 'page']), { kind: 'run', prompt: 'login page', forceNew: false });
  });
});
