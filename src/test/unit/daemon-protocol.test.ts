import * as assert from 'node:assert';
import { encodeFrame, LineDecoder, MAX_LINE_BYTES, parseFrame } from '../../daemon/protocol';

suite('daemon protocol', () => {
  test('encodeFrame is one JSON line ending in a newline', () => {
    const line = encodeFrame({ f: 'bye' });
    assert.strictEqual(line, '{"f":"bye"}\n');
  });

  test('LineDecoder joins a frame split across chunks', () => {
    const d = new LineDecoder();
    assert.deepStrictEqual(d.push('{"f":"b'), []);
    assert.deepStrictEqual(d.push('ye"}\n{"f":"x"}'), ['{"f":"bye"}']);
    assert.deepStrictEqual(d.push('\n'), ['{"f":"x"}']);
  });

  test('LineDecoder skips empty lines', () => {
    assert.deepStrictEqual(new LineDecoder().push('\n\n{"a":1}\n'), ['{"a":1}']);
  });

  test('LineDecoder throws once a single line exceeds the cap', () => {
    const d = new LineDecoder();
    assert.throws(() => d.push('x'.repeat(MAX_LINE_BYTES + 1)), /too long/);
  });

  test('parseFrame returns undefined for garbage and for a frame with no f', () => {
    assert.strictEqual(parseFrame('not json'), undefined);
    assert.strictEqual(parseFrame('{"x":1}'), undefined);
    assert.deepStrictEqual(parseFrame('{"f":"bye"}'), { f: 'bye' });
  });
});
