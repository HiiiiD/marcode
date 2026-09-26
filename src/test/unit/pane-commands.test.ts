import * as assert from 'assert';
import { paneCommandMessage } from '../../host/pane-commands';
import { layoutOf } from '../fixtures/protocol';

suite('paneCommandMessage', () => {
  const layout = layoutOf(['a', 'b', 'c']);

  test('focusPane.N resolves the Nth leaf to an explicit id', () => {
    assert.deepStrictEqual(paneCommandMessage('marcode.focusPane.2', layout), { t: 'focus-pane', id: 'b' });
  });

  test('a slot past the last pane is no message', () => {
    assert.strictEqual(paneCommandMessage('marcode.focusPane.4', layout), undefined);
  });

  test('empty leaves do not count toward the ordinal', () => {
    const l = { root: { kind: 'split' as const, orientation: 'vertical' as const, size: 100, children: [
      { kind: 'leaf' as const, sessionId: null, size: 50 },
      { kind: 'leaf' as const, sessionId: 'x', size: 50 },
    ] }, presets: [] };
    assert.deepStrictEqual(paneCommandMessage('marcode.focusPane.1', l), { t: 'focus-pane', id: 'x' });
  });

  test('next, prev and maximize carry no id', () => {
    assert.deepStrictEqual(paneCommandMessage('marcode.focusNextPane', layout), { t: 'step-pane', delta: 1 });
    assert.deepStrictEqual(paneCommandMessage('marcode.focusPrevPane', layout), { t: 'step-pane', delta: -1 });
    assert.deepStrictEqual(paneCommandMessage('marcode.toggleMaximizePane', layout), { t: 'toggle-maximize-pane' });
  });
});
