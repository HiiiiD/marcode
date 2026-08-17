import * as assert from 'node:assert';
import { nextIndex } from '../../review/use-roving-rows';

suite('nextIndex', () => {
  test('arrows move by one', () => {
    assert.strictEqual(nextIndex(0, 'ArrowDown', 3), 1);
    assert.strictEqual(nextIndex(2, 'ArrowUp', 3), 1);
  });

  test('stops at the ends rather than wrapping', () => {
    // Wrapping in a 500-row list means an ArrowUp at the top silently teleports
    // the user to the bottom of a different session's work.
    assert.strictEqual(nextIndex(0, 'ArrowUp', 3), 0);
    assert.strictEqual(nextIndex(2, 'ArrowDown', 3), 2);
  });

  test('Home and End jump', () => {
    assert.strictEqual(nextIndex(1, 'Home', 3), 0);
    assert.strictEqual(nextIndex(1, 'End', 3), 2);
  });

  test('any other key is not ours', () => {
    assert.strictEqual(nextIndex(1, 'a', 3), null);
    assert.strictEqual(nextIndex(1, 'Enter', 3), null);
  });

  test('an empty list has nowhere to go', () => {
    assert.strictEqual(nextIndex(0, 'ArrowDown', 0), null);
  });
});
