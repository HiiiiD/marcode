import * as path from 'node:path';
import type { PermissionMode } from '../../protocol/messages';
import type { EffortLevel } from '../../providers/types';
import type { SessionManagerLike } from '../self-control-mcp-server';

export type Caller = ReturnType<SessionManagerLike['summaries']>[number];

export interface SpawnRequest {
  provider?: string; model?: string; effort?: EffortLevel; mode?: string; cwd: string;
}

export interface ResolvedSpawn {
  providerId: string;
  model: string | undefined;
  effort: EffortLevel | undefined;
  mode: PermissionMode | undefined;
  cwd: string;
}

type Resolution = { ok: true; spawn: ResolvedSpawn } | { ok: false; error: string };

export function resolveSpawn(
  manager: Pick<SessionManagerLike, 'catalog'>, from: Caller | undefined, req: SpawnRequest,
): Resolution {
  const providerId = req.provider ?? from?.providerId;
  if (!providerId) { return { ok: false, error: 'provider is required when the calling session cannot be identified' }; }
  const entry = manager.catalog().find((p) => p.id === providerId);
  if (!entry) { return { ok: false, error: `Unknown or unavailable provider: ${providerId}` }; }
  const effectiveModel = req.model ?? from?.model;
  // Alias-aware: a persisted canonical id can only match through an alias row's `resolvedModel`.
  const modelEntry = effectiveModel === undefined
    ? entry.models[0]
    : entry.models.find((m) => m.id === effectiveModel || m.resolvedModel === effectiveModel);
  if (effectiveModel !== undefined && !modelEntry) {
    return { ok: false, error: `Provider ${providerId} has no model ${effectiveModel}` };
  }
  // Effort belongs to the model: no effort control means none; an unpublished level falls back to the model default.
  const requestedEffort = req.effort ?? from?.effort;
  const effort = modelEntry?.effort
    ? (requestedEffort && modelEntry.effort.levels.includes(requestedEffort)
      ? requestedEffort
      : modelEntry.effort.default as EffortLevel)
    : undefined;
  const explicitMode = req.mode as PermissionMode | undefined;
  let mode = (explicitMode ?? from?.permissionMode) as PermissionMode | undefined;
  if (mode !== undefined && !entry.permissionModes.some((m) => m.id === mode)) {
    return { ok: false, error: `Provider ${providerId} has no mode ${mode}` };
  }
  // An explicit bypass would let a restricted session delegate around its restriction; an inherited one is merely dropped.
  if (explicitMode === 'bypass') { return { ok: false, error: 'spawn_session cannot create bypass-mode sessions' }; }
  if (mode === 'bypass') { mode = undefined; }
  if (!path.isAbsolute(req.cwd)) { return { ok: false, error: `cwd must be an absolute path: ${req.cwd}` }; }
  return { ok: true, spawn: { providerId, model: effectiveModel, effort, mode, cwd: req.cwd } };
}

export async function openPane(manager: SessionManagerLike, id: string): Promise<void> {
  if (manager.reveal) { await manager.reveal(id); return; }
  await manager.setVisible([...new Set([...manager.visibleIds(), id])]);
}

// `send` is not part of SessionManagerLike; a minimal fake without a real AgentSession must not blow up here.
export function sendPrompt(session: unknown, text: string): void {
  const sendable = session as { send?: (text: string) => void };
  if (typeof sendable.send === 'function') { sendable.send(text); }
}
