import type { ProviderInfo, SessionSummary } from '../../protocol/messages';
import type { EffortLevel, PermissionMode } from '../../providers/types';
import { expandedDisplayName, findModel, isFavorite, resolveEffort, sortFavoritesFirst } from '../../shared/model-catalog';
import { modeRowsForProvider } from '../../shared/permission-modes';

export interface ModelOption { id: string; label: string; favorite: boolean; current: boolean }
export interface EffortRow { levels: EffortLevel[]; level: EffortLevel }
export interface ModeOption { id: PermissionMode; label: string; description: string; current: boolean; disabled?: string }

export const BYPASS_LOCKED = 'Bypass can only be chosen before the first message is sent.';

export function modelOptions(catalog: ProviderInfo[], s: SessionSummary, favorites: string[], filter = ''): ModelOption[] {
  const models = catalog.find((p) => p.id === s.providerId)?.models ?? [];
  const current = findModel(models, s.model);
  const sorted = sortFavoritesFirst(models, s.providerId, favorites);
  const listed = current && !sorted.some((m) => m.id === current.id) ? [current, ...sorted] : sorted;
  const rows = s.model && !current ? [{ id: s.model, displayName: s.model }, ...listed] : listed;
  const needle = filter.trim().toLowerCase();
  return rows
    .map((m) => ({
      id: m.id,
      label: expandedDisplayName(m),
      favorite: isFavorite(s.providerId, m.id, favorites),
      current: m.id === (current?.id ?? s.model),
    }))
    .filter((o) => needle === '' || o.label.toLowerCase().includes(needle));
}

export function effortRow(catalog: ProviderInfo[], s: SessionSummary): EffortRow | undefined {
  const model = findModel(catalog.find((p) => p.id === s.providerId)?.models ?? [], s.model);
  if (!model?.effort || model.effort.levels.length === 0) { return undefined; }
  const level = resolveEffort(model, s.effort);
  return level ? { levels: model.effort.levels, level } : undefined;
}

export function modeOptions(catalog: ProviderInfo[], s: SessionSummary, hasStarted: boolean): ModeOption[] {
  const declared = catalog.find((p) => p.id === s.providerId)?.permissionModes;
  return modeRowsForProvider(s.providerId, declared).map((row) => ({
    id: row.value,
    label: row.label,
    description: row.description,
    current: row.value === s.permissionMode,
    ...(row.value === 'bypass' && hasStarted ? { disabled: BYPASS_LOCKED } : {}),
  }));
}

export function windowAround(length: number, index: number, size: number): { start: number; end: number } {
  if (length <= size) { return { start: 0, end: length }; }
  const start = Math.max(0, Math.min(length - size, index - Math.floor(size / 2)));
  return { start, end: start + size };
}

export type PickerKind = 'model' | 'mode' | 'effort' | 'context' | 'layout';

export function parsePickerCommand(text: string): PickerKind | undefined {
  const match = /^\/(model|mode|effort|context|layout)$/.exec(text.trim());
  return match?.[1] as PickerKind | undefined;
}
