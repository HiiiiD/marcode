import * as assert from 'assert';
import { fsPathOfUri } from '../../host/file-uri';

suite('fsPathOfUri', () => {
  test('decodes a posix file uri', () => {
    assert.strictEqual(fsPathOfUri('file:///home/me/a%20file.png'), '/home/me/a file.png');
  });

  test('decodes a windows file uri without the leading slash', () => {
    assert.strictEqual(fsPathOfUri('file:///e%3A/work/shot.png'), 'e:/work/shot.png');
  });

  test('refuses a non-file scheme', () => {
    assert.strictEqual(fsPathOfUri('https://example.com/x.png'), undefined);
    assert.strictEqual(fsPathOfUri('untitled:Untitled-1'), undefined);
  });

  test('refuses junk', () => {
    assert.strictEqual(fsPathOfUri('not a uri'), undefined);
    assert.strictEqual(fsPathOfUri(''), undefined);
    assert.strictEqual(fsPathOfUri('file:///%zz'), undefined);
  });
});
