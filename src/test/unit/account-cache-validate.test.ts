import * as assert from 'assert';
import { validModels, validWindows } from '../../host/account-cache/validate';

suite('account-cache validate', () => {
  test('validWindows is undefined for a non-array', () => {
    assert.strictEqual(validWindows(null), undefined);
    assert.strictEqual(validWindows({ id: 'a' }), undefined);
    assert.strictEqual(validWindows('x'), undefined);
  });

  test('validWindows keeps only well-formed windows', () => {
    const good = { id: '5h', label: '5h', usedPercent: 12 };
    assert.deepStrictEqual(
      validWindows([null, 42, { id: 'x' }, { id: 'x', label: 'x', usedPercent: '1' }, good]),
      [good],
    );
  });

  test('validModels is empty for a non-array', () => {
    assert.deepStrictEqual(validModels(undefined), []);
    assert.deepStrictEqual(validModels({}), []);
  });

  test('validModels keeps only rows with id and displayName', () => {
    const good = { id: 'haiku', displayName: 'Haiku 4.5' };
    assert.deepStrictEqual(
      validModels([null, { id: 'opus' }, { displayName: 'Nameless' }, good]),
      [good],
    );
  });
});
