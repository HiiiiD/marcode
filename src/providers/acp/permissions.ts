import type { PermissionMode, ToolDecision } from '../types';

export interface PermissionOption { optionId: string; kind?: string; name?: string }

export type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

const ALLOW_KINDS = ['allow_once', 'allow_always'];
const REJECT_KINDS = ['reject_once', 'reject_always'];

/**
 * The option id is read off the request, never assumed. opencode 1.18.18
 * happens to use `once`/`always`, but the ids are the agent's to choose and a
 * hardcoded string is a bug waiting for the next ACP agent.
 */
export function chooseOption(
  options: PermissionOption[],
  decision: ToolDecision,
  opts?: { preferAlways?: boolean },
): PermissionOutcome {
  const preferAlways = opts?.preferAlways ?? false;
  const wanted = decision.allow
    ? (preferAlways ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'])
    : (preferAlways ? ['reject_always', 'reject_once'] : ['reject_once', 'reject_always']);

  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) { return { outcome: { outcome: 'selected', optionId: match.optionId } }; }
  }
  // Nothing of the requested sort was offered. Cancelling is the only honest
  // answer: picking the other sort would invert the user's decision.
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * `bypass` and `dontAsk` are enforced here rather than on the wire, because
 * ACP hands the decision to the client. If the agent never asks, that is the
 * user's own opencode.json already permitting the call — which is what both
 * modes mean anyway.
 */
export function autoDecision(mode: PermissionMode): ToolDecision | undefined {
  if (mode === 'bypass') { return { allow: true }; }
  if (mode === 'dontAsk') { return { allow: false }; }
  return undefined;
}
