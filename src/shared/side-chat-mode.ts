import type { PermissionMode, PermissionModeInfo } from '../providers/types';

/** Only `plan` denies edits and shell outright; every other mode can run one. */
export function modeCanEdit(mode: PermissionMode): boolean {
  return mode !== 'plan';
}

/**
 * The strictest mode a provider offers for a side chat. Never `bypass`, even
 * when the parent runs in it. `canEdit` is what the pane warns about.
 */
export function readOnlyModeFor(modes: PermissionModeInfo[]): { mode: PermissionMode; canEdit: boolean } {
  const offered = new Set(modes.map((m) => m.id));
  const mode: PermissionMode = offered.has('plan') ? 'plan' : offered.has('dontAsk') ? 'dontAsk' : 'default';
  return { mode, canEdit: modeCanEdit(mode) };
}
