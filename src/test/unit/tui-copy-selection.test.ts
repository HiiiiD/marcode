import * as assert from 'assert';
import { copySelection } from '../../tui/ui/copy-selection';

function fake(selected: string | null) {
  const calls: string[] = [];
  const renderer = {
    hasSelection: selected !== null,
    getSelection: () => (selected === null ? null : { getSelectedText: () => selected }),
    copyToClipboardOSC52: (t: string) => { calls.push(`copy:${t}`); return true; },
    clearSelection: () => { calls.push('clear'); },
  };
  return { renderer: renderer as unknown as Parameters<typeof copySelection>[0], calls };
}

suite('tui copy selection', () => {
  test('copies the selected text, clears it and consumes the key', () => {
    const { renderer, calls } = fake('hello');
    assert.strictEqual(copySelection(renderer), true);
    assert.deepStrictEqual(calls, ['copy:hello', 'clear']);
  });

  test('without a selection it leaves the key alone', () => {
    const { renderer, calls } = fake(null);
    assert.strictEqual(copySelection(renderer), false);
    assert.deepStrictEqual(calls, []);
  });
});
