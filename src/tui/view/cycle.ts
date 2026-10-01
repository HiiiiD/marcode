import type { ProviderInfo, SessionSummary } from '../../protocol/messages';
import type { EffortLevel, PermissionMode } from '../../providers/types';

function after<T>(list: T[], current: T | undefined): T | undefined {
  if (list.length === 0) { return undefined; }
  const i = current === undefined ? -1 : list.indexOf(current);
  return list[(i + 1) % list.length];
}

export function nextModel(catalog: ProviderInfo[], s: SessionSummary): string | undefined {
  const ids = catalog.find((p) => p.id === s.providerId)?.models.map((m) => m.id) ?? [];
  return ids.length < 2 ? undefined : after(ids, s.model);
}

export function nextEffort(catalog: ProviderInfo[], s: SessionSummary): EffortLevel | undefined {
  const levels = catalog.find((p) => p.id === s.providerId)?.models.find((m) => m.id === s.model)?.effort?.levels ?? [];
  return levels.length < 2 ? undefined : after(levels, s.effort);
}

// bypass is creation-only on the wire, so a cycle may leave it but never enter it
export function nextMode(catalog: ProviderInfo[], s: SessionSummary): PermissionMode | undefined {
  const modes = (catalog.find((p) => p.id === s.providerId)?.permissionModes ?? []).map((m) => m.id).filter((m) => m !== 'bypass');
  return modes.length < 2 ? undefined : after(modes, s.permissionMode);
}
