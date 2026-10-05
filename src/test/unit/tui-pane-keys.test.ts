import * as assert from 'node:assert';
import { CHORD_MS, chordStep } from '../../tui/view/pane-keys';

const ctrlW = { name: 'w', ctrl: true };

suite('tui pane chords', () => {
  test('Ctrl+W arms and is consumed; other keys pass through when unarmed', () => {
    assert.deepStrictEqual(chordStep(null, 100, ctrlW), { armedAt: 100, consumed: true });
    assert.deepStrictEqual(chordStep(null, 100, { name: 'h' }), { armedAt: null, consumed: false });
  });
  test('direction keys and arrows focus', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'h' }), { armedAt: null, consumed: true, action: { do: 'focus', dir: 'left' } });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'down' }).action, { do: 'focus', dir: 'down' });
  });
  test('split, maximize, even, hide', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: '|', sequence: '|' }).action, { do: 'split', orientation: 'horizontal' });
    assert.deepStrictEqual(chordStep(100, 200, { name: '-', sequence: '-' }).action, { do: 'split', orientation: 'vertical' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'm' }).action, { do: 'maximize' });
    assert.deepStrictEqual(chordStep(100, 200, { name: '=', sequence: '=' }).action, { do: 'even' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'x' }).action, { do: 'hide' });
  });
  test('g opens the layout dialog', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'g' }), { armedAt: null, consumed: true, action: { do: 'layout' } });
  });
  test('shifted letters resize', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'l', shift: true }).action, { do: 'resize', dir: 'right' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'k', shift: true }).action, { do: 'resize', dir: 'up' });
  });
  test('Esc and unknown keys disarm and are swallowed', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'escape' }), { armedAt: null, consumed: true });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'q' }), { armedAt: null, consumed: true });
  });
  test('an expired arm is ignored and the key passes through', () => {
    assert.deepStrictEqual(chordStep(100, 100 + CHORD_MS + 1, { name: 'h' }), { armedAt: null, consumed: false });
  });
  test('Ctrl+W while armed re-arms', () => {
    assert.deepStrictEqual(chordStep(100, 200, ctrlW), { armedAt: 200, consumed: true });
  });
});
