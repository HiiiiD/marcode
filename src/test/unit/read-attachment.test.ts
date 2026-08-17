import * as assert from 'assert';
import { urisOf } from '../../webview/lib/read-attachment';

function dt(uriList: string): DataTransfer {
  return {
    getData: (type: string) => type === 'text/uri-list' ? uriList : '',
    types: ['text/uri-list'],
  } as unknown as DataTransfer;
}

suite('urisOf', () => {
  test('splits a uri-list on CRLF and drops comments', () => {
    assert.deepStrictEqual(
      urisOf(dt('# comment\r\nfile:///a.png\r\nfile:///b.md\r\n')),
      ['file:///a.png', 'file:///b.md'],
    );
  });

  test('an empty list yields nothing', () => {
    assert.deepStrictEqual(urisOf(dt('')), []);
  });
});
