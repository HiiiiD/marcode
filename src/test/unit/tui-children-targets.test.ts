import * as assert from 'node:assert';
import { childTargets } from '../../tui/view/children-targets';
import { parsePickerCommand } from '../../tui/view/pickers';
import { chordStep } from '../../tui/view/pane-keys';
import { summary } from '../fixtures/protocol';

suite('tui children targets', () => {
  test('the parent comes first, then each branch with its badge and a non-idle status', () => {
    const targets = childTargets(
      summary('kid', {
        parentId: 'main',
        children: [
          { id: 'f', title: 'Fork of plan', origin: 'fork', hidden: false, status: 'idle' },
          { id: 's', title: 'Side: why?', origin: 'side', hidden: true, status: 'running' },
        ],
      }),
      [summary('main', { title: 'Main plan' })],
    );

    assert.deepStrictEqual(targets, [
      { id: 'main', label: '↑ Branched from Main plan' },
      { id: 'f', label: 'Fork · Fork of plan' },
      { id: 's', label: 'Side chat · Side: why? · running' },
    ]);
  });

  test('a deleted parent is shown but cannot be opened', () => {
    assert.deepStrictEqual(childTargets(summary('kid', { parentId: 'gone' }), []), [
      { id: null, label: '↑ Branched from a deleted chat' },
    ]);
  });

  test('a session with no lineage has no targets', () => {
    assert.deepStrictEqual(childTargets(summary('solo'), []), []);
  });

  test('/branches opens the list and Ctrl+W f does too', () => {
    assert.strictEqual(parsePickerCommand('/branches'), 'children');
    assert.deepStrictEqual(chordStep(100, 200, { name: 'f' }).action, { do: 'children' });
  });
});
