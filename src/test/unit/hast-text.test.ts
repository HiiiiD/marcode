import * as assert from 'assert';
import { hastText } from '../../webview/components/hast-text';

suite('hastText', () => {
  test('returns a plain text node value', () => {
    assert.strictEqual(hastText({ type: 'text', value: 'hi' }), 'hi');
  });

  test('joins nested element children in order', () => {
    assert.strictEqual(
      hastText({
        type: 'element',
        tagName: 'strong',
        properties: {},
        children: [
          { type: 'text', value: 'a' },
          { type: 'element', tagName: 'em', properties: {}, children: [{ type: 'text', value: 'b' }] },
          { type: 'text', value: 'c' },
        ],
      }),
      'abc',
    );
  });

  test('ignores non-element, non-text nodes', () => {
    assert.strictEqual(hastText({ type: 'comment', value: 'x' } as never), '');
  });
});
