import * as assert from 'assert';
import type { Attachment } from '../../providers/types';
import { attachmentLines, imageAttachments } from '../../providers/attachment-payload';

const image: Attachment = {
  id: 'a1', path: '/tmp/shot.png', name: 'shot.png',
  kind: 'image', mediaType: 'image/png', bytes: 10,
};
const file: Attachment = {
  id: 'a2', path: '/work/notes.md', name: 'notes.md', kind: 'file', bytes: 7,
};

suite('attachment payload', () => {
  test('no attachments produces no lines', () => {
    assert.strictEqual(attachmentLines(undefined), '');
    assert.strictEqual(attachmentLines([]), '');
  });

  test('an image contributes no text because it travels as an image input', () => {
    assert.strictEqual(attachmentLines([image]), '');
  });

  test('a file is named by absolute path', () => {
    const lines = attachmentLines([file]);
    assert.strictEqual(lines.includes('/work/notes.md'), true);
    assert.strictEqual(lines.startsWith('\n'), true);
  });

  test('imageAttachments selects only images', () => {
    assert.deepStrictEqual(imageAttachments([image, file]).map((attachment) => attachment.id), ['a1']);
    assert.deepStrictEqual(imageAttachments(undefined), []);
  });
});
