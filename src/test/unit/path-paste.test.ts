import * as assert from 'node:assert';
import { parseAttachCommand, parsePastedPaths } from '../../client-core/path-paste';

suite('path paste', () => {
  test('a bare POSIX or Windows absolute path', () => {
    assert.deepStrictEqual(parsePastedPaths('/home/me/a.png'), ['/home/me/a.png']);
    assert.deepStrictEqual(parsePastedPaths('C:\\Users\\me\\a.png'), ['C:\\Users\\me\\a.png']);
    assert.deepStrictEqual(parsePastedPaths('\\\\host\\share\\a.png'), ['\\\\host\\share\\a.png']);
  });
  test('surrounding whitespace and a trailing newline are ignored', () => {
    assert.deepStrictEqual(parsePastedPaths('  /a/b.txt\r\n'), ['/a/b.txt']);
  });
  test('quoted paths keep their spaces', () => {
    assert.deepStrictEqual(parsePastedPaths('"C:\\My Files\\a b.png"'), ['C:\\My Files\\a b.png']);
    assert.deepStrictEqual(parsePastedPaths("'/tmp/my dir/a.png'"), ['/tmp/my dir/a.png']);
  });
  test('a backslash-escaped space joins the token', () => {
    assert.deepStrictEqual(parsePastedPaths('/tmp/my\\ dir/a.png'), ['/tmp/my dir/a.png']);
  });
  test('POSIX drops escape spaces and shell characters with a backslash', () => {
    assert.deepStrictEqual(parsePastedPaths('/Users/me/Shot\\ \\(1\\).png'), ['/Users/me/Shot (1).png']);
    assert.deepStrictEqual(parsePastedPaths('/tmp/a\\&b.txt'), ['/tmp/a&b.txt']);
  });
  test('Windows backslashes stay separators', () => {
    assert.deepStrictEqual(parsePastedPaths('C:\\Users\\(me)\\a.png'), ['C:\\Users\\(me)\\a.png']);
  });
  test('file URIs decode to paths', () => {
    assert.deepStrictEqual(parsePastedPaths('file:///tmp/a%20b.png'), ['/tmp/a b.png']);
    assert.deepStrictEqual(parsePastedPaths('file:///C:/Users/me/a%20b.png'), ['C:/Users/me/a b.png']);
  });
  test('several paths separated by newlines or spaces', () => {
    assert.deepStrictEqual(parsePastedPaths('/a/1.txt\n/a/2.txt'), ['/a/1.txt', '/a/2.txt']);
    assert.deepStrictEqual(parsePastedPaths('"/a b/1.txt" /a/2.txt'), ['/a b/1.txt', '/a/2.txt']);
  });
  test('prose that contains a path is not a path paste', () => {
    assert.deepStrictEqual(parsePastedPaths('see /etc/hosts please'), []);
    assert.deepStrictEqual(parsePastedPaths('look at C:\\x.png'), []);
  });
  test('relative paths, empty and unbalanced-quote input are not paths', () => {
    assert.deepStrictEqual(parsePastedPaths('./a.png'), []);
    assert.deepStrictEqual(parsePastedPaths('a.png'), []);
    assert.deepStrictEqual(parsePastedPaths(''), []);
    assert.deepStrictEqual(parsePastedPaths('   \n'), []);
    assert.deepStrictEqual(parsePastedPaths('"/a/b.png'), []);
  });
  test('one non-path token spoils the whole paste', () => {
    assert.deepStrictEqual(parsePastedPaths('/a/1.txt hello'), []);
  });
});

suite('attach command', () => {
  test('/attach takes the rest as paths', () => {
    assert.deepStrictEqual(parseAttachCommand('/attach /a/b.png'), ['/a/b.png']);
    assert.deepStrictEqual(parseAttachCommand('  /attach "C:\\My Files\\a.png"  '), ['C:\\My Files\\a.png']);
  });
  test('anything else is not the command', () => {
    assert.strictEqual(parseAttachCommand('/attachments'), undefined);
    assert.strictEqual(parseAttachCommand('please /attach /a'), undefined);
    assert.strictEqual(parseAttachCommand('hello'), undefined);
  });
  test('/attach with no usable path is the command with no paths', () => {
    assert.deepStrictEqual(parseAttachCommand('/attach'), []);
    assert.deepStrictEqual(parseAttachCommand('/attach nope.png'), []);
  });
});
