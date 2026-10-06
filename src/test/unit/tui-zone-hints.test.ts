import * as assert from 'node:assert';
import { zoneBar } from '../../tui/view/zone-hints';

suite('tui zone hints', () => {
  test('each zone names itself and how to leave it', () => {
    assert.strictEqual(zoneBar('composer', 200).label, 'composer');
    assert.strictEqual(zoneBar('transcript', 200).hints.endsWith('Tab next'), true);
    assert.strictEqual(zoneBar('roster', 200).hints.includes('p pin'), true);
  });
  test('prompts do not offer Tab, which they do not honour', () => {
    assert.strictEqual(zoneBar('approval', 200).hints.includes('Tab'), false);
    assert.strictEqual(zoneBar('question', 200).hints.includes('Tab'), false);
  });
  test('a narrow line drops hints from the right but keeps Tab next', () => {
    const bar = zoneBar('transcript', 40);
    assert.strictEqual(bar.hints.endsWith('Tab next'), true);
    assert.strictEqual(bar.label.length + 3 + bar.hints.length <= 40, true);
    assert.strictEqual(bar.hints.includes('End latest'), false);
  });
  test('too narrow for any hint leaves just the label', () => {
    assert.deepStrictEqual(zoneBar('roster', 5), { label: 'roster', hints: '' });
  });
});
