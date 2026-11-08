import * as assert from 'assert';
import { sideChatText } from '../../client-core/side-chat-command';

suite('sideChatText', () => {
  test('/side and /btw carry their question', () => {
    assert.strictEqual(sideChatText('/side why a clamp?'), 'why a clamp?');
    assert.strictEqual(sideChatText('/btw why?'), 'why?');
    assert.strictEqual(sideChatText('  /side  spaced out  '), 'spaced out');
  });

  test('the bare command is an empty question', () => {
    assert.strictEqual(sideChatText('/side'), '');
    assert.strictEqual(sideChatText('/btw'), '');
  });

  test('a question may span lines', () => {
    assert.strictEqual(sideChatText('/side one\ntwo'), 'one\ntwo');
  });

  test('anything else belongs to the agent', () => {
    assert.strictEqual(sideChatText('/sidebar'), undefined);
    assert.strictEqual(sideChatText('/btwx hi'), undefined);
    assert.strictEqual(sideChatText('please /side this'), undefined);
    assert.strictEqual(sideChatText('hello'), undefined);
  });
});
