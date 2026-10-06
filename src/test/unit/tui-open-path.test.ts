import * as assert from 'node:assert';
import { openCommand, openPath } from '../../tui/open-path';
import { attachmentLabel } from '../../tui/view/attachment-label';

suite('tui open path', () => {
  test('each platform uses its own default opener', () => {
    assert.deepStrictEqual(openCommand(String.raw`C:\dir\a b.png`, 'win32'), { cmd: 'cmd', args: ['/c', 'start', '""', String.raw`"C:\dir\a b.png"`] });
    assert.deepStrictEqual(openCommand('/a.png', 'darwin'), { cmd: 'open', args: ['/a.png'] });
    assert.deepStrictEqual(openCommand('/a.png', 'linux'), { cmd: 'xdg-open', args: ['/a.png'] });
  });
  test('a spawn failure becomes a message naming the path; success is undefined', async () => {
    assert.strictEqual(await openPath('/a.png', async () => undefined, 'linux'), undefined);
    assert.strictEqual(await openPath('/a.png', async () => 'ENOENT', 'linux'), 'could not open /a.png: ENOENT');
  });
  test('labels carry the name and a human size', () => {
    const a = { id: '1', path: '/x', name: 'shot.png', kind: 'image' as const, bytes: 2048 };
    assert.strictEqual(attachmentLabel(a), 'shot.png (2 KB)');
    assert.strictEqual(attachmentLabel({ ...a, bytes: 12 }), 'shot.png (12 B)');
  });
});
