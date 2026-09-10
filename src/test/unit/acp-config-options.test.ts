import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { currentModelId, effortConfigId, modelConfigId, toEffort, toModeIds, toModels }
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

  test('a thought_level option becomes effort levels and a default', () => {
    const opts: ConfigOption[] = [{
      id: 'effort', category: 'thought_level', currentValue: 'low',
      options: [{ value: 'minimal' }, { value: 'low' }, { value: 'high' }],
    }];
    assert.deepStrictEqual(toEffort(opts), { levels: ['minimal', 'low', 'high'], default: 'low' });
  });

  test('a reasoning-category option is read the same way as thought_level', () => {
    const opts: ConfigOption[] = [{
      id: 'reasoning', category: 'reasoning', currentValue: 'high',
      options: [{ value: 'low' }, { value: 'high' }],
    }];
    assert.deepStrictEqual(toEffort(opts), { levels: ['low', 'high'], default: 'high' });
  });

  test('no effort option means no effort control', () => {
    assert.deepStrictEqual(toEffort(options), undefined);
  });

  test('a level the shared union does not know is dropped, not thrown', () => {
    const opts: ConfigOption[] = [{
      id: 'effort', category: 'thought_level', currentValue: 'potato',
      options: [{ value: 'low' }, { value: 'potato' }, { value: 'high' }],
    }];
    assert.deepStrictEqual(toEffort(opts), { levels: ['low', 'high'], default: 'low' });
  });

  test('every level dropped means no effort control rather than an empty list', () => {
    const opts: ConfigOption[] = [{
      id: 'effort', category: 'thought_level', currentValue: 'potato',
      options: [{ value: 'potato' }],
    }];
    assert.deepStrictEqual(toEffort(opts), undefined);
  });

  test('effortConfigId reports the id to pass to set_config_option', () => {
    const opts: ConfigOption[] = [
      { id: 'effort', category: 'thought_level', options: [{ value: 'low' }] }];
    assert.strictEqual(effortConfigId(opts), 'effort');
  });

  test('no effort option means no effortConfigId', () => {
    assert.strictEqual(effortConfigId(options), undefined);
  });
});
