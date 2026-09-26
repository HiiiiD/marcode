import type { EffortLevel } from '../providers/types';

export const MEMORY_ENABLED_SETTING = 'marcode.memory.enabled';
export const MEMORY_SUMMARIZER_SETTING = 'marcode.memory.summarizer';

const EFFORTS: readonly EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface SummarizerTarget { provider: string; model: string; effort: EffortLevel }
export interface LlmSummarizerConfig extends SummarizerTarget { concurrency: number; fallbacks: SummarizerTarget[] }
export type SummarizerSetting = { mode: 'off' } | ({ mode: 'llm' } & LlmSummarizerConfig);
export interface SummarizerValidation { setting: SummarizerSetting; warnings: string[] }

export const MAX_SUMMARIZER_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 3;

const OFF: SummarizerSetting = { mode: 'off' };

export function validateSummarizer(configured: unknown, providerIds: Iterable<string>): SummarizerValidation {
  if (configured === undefined) { return { setting: OFF, warnings: [] }; }
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    return { setting: OFF, warnings: [`${MEMORY_SUMMARIZER_SETTING} is not an object; ignoring it.`] };
  }
  const value = configured as Record<string, unknown>;
  if (value.mode === undefined || value.mode === 'off') { return { setting: OFF, warnings: [] }; }
  if (value.mode !== 'llm') {
    return { setting: OFF, warnings: [`${MEMORY_SUMMARIZER_SETTING}.mode must be "off" or "llm"; using "off".`] };
  }
  const known = new Set(providerIds);
  const warnings: string[] = [];
  if (typeof value.provider !== 'string' || !known.has(value.provider)) {
    warnings.push(`${MEMORY_SUMMARIZER_SETTING}.provider "${String(value.provider)}" is not an enabled provider; using "off".`);
  }
  if (typeof value.model !== 'string' || value.model.trim() === '') {
    warnings.push(`${MEMORY_SUMMARIZER_SETTING}.model is required when mode is "llm"; using "off".`);
  }
  if (warnings.length > 0) { return { setting: OFF, warnings }; }
  const effort = parseEffort(value.effort, MEMORY_SUMMARIZER_SETTING, warnings);
  let concurrency = DEFAULT_CONCURRENCY;
  if (value.concurrency !== undefined) {
    const n = value.concurrency;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SUMMARIZER_CONCURRENCY) {
      concurrency = n;
    } else {
      warnings.push(`${MEMORY_SUMMARIZER_SETTING}.concurrency must be an integer from 1 to ${MAX_SUMMARIZER_CONCURRENCY}; using ${DEFAULT_CONCURRENCY}.`);
    }
  }
  const fallbacks = parseFallbacks(value.fallbacks, known, warnings);
  return {
    setting: { mode: 'llm', provider: value.provider as string, model: value.model as string, effort, concurrency, fallbacks },
    warnings,
  };
}

function parseEffort(raw: unknown, path: string, warnings: string[]): EffortLevel {
  if (raw === undefined) { return 'low'; }
  if (EFFORTS.includes(raw as EffortLevel)) { return raw as EffortLevel; }
  warnings.push(`${path}.effort "${String(raw)}" is not a known level; using "low".`);
  return 'low';
}

function parseFallbacks(raw: unknown, known: Set<string>, warnings: string[]): SummarizerTarget[] {
  if (raw === undefined) { return []; }
  if (!Array.isArray(raw)) {
    warnings.push(`${MEMORY_SUMMARIZER_SETTING}.fallbacks is not an array; ignoring it.`);
    return [];
  }
  const targets: SummarizerTarget[] = [];
  raw.forEach((entry, i) => {
    const path = `${MEMORY_SUMMARIZER_SETTING}.fallbacks[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`${path} is not an object; skipping it.`);
      return;
    }
    const f = entry as Record<string, unknown>;
    if (typeof f.provider !== 'string' || !known.has(f.provider)) {
      warnings.push(`${path}.provider "${String(f.provider)}" is not an enabled provider; skipping it.`);
      return;
    }
    if (typeof f.model !== 'string' || f.model.trim() === '') {
      warnings.push(`${path}.model is required; skipping it.`);
      return;
    }
    targets.push({ provider: f.provider, model: f.model, effort: parseEffort(f.effort, path, warnings) });
  });
  return targets;
}
