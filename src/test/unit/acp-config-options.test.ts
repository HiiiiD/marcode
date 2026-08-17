import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { currentModelId, modelConfigId, toModeIds, toModels }
  from '../../providers/acp/config-options';
import type { ConfigOption } from '../../providers/acp/config-options';

const options = frames.newSession.configOptions as unknown as ConfigOption[];

suite('acp config options', () => {
  test('the model option becomes the model catalog', () => {
    assert.deepStrictEqual(toModels(options), [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      { id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free' },
    ]);
  });

  test('a model row with no name displays its own id', () => {
    const opts: ConfigOption[] = [
      { id: 'model', category: 'model', options: [{ value: 'x/y' }] }];
    assert.deepStrictEqual(toModels(opts), [{ id: 'x/y', displayName: 'x/y' }]);
  });

  test('no model option means an empty catalog, which means unavailable', () => {
    assert.deepStrictEqual(toModels([{ id: 'mode', category: 'mode', options: [] }]), []);
  });

  test('the current value and the option id are reported for set_config_option', () => {
    assert.strictEqual(currentModelId(options), 'opencode/big-pickle');
    assert.strictEqual(modelConfigId(options), 'model');
  });

  test('mode ids come off the mode option', () => {
    assert.deepStrictEqual(toModeIds(options), ['build', 'plan']);
  });

  test('no mode option means no modes rather than an invented default', () => {
    assert.deepStrictEqual(toModeIds([{ id: 'model', category: 'model', options: [] }]), []);
  });
});
