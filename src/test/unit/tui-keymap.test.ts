import * as assert from 'node:assert';
import { actionFor } from '../../tui/keymap';

const idle = { running: false };
const busy = { running: true };

suite('tui keymap', () => {
  test('Ctrl+C interrupts a running turn and otherwise asks to quit', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'c', ctrl: true }, busy), { do: 'interrupt' });
    assert.deepStrictEqual(actionFor('composer', { name: 'c', ctrl: true }, idle), { do: 'quit-request' });
  });
  test('Esc interrupts only while running', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'escape' }, busy), { do: 'interrupt' });
    assert.strictEqual(actionFor('composer', { name: 'escape' }, idle), undefined);
  });
  test('composer: Enter sends, Ctrl+J and Alt+Enter insert a newline, Up recalls', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'return' }, idle), { do: 'send' });
    assert.deepStrictEqual(actionFor('composer', { name: 'j', ctrl: true }, idle), { do: 'newline' });
    assert.deepStrictEqual(actionFor('composer', { name: 'return', meta: true }, idle), { do: 'newline' });
    assert.deepStrictEqual(actionFor('composer', { name: 'up' }, idle), { do: 'history-prev' });
  });
  test('composer: OpenTUI delivers Ctrl+J as a bare linefeed', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'linefeed' }, idle), { do: 'newline' });
    assert.strictEqual(actionFor('transcript', { name: 'linefeed' }, idle), undefined);
  });
  test('a plain letter in the composer is never an action', () => {
    for (const name of ['j', 'k', 'y', 'n', 'x', 'r']) {
      assert.strictEqual(actionFor('composer', { name }, idle), undefined);
    }
  });
  test('transcript, roster, approval and question bindings', () => {
    assert.deepStrictEqual(actionFor('transcript', { name: 'j' }, idle), { do: 'item-next' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'return' }, idle), { do: 'toggle-item' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'end' }, idle), { do: 'repin' });
    assert.deepStrictEqual(actionFor('roster', { name: 'x' }, idle), { do: 'roster-hide' });
    assert.deepStrictEqual(actionFor('roster', { name: 'return' }, idle), { do: 'roster-focus' });
    assert.deepStrictEqual(actionFor('approval', { name: 'y' }, idle), { do: 'allow' });
    assert.deepStrictEqual(actionFor('approval', { name: 'n' }, idle), { do: 'deny' });
    assert.deepStrictEqual(actionFor('question', { name: 'space' }, idle), { do: 'option-toggle' });
    assert.deepStrictEqual(actionFor('question', { name: 'return' }, idle), { do: 'submit-answers' });
  });
  test('the approval zone ignores meta chords', () => {
    assert.strictEqual(actionFor('approval', { name: 'y', meta: true }, idle), undefined);
    assert.strictEqual(actionFor('approval', { name: 'return', meta: true }, idle), undefined);
    assert.deepStrictEqual(actionFor('composer', { name: 'return', meta: true }, idle), { do: 'newline' });
  });
  test('Tab cycles zones except inside a prompt', () => {
    assert.deepStrictEqual(actionFor('composer', { name: 'tab' }, idle), { do: 'cycle-zone' });
    assert.strictEqual(actionFor('approval', { name: 'tab' }, idle), undefined);
    assert.strictEqual(actionFor('question', { name: 'tab' }, idle), undefined);
  });
  test('global chords', () => {
    assert.deepStrictEqual(actionFor('transcript', { name: 'b', ctrl: true }, idle), { do: 'toggle-roster' });
    assert.deepStrictEqual(actionFor('transcript', { name: 'n', ctrl: true }, idle), { do: 'new-session' });
    assert.deepStrictEqual(actionFor('composer', { name: 'tab', shift: true }, idle), { do: 'cycle-mode' });
    assert.deepStrictEqual(actionFor('composer', { name: 'r', ctrl: true }, idle), { do: 'refresh-catalog' });
  });
});
