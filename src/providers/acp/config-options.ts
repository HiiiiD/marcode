import type { EffortLevel, ModelInfo } from '../types';

export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string; description?: string }[];
}

const byCategory = (options: ConfigOption[], category: string): ConfigOption | undefined =>
  options.find((o) => o.category === category);

/**
 * The catalog IS the availability signal: an agent that reports no model
 * option reports no models, and `SessionManager` reads that as unavailable.
 * There is deliberately no fallback list here.
 */
export function toModels(options: ConfigOption[]): ModelInfo[] {
  const model = byCategory(options, 'model');
  return (model?.options ?? []).map((o) => ({ id: o.value, displayName: o.name ?? o.value }));
}

export function currentModelId(options: ConfigOption[]): string | undefined {
  return byCategory(options, 'model')?.currentValue;
}

/** The id to pass to `session/set_config_option`; `'model'` on opencode 1.18.18. */
export function modelConfigId(options: ConfigOption[]): string | undefined {
  return byCategory(options, 'model')?.id;
}

export function toModeIds(options: ConfigOption[]): string[] {
  return (byCategory(options, 'mode')?.options ?? []).map((o) => o.value);
}

const LEVELS: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const isLevel = (e: string): e is EffortLevel => (LEVELS as string[]).includes(e);

/**
 * OpenCode's reasoning control never advertised itself the same way twice
 * across the field: `thought_level` is what 1.18.30 actually sends, but the
 * design's own guess of `reasoning` is kept as a fallback rather than
 * deleted — a second install answering under the older name must not go
 * back to reporting no effort control at all.
 */
function effortOption(options: ConfigOption[]): ConfigOption | undefined {
  return options.find(
    (o) => o.category === 'thought_level' || o.category === 'reasoning'
      || o.id === 'thought_level' || o.id === 'reasoning',
  );
}

/** The id to pass to `session/set_config_option` for the effort control, or `undefined` when the model has none. */
export function effortConfigId(options: ConfigOption[]): string | undefined {
  return effortOption(options)?.id;
}

/**
 * Same "read what is there" rule `toModels` follows: an unrecognized level is
 * dropped rather than crashing the shared, closed `EffortLevel` union — see
 * `effortLevelsOf` in `src/providers/codex/map-settings.ts` for the identical
 * call made for Codex's own reasoning-effort scale.
 */
export function toEffort(options: ConfigOption[]): ModelInfo['effort'] {
  const option = effortOption(options);
  const levels = (option?.options ?? []).map((o) => o.value).filter(isLevel);
  if (levels.length === 0) { return undefined; }
  const current = option?.currentValue;
  const fallback = current && isLevel(current) && levels.includes(current) ? current : levels[0];
  return { levels, default: fallback };
}
