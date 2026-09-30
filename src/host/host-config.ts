import type { UsageMirror } from '../providers/types';
import { DEFAULT_PROVIDER_IDS, KNOWN_PROVIDER_IDS } from '../shared/settings';
import { clampCap } from './fleet-diff';

export interface HostConfig {
  enabledProviders: string[];
  providerInstances: unknown;
  systemPrompts: unknown;
  codexPath?: string;
  opencodePath?: string;
  usageMirrors: UsageMirror[];
  memory: { enabled: boolean; summarizer: unknown };
  review: { fileCap: number; pollIntervalMs: number; baseRefs: string[] };
  favoriteModels: string[];
}

export const MOVED_SETTING_IDS: readonly string[] = [
  'marcode.enabledProviders', 'marcode.providerInstances', 'marcode.systemPrompts', 'marcode.codex.path',
  'marcode.opencode.path', 'marcode.usageMirrors', 'marcode.memory.enabled', 'marcode.memory.summarizer',
  'marcode.review.fileCap', 'marcode.review.pollIntervalMs', 'marcode.review.baseRefs', 'marcode.favoriteModels',
];

export function defaultHostConfig(): HostConfig {
  return {
    enabledProviders: [...DEFAULT_PROVIDER_IDS],
    providerInstances: undefined,
    systemPrompts: undefined,
    usageMirrors: [],
    memory: { enabled: true, summarizer: undefined },
    review: { fileCap: clampCap(undefined), pollIntervalMs: 750, baseRefs: [] },
    favoriteModels: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

const MIRROR_FIELDS = ['sourceProviderId', 'modelPattern', 'targetProviderId', 'usageProviderId', 'displayName'];

export function parseHostConfig(raw: unknown): { config: HostConfig; warnings: string[] } {
  const config = defaultHostConfig();
  const warnings: string[] = [];
  if (raw === undefined) { return { config, warnings }; }
  if (!isObject(raw)) { return { config, warnings: ['config.json is not an object; using the defaults.'] }; }

  if (raw.enabledProviders !== undefined) {
    const ids = stringList(raw.enabledProviders);
    if (!ids) {
      warnings.push('config.json: enabledProviders is not a list of strings; using the default.');
    } else {
      const unknown = ids.filter((id) => !KNOWN_PROVIDER_IDS.includes(id as (typeof KNOWN_PROVIDER_IDS)[number]));
      if (unknown.length > 0) {
        warnings.push(`config.json: ignoring unknown provider ${unknown.join(', ')}. Known providers: ${KNOWN_PROVIDER_IDS.join(', ')}.`);
      }
      config.enabledProviders = ids.filter((id) => !unknown.includes(id));
    }
  }
  config.providerInstances = raw.providerInstances;
  config.systemPrompts = raw.systemPrompts;
  if (typeof raw.codexPath === 'string' && raw.codexPath !== '') { config.codexPath = raw.codexPath; }
  if (typeof raw.opencodePath === 'string' && raw.opencodePath !== '') { config.opencodePath = raw.opencodePath; }

  if (Array.isArray(raw.usageMirrors)) {
    config.usageMirrors = raw.usageMirrors.flatMap((entry): UsageMirror[] => {
      if (!isObject(entry)) { return []; }
      if (!MIRROR_FIELDS.every((f) => typeof entry[f] === 'string' && (entry[f] as string).trim() !== '')) { return []; }
      try { new RegExp(entry.modelPattern as string); } catch { return []; }
      return [entry as unknown as UsageMirror];
    });
  }

  if (raw.memory !== undefined) {
    if (!isObject(raw.memory)) {
      warnings.push('config.json: memory is not an object; using the default.');
    } else {
      if (raw.memory.enabled !== undefined) {
        if (typeof raw.memory.enabled === 'boolean') { config.memory.enabled = raw.memory.enabled; }
        else { warnings.push('config.json: memory.enabled is not a boolean; using the default.'); }
      }
      config.memory.summarizer = raw.memory.summarizer;
    }
  }

  if (isObject(raw.review)) {
    config.review.fileCap = clampCap(raw.review.fileCap as number | undefined);
    const poll = raw.review.pollIntervalMs;
    if (typeof poll === 'number' && !Number.isNaN(poll) && poll >= 1) { config.review.pollIntervalMs = Math.max(100, Math.floor(poll)); }
    if (Array.isArray(raw.review.baseRefs)) {
      config.review.baseRefs = raw.review.baseRefs.filter((r): r is string => typeof r === 'string' && r.trim() !== '');
    }
  }
  config.favoriteModels = (Array.isArray(raw.favoriteModels) ? raw.favoriteModels : [])
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '');

  return { config, warnings };
}

export function reloadSignature(config: HostConfig): string {
  const { favoriteModels: _favorites, ...rest } = config;
  return JSON.stringify(rest);
}
