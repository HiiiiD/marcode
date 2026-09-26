import * as assert from 'node:assert';
import { validateNotificationKinds } from '../../shared/notification-settings';

const ALL = { approval: true, question: true, finished: true, error: true };

suite('validateNotificationKinds', () => {
  test('undefined enables every kind', () => {
    const r = validateNotificationKinds(undefined);
    assert.deepStrictEqual(r.kinds, ALL);
    assert.deepStrictEqual(r.warnings, []);
  });

  test('honours explicit booleans', () => {
    const r = validateNotificationKinds({ finished: false });
    assert.deepStrictEqual(r.kinds, { ...ALL, finished: false });
  });

  test('non-object warns and falls back', () => {
    const r = validateNotificationKinds(3);
    assert.deepStrictEqual(r.kinds, ALL);
    assert.strictEqual(r.warnings.length, 1);
  });

  test('non-boolean value warns and keeps default', () => {
    const r = validateNotificationKinds({ error: 'no' });
    assert.strictEqual(r.kinds.error, true);
    assert.strictEqual(r.warnings.length, 1);
  });

  test('taskbarFlash defaults on, can be turned off, and is not a kind', () => {
    assert.strictEqual(validateNotificationKinds(undefined).taskbarFlash, true);
    const r = validateNotificationKinds({ taskbarFlash: false });
    assert.strictEqual(r.taskbarFlash, false);
    assert.deepStrictEqual(r.kinds, ALL);
  });

  test('non-boolean taskbarFlash warns and keeps default', () => {
    const r = validateNotificationKinds({ taskbarFlash: 1 });
    assert.strictEqual(r.taskbarFlash, true);
    assert.strictEqual(r.warnings.length, 1);
  });
});
