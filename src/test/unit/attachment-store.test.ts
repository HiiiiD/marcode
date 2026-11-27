import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from '../../host/attachment-store';
import type { Attachment } from '../../providers/types';

async function tmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mar-attach-'));
}

/** A 1x1 PNG. Small, and a real image so kind-sniffing has something honest to read. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

suite('AttachmentStore', () => {
  test('savePaste writes the bytes and mints an image attachment', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const result = await store.savePaste('s1', {
      name: 'screenshot.png', mediaType: 'image/png', base64: PNG_B64,
    });

    assert.strictEqual('error' in result, false);
    const att = result as Exclude<typeof result, { error: string }>;
    assert.strictEqual(att.kind, 'image');
    assert.strictEqual(att.mediaType, 'image/png');
    assert.strictEqual(att.name, 'screenshot.png');
    assert.strictEqual(path.isAbsolute(att.path), true);
    assert.strictEqual(att.path.startsWith(path.join(root, 'attachments', 's1')), true);
    const onDisk = await fs.readFile(att.path);
    assert.strictEqual(onDisk.toString('base64'), PNG_B64);
    assert.strictEqual(att.bytes, onDisk.byteLength);
  });

  test('savePaste records where the file sits under the store, for previewing', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const result = await store.savePaste('s1', {
      name: 'screenshot.png', mediaType: 'image/png', base64: PNG_B64,
    });
    const att = result as Attachment;

    // POSIX-joined and relative to the attachments root: the webview composes
    // it onto a single host-minted base URI, so it can never be a disk path.
    assert.strictEqual(att.storeRelative, `s1/${path.basename(att.path)}`);
    assert.strictEqual(att.storeRelative?.includes('\\'), false);
  });

  test('an adopted file has no store-relative path — it was never copied in', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    const outside = path.join(await tmpRoot(), 'shot.png');
    await fs.writeFile(outside, Buffer.from(PNG_B64, 'base64'));

    const { attachments } = await store.adopt('s1', [outside]);

    assert.strictEqual(attachments[0].kind, 'image');
    assert.strictEqual(attachments[0].storeRelative, undefined);
  });

  test('savePaste refuses anything over the size cap without writing', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7).toString('base64');
    const result = await store.savePaste('s1', { name: 'big.png', mediaType: 'image/png', base64: huge });

    assert.strictEqual('error' in result, true);
    assert.match((result as { error: string }).error, /10 MB/);
    const dir = path.join(root, 'attachments', 's1');
    const listed = await fs.readdir(dir).catch(() => [] as string[]);
    assert.strictEqual(listed.length, 0);
  });

  test('savePaste never collides two pastes of the same name', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const a = await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });
    const b = await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });

    const pa = (a as Attachment).path;
    const pb = (b as Attachment).path;
    assert.strictEqual(pa === pb, false);
    assert.strictEqual((a as Attachment).id === (b as Attachment).id, false);
  });

  test('adopt references an existing file in place and sniffs its kind', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    const outside = path.join(await tmpRoot(), 'notes.md');
    await fs.writeFile(outside, '# hello', 'utf8');

    const { attachments, rejected } = await store.adopt('s1', [outside]);

    assert.strictEqual(rejected.length, 0);
    assert.strictEqual(attachments.length, 1);
    assert.strictEqual(attachments[0].kind, 'file');
    assert.strictEqual(attachments[0].path, outside);
    assert.strictEqual(attachments[0].name, 'notes.md');
    assert.strictEqual(attachments[0].bytes, 7);
  });

  test('adopt rejects a missing path instead of throwing, and says it could not be read', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);

    const { attachments, rejected } = await store.adopt('s1', [path.join(root, 'nope.txt')]);

    assert.strictEqual(attachments.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].name, 'nope.txt');
    assert.strictEqual(rejected[0].reason, 'could not be read');
  });

  test('adopt names a directory as a directory, not as an unreadable file', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    const dir = path.join(root, 'a-folder');
    await fs.mkdir(dir, { recursive: true });

    const { rejected } = await store.adopt('s1', [dir]);

    assert.strictEqual(rejected[0].name, 'a-folder');
    assert.strictEqual(rejected[0].reason, 'that is a folder');
  });

  test('adopt quotes the oversize file against the cap it broke', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    const big = path.join(root, 'huge.bin');
    await fs.writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 3));

    const { attachments, rejected } = await store.adopt('s1', [big]);

    assert.strictEqual(attachments.length, 0);
    // The number is the point: "too large" alone leaves the user guessing by how much.
    assert.strictEqual(rejected[0].reason, 'too large (10.0 MB of 10 MB)');
  });

  test('remove reaps the session directory', async () => {
    const root = await tmpRoot();
    const store = new AttachmentStore(root);
    await store.savePaste('s1', { name: 'shot.png', mediaType: 'image/png', base64: PNG_B64 });

    await store.remove('s1');

    const exists = await fs.stat(path.join(root, 'attachments', 's1')).then(() => true, () => false);
    assert.strictEqual(exists, false);
  });

  test('a moved attachment with a hostile id or name is refused, never written outside its session folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-att-install-'));
    const store = new AttachmentStore(root);
    for (const bad of [{ id: '..', name: 'x' }, { id: '.', name: 'x' }, { id: 'a/../../b', name: 'y.png' }, { id: 'ok', name: 'evil.p ng' }]) {
      await assert.rejects(store.install('s1', bad, Buffer.from('z')));
    }
    assert.deepStrictEqual((await fs.readdir(root)).sort(), []);
    for (const name of ['shot.png', '../../shot.png']) {
      const good = await store.install('s1', { id: 'att-1', name }, Buffer.from('z'));
      assert.strictEqual(path.dirname(good.path), path.join(store.baseDir, 's1'));
    }
  });
});
