import * as assert from 'assert';
import { isHidden } from '../../shared/session-kind';

suite('isHidden', () => {
  test('side and subagent sessions are hidden', () => {
    assert.strictEqual(isHidden({ kind: 'side' }), true);
    assert.strictEqual(isHidden({ kind: 'subagent' }), true);
  });

  test('normal sessions are not hidden', () => {
    assert.strictEqual(isHidden({}), false);
    assert.strictEqual(isHidden({ kind: 'session' }), false);
  });
});
