import * as assert from 'assert';
import { modeCanEdit } from '../../shared/side-chat-mode';

suite('side chat mode', () => {
  test('only plan is a mode that cannot edit', () => {
    assert.strictEqual(modeCanEdit('plan'), false);
    for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypass'] as const) {
      assert.strictEqual(modeCanEdit(mode), true, mode);
    }
  });
});
