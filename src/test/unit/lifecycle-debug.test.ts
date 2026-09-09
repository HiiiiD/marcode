import assert from 'node:assert/strict';
import { afterEach, beforeEach, suite, test } from 'mocha';
import { lifecycleDebug, setLifecycleDebug } from '../../shared/lifecycle-debug';

suite('lifecycleDebug', () => {
  const originalWarn = console.warn;
  let calls: unknown[][];

  beforeEach(() => {
    calls = [];
    setLifecycleDebug(false);
    console.warn = (...args: unknown[]) => { calls.push(args); };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test('does not log unless lifecycle debugging is enabled', () => {
    lifecycleDebug('test', { value: 'safe' });

    assert.deepStrictEqual(calls, []);
  });

  test('logs the scope and structured metadata when enabled', () => {
    setLifecycleDebug(true);

    lifecycleDebug('test', { value: 'safe' });

    assert.deepStrictEqual(calls, [['[marcode:lifecycle] test', { value: 'safe' }]]);
  });
});
