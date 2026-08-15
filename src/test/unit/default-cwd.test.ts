import * as assert from 'assert';
import { defaultCwdOf } from '../../host/default-cwd';

suite('defaultCwdOf', () => {
  test('the first workspace folder wins', () => {
    assert.deepStrictEqual(
      defaultCwdOf(['/repo', '/other'], '/home/marco'),
      { cwd: '/repo', fallback: false },
    );
  });

  test('with no folder open it falls back to the home directory, and says so', () => {
    // Never `process.cwd()`: for an extension host that is VS Code's own
    // INSTALL directory (…/Programs/Microsoft VS Code on Windows), so a
    // session started with no folder open silently read and wrote there.
    assert.deepStrictEqual(
      defaultCwdOf([], '/home/marco'),
      { cwd: '/home/marco', fallback: true },
    );
    assert.deepStrictEqual(
      defaultCwdOf(undefined, '/home/marco'),
      { cwd: '/home/marco', fallback: true },
    );
  });

  test('an empty folder path is not a folder', () => {
    assert.strictEqual(defaultCwdOf([''], '/home/marco').cwd, '/home/marco');
  });
});
