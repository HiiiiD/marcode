import * as assert from 'node:assert';
import { buildFlashCommand } from '../../host/taskbar-flash';

suite('buildFlashCommand', () => {
  test('passes exe and title through env, never the script text', () => {
    const cmd = buildFlashCommand('C:\\Apps\\Code.exe', 'my "proj"; rm');
    assert.strictEqual(cmd.env.MARCODE_FLASH_EXE, 'Code');
    assert.strictEqual(cmd.env.MARCODE_FLASH_TITLE, 'my "proj"; rm');
    const script = Buffer.from(cmd.args[cmd.args.length - 1], 'base64').toString('utf16le');
    assert.strictEqual(script.includes('rm'), false);
    assert.strictEqual(script.includes('FlashWindowEx'), true);
  });

  test('runs non-interactively without a profile', () => {
    const cmd = buildFlashCommand('Code.exe', '');
    assert.strictEqual(cmd.file, 'powershell.exe');
    assert.deepStrictEqual(cmd.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  });
});
