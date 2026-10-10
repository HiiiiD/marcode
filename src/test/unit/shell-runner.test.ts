import * as assert from 'assert';
import * as os from 'os';
import { findBash, runShell, type ShellRunOptions } from '../../host/shell/shell-runner';

const node = (script: string) => ({ kind: 'alias' as const, file: process.execPath, args: ['-e', script] });
const cwd = process.cwd();

async function run(script: string, extra: Partial<ShellRunOptions> = {}) {
  let output = ''; let truncated = false;
  const handle = runShell({ cwd, spec: node(script), flushMs: 10, ...extra }, (o, t) => { output = o; truncated = t; });
  const result = await handle.done;
  return { result, output, truncated };
}

suite('runShell', () => {
  test('captures stdout and stderr and the exit code', async () => {
    const { result, output } = await run('console.log("out"); console.error("err"); process.exit(3)');
    assert.strictEqual(result.exitCode, 3);
    assert.strictEqual(output.includes('out') && output.includes('err'), true);
  });
  test('a spawn failure is a result, not a rejection', async () => {
    const handle = runShell({ cwd, spec: { kind: 'alias', file: 'definitely-not-a-binary-xyz', args: [] } }, () => {});
    const result = await handle.done;
    assert.strictEqual(typeof result.error, 'string');
  });
  test('keeps the tail past the cap and keeps draining', async () => {
    const { result, output, truncated } = await run(
      'for (let i = 0; i < 2000; i++) process.stdout.write("x".repeat(100) + i + "\\n")', { maxOutput: 1000 });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(truncated, true);
    assert.strictEqual(output.length <= 1000, true);
    assert.strictEqual(output.includes('1999'), true);
  });
  test('times out and kills the child', async () => {
    const { result } = await run('setInterval(() => {}, 1000)', { timeoutMs: 150 });
    assert.strictEqual(result.timedOut, true);
  });
  test('cancel kills the child', async () => {
    const handle = runShell({ cwd, spec: node('setInterval(() => {}, 1000)'), flushMs: 10 }, () => {});
    setTimeout(() => handle.cancel(), 100);
    const result = await handle.done;
    assert.strictEqual(result.cancelled, true);
  });
  test('the cwd is honoured', async () => {
    const { output } = await run('console.log(process.cwd())', { cwd: os.tmpdir() });
    assert.strictEqual(output.trim().toLowerCase().includes(require('path').basename(os.tmpdir()).toLowerCase()), true);
  });
});

suite('findBash', () => {
  test('non-Windows is plain bash', () => {
    assert.strictEqual(findBash({}, 'linux', () => false), 'bash');
  });
  test('Windows: PATH wins but System32 (the WSL stub) is skipped', () => {
    const present = new Set(['C:\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe']);
    const exists = (p: string) => present.has(p);
    assert.strictEqual(findBash({ PATH: 'C:\\Windows\\System32;C:\\Git\\bin' }, 'win32', exists), 'C:\\Git\\bin\\bash.exe');
  });
  test('Windows: falls back to the Git for Windows install, then to undefined', () => {
    const env = { PATH: '', ProgramFiles: 'C:\\Program Files' };
    assert.strictEqual(findBash(env, 'win32', (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.strictEqual(findBash(env, 'win32', () => false), undefined);
  });
  test('a run with no bash resolves with an error naming shell.aliases', async () => {
    const handle = runShell({ cwd, spec: { kind: 'bash', script: 'ls' }, bashPath: () => undefined }, () => {});
    const result = await handle.done;
    assert.strictEqual(result.error?.includes('shell.aliases'), true);
  });
});
