import type { ToolCall } from '../../providers/canonical/tool-call';
import type { PermissionMeta, ToolDecision } from '../../providers/types';
import type { Caller, Resolution, ResolvedSpawn } from '../self-control/spawn-support';

type Approval = { ok: true } | { ok: false; error: string };

interface Requester { requestHostApproval?(tool: ToolCall, meta?: PermissionMeta): Promise<ToolDecision> }

export async function approveSpawn(
  requester: Requester | undefined, spawn: ResolvedSpawn, prompt: string, kind: 'session' | 'subagent' = 'session',
): Promise<Approval> {
  if (!requester?.requestHostApproval) {
    return { ok: false, error: 'A bypass-mode session needs user approval, and this caller cannot ask for it.' };
  }
  const decision = await requester.requestHostApproval(
    { kind: 'spawn', label: kind === 'subagent' ? 'Spawn subagent' : 'Spawn session', cwd: spawn.cwd, mode: spawn.mode ?? 'bypass', prompt },
    { title: 'Allow a bypass-mode session?', description: 'It will run with no approval prompts.' },
  );
  if (decision.allow) { return { ok: true }; }
  return { ok: false, error: `The user did not approve the bypass-mode session${decision.reason ? `: ${decision.reason}` : '.'}` };
}

/** Asks the user only when the resolution demands it; everything else passes straight through. */
export async function gateSpawn(
  manager: { get(id: string): Promise<Requester | undefined> | Requester | undefined },
  from: Caller | undefined,
  resolved: Extract<Resolution, { ok: true }>,
  prompt: string,
  kind: 'session' | 'subagent' = 'session',
): Promise<Approval> {
  if (resolved.needsApproval !== 'bypass') { return { ok: true }; }
  return approveSpawn(from ? await manager.get(from.id) : undefined, resolved.spawn, prompt, kind);
}
