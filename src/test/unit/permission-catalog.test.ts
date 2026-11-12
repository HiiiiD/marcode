import * as assert from 'assert';
import type { PermissionModeInfo } from '../../providers/types';
import { defaultPermissionMode, resolvePermissionMode } from '../../shared/permission-catalog';

const CODEX: PermissionModeInfo[] = [
  { id: 'default' }, { id: 'auto' }, { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
];

suite('resolvePermissionMode', () => {
  test('keeps a mode the provider offers', () => {
    assert.strictEqual(resolvePermissionMode(CODEX, 'plan'), 'plan');
  });

  test('falls back to default for a mode the provider does not offer', () => {
    // Codex omits acceptEdits: under workspace-write it would be a second
    // name for 'default'.
    assert.strictEqual(resolvePermissionMode(CODEX, 'acceptEdits'), 'default');
  });

  test('never resolves upward into bypass', () => {
    // bypass is settable only at creation. A persisted session whose mode
    // vanished must not be silently promoted into the one mode that runs
    // anything without asking.
    const noDefault: PermissionModeInfo[] = [{ id: 'bypass' }];
    assert.strictEqual(resolvePermissionMode(noDefault, 'acceptEdits'), 'default');
  });

  test('an empty list is no opinion, not a veto', () => {
    // The catalog has not loaded yet; wiping a real choice would be worse
    // than honoring one we cannot yet verify.
    assert.strictEqual(resolvePermissionMode([], 'plan'), 'plan');
  });

  test('an absent request resolves to default', () => {
    assert.strictEqual(resolvePermissionMode(CODEX, undefined), 'default');
  });

  test('an absent or unavailable request resolves to the provider-marked default', () => {
    const claude: PermissionModeInfo[] = [{ id: 'default' }, { id: 'auto', default: true }, { id: 'plan' }];
    assert.strictEqual(resolvePermissionMode(claude, undefined), 'auto');
    assert.strictEqual(resolvePermissionMode(claude, 'acceptEdits'), 'auto');
    assert.strictEqual(resolvePermissionMode(claude, 'plan'), 'plan');
  });

  test('a bypass-marked default is ignored', () => {
    assert.strictEqual(defaultPermissionMode([{ id: 'bypass', default: true }]), 'default');
  });
});
