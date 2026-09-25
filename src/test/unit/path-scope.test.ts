import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { isWithin } from '../../shared/path-scope';

suite('isWithin', () => {
  test('a path is within itself and within a nested folder', () => {
    assert.strictEqual(isWithin('/ws/app', '/ws/app', false), true);
    assert.strictEqual(isWithin('/ws/app', '/ws/app/packages/api', false), true);
  });

  test('a sibling that merely shares a prefix is not within', () => {
    assert.strictEqual(isWithin('/ws/app', '/ws/app-two', false), false);
    assert.strictEqual(isWithin('/ws/app', '/ws', false), false);
  });

  test('trailing separators and windows separators are ignored', () => {
    assert.strictEqual(isWithin('e:\\Efebia\\hiiiid-code\\', 'e:/Efebia/hiiiid-code/src', false), true);
    assert.strictEqual(isWithin('e:/Efebia/hiiiid-code', 'e:\\Efebia\\hiiiid-code-2', false), false);
  });

  test('case only matters when the platform is case sensitive', () => {
    assert.strictEqual(isWithin('E:/Efebia/Code', 'e:/efebia/code/src', true), true);
    assert.strictEqual(isWithin('/ws/App', '/ws/app/src', false), false);
  });
});
