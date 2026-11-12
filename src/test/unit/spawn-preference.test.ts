import * as assert from 'assert';
import { nestedDescription, resolveNested } from '../../host/self-control/spawn-preference';
import { parseHostConfig } from '../../host/host-config';

suite('spawn preference', () => {
  test('an explicit nested argument beats the setting both ways', () => {
    assert.strictEqual(resolveNested(false, 'nested'), false);
    assert.strictEqual(resolveNested(true, 'pane'), true);
  });

  test('an omitted argument takes the setting, auto meaning a pane', () => {
    assert.strictEqual(resolveNested(undefined, 'nested'), true);
    assert.strictEqual(resolveNested(undefined, 'pane'), false);
    assert.strictEqual(resolveNested(undefined), false);
  });

  test('the description states the default and warns against nesting a session the user talks to', () => {
    assert.strictEqual(nestedDescription('nested').includes('Defaults to `true`'), true);
    assert.strictEqual(nestedDescription('pane').includes('Defaults to `false`'), true);
    assert.strictEqual(nestedDescription().includes('Never nest a session the user needs to talk to'), true);
  });

  test('config parses a valid value and rejects an unknown one', () => {
    assert.strictEqual(parseHostConfig({ spawn: { preference: 'nested' } }).config.spawn.preference, 'nested');
    const bad = parseHostConfig({ spawn: { preference: 'sometimes' } });
    assert.strictEqual(bad.config.spawn.preference, 'auto');
    assert.strictEqual(bad.warnings.length, 1);
  });
});
