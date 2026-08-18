import type { PermissionMode } from '../types';

/**
 * OpenCode's own session-mode name for one of this panel's permission modes.
 *
 * This is the vendor half of `AcpRun`'s mode handling, and it lives here for
 * the same reason `openCodeTools` does: `src/providers/acp/` is meant to cost
 * a second ACP agent nothing but a spawn recipe and a couple of mappers, and
 * `'plan'`/`'build'` are names OpenCode chose. A different ACP agent names its
 * modes differently, or has none — hence the `undefined` in the option's type.
 *
 * Only `plan` maps to plan: every other mode maps to `build`, because plan
 * mode is a wire-level state that only an explicit `build` retracts. The
 * modes that this panel enforces client-side (`bypass`, `dontAsk`, answered
 * in `AcpRun.onRequestPermission`) still need the agent taken *out* of plan,
 * or it goes on refusing to edit while every request is auto-allowed.
 */
export function openCodeModeId(mode: PermissionMode): string {
  return mode === 'plan' ? 'plan' : 'build';
}
