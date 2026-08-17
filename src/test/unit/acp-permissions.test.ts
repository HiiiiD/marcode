import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { autoDecision, chooseOption, type PermissionOption }
  from '../../providers/acp/permissions';

const options = frames.requestPermission.options as PermissionOption[];

suite('acp chooseOption', () => {
  test('an allow selects the allow_once option by the id the request gave', () => {
    assert.deepStrictEqual(chooseOption(options, { allow: true }),
      { outcome: { outcome: 'selected', optionId: 'once' } });
  });

  test('a deny selects a reject option', () => {
    assert.deepStrictEqual(chooseOption(options, { allow: false }),
      { outcome: { outcome: 'selected', optionId: 'reject' } });
  });

  test('ids are never assumed — a differently-named allow option still works', () => {
    const custom: PermissionOption[] = [{ optionId: 'yes-please', kind: 'allow_once' }];
    assert.deepStrictEqual(chooseOption(custom, { allow: true }),
      { outcome: { outcome: 'selected', optionId: 'yes-please' } });
  });

  test('a deny with no reject option offered cancels rather than allowing', () => {
    const allowOnly: PermissionOption[] = [{ optionId: 'once', kind: 'allow_once' }];
    assert.deepStrictEqual(chooseOption(allowOnly, { allow: false }),
      { outcome: { outcome: 'cancelled' } });
  });

  test('an allow with no allow option offered cancels rather than picking blindly', () => {
    const rejectOnly: PermissionOption[] = [{ optionId: 'no', kind: 'reject_once' }];
    assert.deepStrictEqual(chooseOption(rejectOnly, { allow: true }),
      { outcome: { outcome: 'cancelled' } });
  });

  test('an empty option list cancels', () => {
    assert.deepStrictEqual(chooseOption([], { allow: true }), { outcome: { outcome: 'cancelled' } });
  });

  test('preferAlways: true with an allow selects allow_always', () => {
    assert.deepStrictEqual(chooseOption(options, { allow: true }, { preferAlways: true }),
      { outcome: { outcome: 'selected', optionId: 'always' } });
  });

  test('preferAlways: true with an allow, when only allow_once is offered, falls back to it', () => {
    const onceOnly: PermissionOption[] = [{ optionId: 'once', kind: 'allow_once' }];
    assert.deepStrictEqual(chooseOption(onceOnly, { allow: true }, { preferAlways: true }),
      { outcome: { outcome: 'selected', optionId: 'once' } });
  });

  test('preferAlways: true with a deny falls back to available reject option', () => {
    const rejectOnlyFixture: PermissionOption[] = [{ optionId: 'reject', kind: 'reject_once' }];
    assert.deepStrictEqual(chooseOption(rejectOnlyFixture, { allow: false }, { preferAlways: true }),
      { outcome: { outcome: 'selected', optionId: 'reject' } });
  });
});

suite('acp autoDecision', () => {
  test('bypass allows without surfacing a card', () => {
    assert.deepStrictEqual(autoDecision('bypass'), { allow: true });
  });

  test('dontAsk denies without surfacing a card', () => {
    assert.deepStrictEqual(autoDecision('dontAsk'), { allow: false });
  });

  test('default and plan surface the request to the user', () => {
    assert.strictEqual(autoDecision('default'), undefined);
    assert.strictEqual(autoDecision('plan'), undefined);
  });
});
