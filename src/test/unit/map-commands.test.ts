import * as assert from 'assert';
import { toInvocables } from '../../providers/claude/map-commands';

suite('map-commands', () => {
  test('maps name, description and argument hint', () => {
    const out = toInvocables([
      { name: 'loop', description: 'Run a prompt on an interval', argumentHint: '[interval]' },
    ]);

    assert.deepStrictEqual(out, [
      { name: 'loop', description: 'Run a prompt on an interval', argHint: '[interval]' },
    ]);
  });

  test('an empty argument hint becomes absent, not blank', () => {
    const out = toInvocables([{ name: 'init', description: 'Init', argumentHint: '' }]);

    assert.strictEqual('argHint' in out[0], false);
  });

  test('a plugin-qualified name yields an origin and keeps its full name', () => {
    const out = toInvocables([
      { name: 'superpowers:brainstorming', description: 'Design first', argumentHint: '' },
    ]);

    assert.strictEqual(out[0].name, 'superpowers:brainstorming');
    assert.strictEqual(out[0].origin, 'superpowers');
  });

  test('only the first colon splits the origin', () => {
    const out = toInvocables([{ name: 'a:b:c', description: '', argumentHint: '' }]);

    assert.strictEqual(out[0].origin, 'a');
    assert.strictEqual(out[0].name, 'a:b:c');
  });

  test('an unqualified name has no origin, and a leading colon is not an origin', () => {
    const out = toInvocables([
      { name: 'init', description: '', argumentHint: '' },
      { name: ':weird', description: '', argumentHint: '' },
    ]);

    assert.strictEqual(out[0].origin, undefined);
    assert.strictEqual(out[1].origin, undefined);
  });

  test('an empty description becomes absent', () => {
    const out = toInvocables([{ name: 'init', description: '', argumentHint: '' }]);

    assert.strictEqual('description' in out[0], false);
  });

  test('non-array input and unusable entries are dropped, not thrown on', () => {
    assert.deepStrictEqual(toInvocables(undefined), []);
    assert.deepStrictEqual(toInvocables('nope'), []);
    assert.deepStrictEqual(toInvocables([null, 7, { description: 'no name' }, { name: '' }]), []);
  });
});
