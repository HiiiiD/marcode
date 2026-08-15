import type { PermissionMode, PermissionModeInfo } from '../providers/types';

/**
 * The permission mode a session should actually run in, given what it was
 * asking for.
 *
 * The counterpart to `resolveEffort`, and it shares that function's two
 * rules. A mode is a property of the provider, not of the session: a session
 * persisted under one provider's mode set — or under an older build that
 * offered more — must not keep asking for something the backend cannot do.
 * And an absent list is no opinion rather than a veto: the catalog may not
 * have loaded, and wiping a real choice is worse than honoring one we cannot
 * yet verify.
 *
 * The fallback is always 'default', never the requested-but-unavailable mode
 * and never 'bypass'. Bypass is settable only before a session's first
 * message; resolving *into* it would hand a session the one mode that runs
 * anything without asking, through a code path the user never touched.
 */
export function resolvePermissionMode(
  modes: PermissionModeInfo[], requested: PermissionMode | undefined,
): PermissionMode {
  if (modes.length === 0) { return requested ?? 'default'; }
  return requested && modes.some((m) => m.id === requested) ? requested : 'default';
}
