import assert from 'node:assert/strict';
import { afterEach, beforeEach, suite, test } from 'mocha';
import { lifecycleDebug, lifecycleDebugFromEnv, setLifecycleDebug } from '../../shared/lifecycle-debug';

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

  test('MARCODE_DEBUG=1 turns the trace on and removes the variable, so agent shells do not inherit it', () => {
    const env: NodeJS.ProcessEnv = { MARCODE_DEBUG: '1', OTHER: 'x' };
    lifecycleDebugFromEnv(env);
    lifecycleDebug('test', { value: 'safe' });

    assert.deepStrictEqual(calls, [['[marcode:lifecycle] test', { value: 'safe' }]]);
    assert.deepStrictEqual(env, { OTHER: 'x' });
  });

  test('without MARCODE_DEBUG the trace stays off', () => {
    lifecycleDebugFromEnv({});
    lifecycleDebug('test', { value: 'safe' });

    assert.deepStrictEqual(calls, []);
  });
});
