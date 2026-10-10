import * as assert from 'node:assert';
import { encodeFrame, LineDecoder, MAX_LINE_CHARS, parseFrame } from '../../daemon/protocol';

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

  test('LineDecoder throws once a pending partial line exceeds the cap', () => {
    const d = new LineDecoder(10);
    d.push('x'.repeat(6));
    assert.throws(() => d.push('x'.repeat(6)), /too long/);
  });

  test('LineDecoder throws on a complete oversize line inside one chunk', () => {
    const d = new LineDecoder(10);
    assert.throws(() => d.push(`${'x'.repeat(11)}\n`), /too long/);
  });

  test('LineDecoder allows a line of exactly the cap', () => {
    assert.deepStrictEqual(new LineDecoder(10).push(`${'x'.repeat(10)}\n`), ['x'.repeat(10)]);
  });

  test('LineDecoder decodes a frame arriving in ~1000 small chunks as one line', () => {
    const d = new LineDecoder();
    const body = 'a'.repeat(10);
    let lines: string[] = [];
    for (let i = 0; i < 1000; i++) { lines = lines.concat(d.push(body)); }
    lines = lines.concat(d.push('\n'));
    assert.deepStrictEqual(lines, ['a'.repeat(10_000)]);
  });

  test('encodeFrame -> LineDecoder -> parseFrame round-trips multibyte text', () => {
    const frame = { f: 'ctx' as const, ctx: { text: 'héllo ✓ 🙂' } };
    const lines = new LineDecoder().push(encodeFrame(frame));
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(parseFrame(lines[0]), frame);
  });

  test('parseFrame returns undefined for garbage and for a frame with no f', () => {
    assert.strictEqual(parseFrame('not json'), undefined);
    assert.strictEqual(parseFrame('{"x":1}'), undefined);
    assert.deepStrictEqual(parseFrame('{"f":"bye"}'), { f: 'bye' });
  });

  test('MAX_LINE_CHARS is the 64M-character default cap', () => {
    assert.strictEqual(MAX_LINE_CHARS, 64 * 1024 * 1024);
  });
});
