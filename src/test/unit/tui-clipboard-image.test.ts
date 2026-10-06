import * as assert from 'node:assert';
import { readClipboardImage, type RunTool } from '../../tui/clipboard-image';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

suite('tui clipboard image', () => {
  test('windows: decodes the base64 PNG powershell prints', async () => {
    const run: RunTool = async () => ({ code: 0, stdout: Buffer.from(`${png.toString('base64')}\r\n`) });
    assert.deepStrictEqual(await readClipboardImage(run, 'win32'), { kind: 'image', mediaType: 'image/png', base64: png.toString('base64') });
  });
  test('linux: falls through a missing wl-paste to xclip and base64s its bytes', async () => {
    const calls: string[] = [];
    const run: RunTool = async (cmd) => { calls.push(cmd); return cmd === 'xclip' ? { code: 0, stdout: png } : undefined; };
    const out = await readClipboardImage(run, 'linux');
    assert.deepStrictEqual(calls, ['wl-paste', 'xclip']);
    assert.strictEqual(out.kind === 'image' && out.base64, png.toString('base64'));
  });
  test('a tool that ran but produced no image is "none"', async () => {
    assert.strictEqual((await readClipboardImage(async () => ({ code: 0, stdout: Buffer.alloc(0) }), 'win32')).kind, 'none');
    assert.strictEqual((await readClipboardImage(async () => ({ code: 1, stdout: Buffer.alloc(0) }), 'linux')).kind, 'none');
  });
  test('non-PNG bytes are rejected', async () => {
    assert.strictEqual((await readClipboardImage(async () => ({ code: 0, stdout: Buffer.from('hello world') }), 'linux')).kind, 'none');
  });
  test('no reader installed reports a hint; unknown platform too', async () => {
    const none = await readClipboardImage(async () => undefined, 'darwin');
    assert.strictEqual(none.kind === 'no-tool' && none.hint.includes('pngpaste'), true);
    assert.strictEqual((await readClipboardImage(async () => undefined, 'freebsd')).kind, 'no-tool');
  });
});
