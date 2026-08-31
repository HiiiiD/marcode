import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { PROVIDER_INSTANCES_SETTING } from '../../shared/settings';

suite('shared/settings', () => {
  test('PROVIDER_INSTANCES_SETTING names the providerInstances setting', () => {
    assert.strictEqual(PROVIDER_INSTANCES_SETTING, 'marcode.providerInstances');
  });
});
