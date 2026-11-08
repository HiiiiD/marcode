import type { PermissionMode } from '../providers/types';

/** Only `plan` denies edits and shell outright; every other mode can run one. */
export function modeCanEdit(mode: PermissionMode): boolean {
  return mode !== 'plan';
}
