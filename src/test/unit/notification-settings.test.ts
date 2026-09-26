import * as assert from 'node:assert';
import { validateNotificationKinds } from '../../shared/notification-settings';

suite('validateNotificationKinds', () => {
  test('undefined enables every kind', () => {
    const r = validateNotificationKinds(undefined);
    assert.deepStrictEqual(r.kinds, { approval: true, finished: true, error: true });
    assert.deepStrictEqual(r.warnings, []);
  });

  test('honours explicit booleans', () => {
    const r = validateNotificationKinds({ finished: false });
    assert.deepStrictEqual(r.kinds, { approval: true, finished: false, error: true });
  });

  test('non-object warns and falls back', () => {
    const r = validateNotificationKinds(3);
    assert.deepStrictEqual(r.kinds, { approval: true, finished: true, error: true });
    assert.strictEqual(r.warnings.length, 1);
  });

  test('non-boolean value warns and keeps default', () => {
    const r = validateNotificationKinds({ error: 'no' });
    assert.strictEqual(r.kinds.error, true);
    assert.strictEqual(r.warnings.length, 1);
  });
});
