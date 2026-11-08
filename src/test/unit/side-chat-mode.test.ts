import * as assert from 'assert';
import type { PermissionModeInfo } from '../../providers/types';
import { modeCanEdit, readOnlyModeFor } from '../../shared/side-chat-mode';

const modes = (...ids: PermissionModeInfo['id'][]): PermissionModeInfo[] => ids.map((id) => ({ id }));

suite('side chat mode', () => {
  test('plan is the read-only mode and cannot edit', () => {
    assert.deepStrictEqual(
      readOnlyModeFor(modes('default', 'acceptEdits', 'plan', 'dontAsk', 'bypass')),
      { mode: 'plan', canEdit: false },
    );
  });

  test('without plan, dontAsk is the strictest and still can edit', () => {
    assert.deepStrictEqual(
      readOnlyModeFor(modes('default', 'dontAsk', 'bypass')),
      { mode: 'dontAsk', canEdit: true },
    );
  });

  test('with neither, default is chosen and never bypass', () => {
    assert.deepStrictEqual(
      readOnlyModeFor(modes('default', 'bypass')),
      { mode: 'default', canEdit: true },
    );
  });

  test('only plan is a mode that cannot edit', () => {
    assert.strictEqual(modeCanEdit('plan'), false);
    for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypass'] as const) {
      assert.strictEqual(modeCanEdit(mode), true, mode);
    }
  });
});
