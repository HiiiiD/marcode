import type { EffortLevel } from '../providers/types';

export const MEMORY_ENABLED_SETTING = 'marcode.memory.enabled';
export const MEMORY_SUMMARIZER_SETTING = 'marcode.memory.summarizer';

const EFFORTS: readonly EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface LlmSummarizerConfig { provider: string; model: string; effort: EffortLevel }
export type SummarizerSetting = { mode: 'off' } | ({ mode: 'llm' } & LlmSummarizerConfig);
export interface SummarizerValidation { setting: SummarizerSetting; warnings: string[] }

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
  let effort: EffortLevel = 'low';
  if (value.effort !== undefined) {
    if (EFFORTS.includes(value.effort as EffortLevel)) {
      effort = value.effort as EffortLevel;
    } else {
      warnings.push(`${MEMORY_SUMMARIZER_SETTING}.effort "${String(value.effort)}" is not a known level; using "low".`);
    }
  }
  return {
    setting: { mode: 'llm', provider: value.provider as string, model: value.model as string, effort },
    warnings,
  };
}
