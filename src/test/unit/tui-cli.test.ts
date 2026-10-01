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
    assert.deepStrictEqual(parseArgs(['migrate', 'C:\old']), { kind: 'migrate', oldDir: 'C:\old' });
    assert.deepStrictEqual(parseArgs(['--help']), { kind: 'help' });
  });
  test('missing operands and unknown flags are errors, never throws', () => {
    assert.strictEqual(parseArgs(['login']).kind, 'error');
    assert.strictEqual(parseArgs(['migrate']).kind, 'error');
    assert.strictEqual(parseArgs(['--bogus']).kind, 'error');
  });
  test('a prompt that begins with a login-like word needs --', () => {
    assert.deepStrictEqual(parseArgs(['--', 'login', 'page']), { kind: 'run', prompt: 'login page', forceNew: false });
  });
});
