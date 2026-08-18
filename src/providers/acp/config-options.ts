import type { ModelInfo } from '../types';

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
