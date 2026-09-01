import * as path from 'node:path';

import type { ProviderInstanceConfig, ProviderInstanceKind } from './provider-instances';

/**
 * Only claude and codex have a config-dir `envMap` key whose directory holds
 * a `skills/` and `plugins/` subdirectory in the same shape as one another
 * (verified against both CLIs' own home-dir layouts). Used both to resolve
 * the account-setup wizard's copy-step source/target and to gate that step
 * to these two kinds — opencode's config layout isn't confirmed the same
 * way. See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export const CONFIG_DIR_ENV_KEY: Record<'claude' | 'codex', string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/** The allowed `envMap` subprocess-var keys per kind — mirrors `package.json`'s `marcode.providerInstances` schema. */
export const ENV_MAP_KEYS: Record<ProviderInstanceKind, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT'],
};

/** Whether the copy-skills-and-plugins wizard step applies to this kind (see `CONFIG_DIR_ENV_KEY` doc). */
export function supportsSkillsCopy(kind: ProviderInstanceKind): kind is 'claude' | 'codex' {
  return kind === 'claude' || kind === 'codex';
}

/** `<home>/.claude` or `<home>/.codex` — the platform default when the main account never set a config-dir env var. */
export function defaultConfigDir(kind: 'claude' | 'codex', home: string): string {
  return path.join(home, kind === 'claude' ? '.claude' : '.codex');
}

/**
 * Resolves the *source* config dir to copy skills/plugins from: the main
 * account's own config-dir env var if it set one (non-empty), else the
 * platform default. Never the new instance's own env — that is resolved
 * directly from the OS var the wizard is about to write, by the caller.
 */
export function resolveSourceConfigDir(
  kind: 'claude' | 'codex', osEnv: NodeJS.ProcessEnv, home: string,
): string {
  const fromEnv = osEnv[CONFIG_DIR_ENV_KEY[kind]];
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : defaultConfigDir(kind, home);
}

/** True when `id` (trimmed) would collide with an existing instance id or a base kind id. Mirrors `validateProviderInstances`'s own collision rule. */
export function isDuplicateInstanceId(
  id: string, existing: readonly ProviderInstanceConfig[], baseIds: readonly string[],
): boolean {
  const trimmed = id.trim();
  return baseIds.includes(trimmed) || existing.some((cfg) => cfg.id === trimmed);
}

/**
 * Derives a deterministic OS env-var name for a config-dir key from the
 * instance id, so the wizard never needs to ask the user to invent one for
 * a value that isn't a secret — `id`, sanitized to `[A-Z0-9_]`, appended to
 * `key`. E.g. `('CLAUDE_CONFIG_DIR', 'claude-personal')` ->
 * `'CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL'`.
 */
export function deriveConfigDirVarName(key: string, id: string): string {
  const sanitizedId = id.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return `${key}_${sanitizedId}`;
}

/** Builds a `ProviderInstanceConfig` from collected wizard answers, trimming `id`/`displayName` and omitting `envMap` when empty. */
export function buildProviderInstanceConfig(
  kind: ProviderInstanceKind, id: string, displayName: string, envMap: Record<string, string>,
): ProviderInstanceConfig {
  return {
    id: id.trim(),
    kind,
    displayName: displayName.trim(),
    ...(Object.keys(envMap).length > 0 ? { envMap } : {}),
  };
}
