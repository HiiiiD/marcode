import { checkServerUrl } from '../sync/server-url';
import * as path from 'node:path';
import type { UsageMirror } from '../providers/types';
import { DEFAULT_PROVIDER_IDS, KNOWN_PROVIDER_IDS } from '../shared/settings';
import { parseTheme, type ThemeColors } from '../shared/theme-settings';
import { parseTranscriptSettings, type TranscriptDensity } from '../shared/transcript-density';
import { SPAWN_PREFERENCES, type SpawnPreference } from './self-control/spawn-preference';
import { clampCap } from './fleet-diff';
import { DEFAULT_SHELL_ALIASES, parseShellAliases, type ShellAliasTable } from './shell/shell-aliases';

/** `project` is `'own'` (memory kept apart) or a project id the checkout at `path` is linked to. */
export interface ProjectOverride { path: string; project: string }

export interface HostConfig {
  enabledProviders: string[];
  providerInstances: unknown;
  systemPrompts: unknown;
  codexPath?: string;
  opencodePath?: string;
  /** Terminal client only: the command a pending plan is opened with, given the plan file as its last argument. */
  planEditor?: string;
  usageMirrors: UsageMirror[];
  memory: { enabled: boolean; summarizer: unknown };
  projects: { overrides: ProjectOverride[] };
  /** The sync server and this device's name; the device token and keys live in `sync/credentials.json`, never here. */
  sync: { server?: string; deviceName?: string; excludeProjects: string[]; takeOverAfterMinutes: number };
  review: { fileCap: number; pollIntervalMs: number; baseRefs: string[] };
  favoriteModels: string[];
  daemon: { enabled: boolean; idleMinutes: number };
  shell: { aliases: ShellAliasTable };
  layout: { autoGrid: boolean };
  theme: ThemeColors;
  transcript: { density: TranscriptDensity };
  claude: { claudeAiConnectors: boolean };
  spawn: { preference: SpawnPreference };
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
    projects: { overrides: [] },
    sync: { excludeProjects: [], takeOverAfterMinutes: 10 },
    review: { fileCap: clampCap(undefined), pollIntervalMs: 750, baseRefs: [] },
    favoriteModels: [],
    daemon: { enabled: true, idleMinutes: 10 },
    shell: { aliases: { ...DEFAULT_SHELL_ALIASES } },
    layout: { autoGrid: true },
    theme: {},
    transcript: { density: 'default' },
    claude: { claudeAiConnectors: false },
    spawn: { preference: 'auto' },
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
  if (typeof raw.planEditor === 'string' && raw.planEditor.trim() !== '') { config.planEditor = raw.planEditor.trim(); }

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

  if (raw.projects !== undefined) {
    if (!isObject(raw.projects)) {
      warnings.push('config.json: projects is not an object; using the default.');
    } else if (raw.projects.overrides !== undefined) {
      if (!Array.isArray(raw.projects.overrides)) {
        warnings.push('config.json: projects.overrides is not a list; using the default.');
      } else {
        config.projects.overrides = raw.projects.overrides.flatMap((entry, i): ProjectOverride[] => {
          const ok = isObject(entry)
            && typeof entry.path === 'string' && entry.path.trim() !== ''
            && (path.posix.isAbsolute(entry.path) || path.win32.isAbsolute(entry.path))
            && typeof entry.project === 'string' && entry.project.trim() !== '';
          if (!ok) {
            warnings.push(`config.json: projects.overrides[${i}] needs an absolute "path" and a non-empty "project"; ignored.`);
            return [];
          }
          return [{ path: entry.path as string, project: entry.project as string }];
        });
      }
    }
  }

  if (raw.sync !== undefined) {
    if (!isObject(raw.sync)) {
      warnings.push('config.json: sync is not an object; ignored.');
    } else {
      if (raw.sync.server !== undefined) {
        const verdict = typeof raw.sync.server === 'string' ? checkServerUrl(raw.sync.server) : { ok: false as const, reason: 'not a string' };
        if (verdict.ok) { config.sync.server = verdict.base; } else { warnings.push(`config.json: sync.server ignored: ${verdict.reason}`); }
      }
      if (typeof raw.sync.deviceName === 'string' && raw.sync.deviceName.trim() !== '') { config.sync.deviceName = raw.sync.deviceName; }
      if (raw.sync.excludeProjects !== undefined) {
        const list = Array.isArray(raw.sync.excludeProjects) ? raw.sync.excludeProjects : [];
        config.sync.excludeProjects = list.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
        if (config.sync.excludeProjects.length !== list.length || !Array.isArray(raw.sync.excludeProjects)) {
          warnings.push('config.json: sync.excludeProjects must be a list of project ids; other entries ignored.');
        }
      }
      if (raw.sync.takeOverAfterMinutes !== undefined) {
        const minutes = raw.sync.takeOverAfterMinutes;
        if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0) { config.sync.takeOverAfterMinutes = minutes; }
        else { warnings.push('config.json: sync.takeOverAfterMinutes must be a whole number of minutes above 0; using 10.'); }
      }
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

  if (raw.shell !== undefined) {
    if (!isObject(raw.shell)) {
      warnings.push('config.json: shell is not an object; using the default.');
    } else {
      const parsed = parseShellAliases(raw.shell.aliases);
      config.shell.aliases = parsed.aliases;
      warnings.push(...parsed.warnings);
    }
  }

  if (raw.daemon !== undefined) {
    if (!isObject(raw.daemon)) {
      warnings.push('config.json: daemon is not an object; using the default.');
    } else {
      if (raw.daemon.enabled !== undefined) {
        if (typeof raw.daemon.enabled === 'boolean') { config.daemon.enabled = raw.daemon.enabled; }
        else { warnings.push('config.json: daemon.enabled is not a boolean; using the default.'); }
      }
      if (raw.daemon.idleMinutes !== undefined) {
        const m = raw.daemon.idleMinutes;
        if (typeof m === 'number' && Number.isFinite(m) && m >= 1) { config.daemon.idleMinutes = Math.floor(m); }
        else { warnings.push('config.json: daemon.idleMinutes must be a number of at least 1; using the default.'); }
      }
    }
  }

  if (raw.layout !== undefined) {
    if (!isObject(raw.layout)) {
      warnings.push('config.json: layout is not an object; using the default.');
    } else if (raw.layout.autoGrid !== undefined) {
      if (typeof raw.layout.autoGrid === 'boolean') { config.layout.autoGrid = raw.layout.autoGrid; }
      else { warnings.push('config.json: layout.autoGrid is not a boolean; using the default.'); }
    }
  }

  if (raw.claude !== undefined) {
    if (!isObject(raw.claude)) {
      warnings.push('config.json: claude is not an object; using the default.');
    } else if (raw.claude.claudeAiConnectors !== undefined) {
      if (typeof raw.claude.claudeAiConnectors === 'boolean') { config.claude.claudeAiConnectors = raw.claude.claudeAiConnectors; }
      else { warnings.push('config.json: claude.claudeAiConnectors is not a boolean; using the default.'); }
    }
  }

  if (raw.spawn !== undefined) {
    if (!isObject(raw.spawn)) {
      warnings.push('config.json: spawn is not an object; using the default.');
    } else if (raw.spawn.preference !== undefined) {
      const p = raw.spawn.preference;
      if (SPAWN_PREFERENCES.includes(p as SpawnPreference)) { config.spawn.preference = p as SpawnPreference; }
      else { warnings.push(`config.json: spawn.preference must be one of ${SPAWN_PREFERENCES.join(', ')}; using the default.`); }
    }
  }

  const themed = parseTheme(raw.theme);
  config.theme = themed.theme;
  warnings.push(...themed.warnings);

  const transcript = parseTranscriptSettings(raw.transcript);
  config.transcript.density = transcript.density;
  warnings.push(...transcript.warnings);

  return { config, warnings };
}

export function reloadSignature(config: HostConfig): string {
  const { favoriteModels: _favorites, ...rest } = config;
  return JSON.stringify(rest);
}
