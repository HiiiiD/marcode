import * as assert from 'assert';
import { parsePairs } from '../../tui/view/mcp-pairs';

suite('tui mcp pairs', () => {
  test('K=V tokens, quoted values with spaces', () => {
    assert.deepStrictEqual(parsePairs('A=1 B="two words"'), { pairs: { A: '1', B: 'two words' } });
  });

  test('a blank line is no pairs, not an error', () => {
    assert.deepStrictEqual(parsePairs('   '), { pairs: {} });
  });

  test('a token with no = is ignored', () => {
    assert.deepStrictEqual(parsePairs('A=1 junk'), { pairs: { A: '1' } });
  });

  test('an unbalanced quote is an error, not an empty record', () => {
    const r = parsePairs('A=1 B="oops');
    assert.strictEqual('error' in r, true);
  });
});
