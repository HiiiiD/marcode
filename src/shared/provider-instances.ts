/**
 * Extra named instances of an existing provider kind, configured via
 * `marcode.providerInstances`. Pure — no `vscode` import — so `extension.ts`'s
 * validation, env resolution and login-command choice are unit-testable
 * without a real workspace configuration. See
 * docs/superpowers/specs/2026-08-31-provider-instances-design.md.
 */

export type ProviderInstanceKind = 'claude' | 'codex' | 'opencode';

export const PROVIDER_INSTANCE_KINDS: readonly ProviderInstanceKind[] = ['claude', 'codex', 'opencode'];

/** One entry of the `marcode.providerInstances` setting, once validated. */
export interface ProviderInstanceConfig {
  id: string;
  kind: ProviderInstanceKind;
  displayName: string;
  binPath?: string;
  envMap?: Record<string, string>;
}

export interface ProviderInstanceValidation {
  valid: ProviderInstanceConfig[];
  warnings: string[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }
  return Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Parses and validates the raw `marcode.providerInstances` setting value.
 *
 * An entry is dropped (and a warning recorded, never thrown) when: it isn't
 * an object, `kind` isn't one of `PROVIDER_INSTANCE_KINDS`, `id` or
 * `displayName` aren't non-empty strings, `id` collides with a base kind id
 * (`baseIds` — the ids already registered from `marcode.enabledProviders`),
 * or `id` repeats an earlier valid entry's id in this same array. Mirrors
 * `enabledProviderIds()`'s existing unknown-id posture in `extension.ts`.
 */
export function validateProviderInstances(
  configured: unknown,
  baseIds: readonly string[],
): ProviderInstanceValidation {
  const valid: ProviderInstanceConfig[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(configured)) {
    if (configured !== undefined) {
      warnings.push('marcode.providerInstances is not an array; ignoring it.');
    }
    return { valid, warnings };
  }
  const seenIds = new Set<string>(baseIds);
  for (const [index, entry] of configured.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`marcode.providerInstances[${index}] is not an object; skipping it.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const kind = record.kind;
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
    if (id === '') {
      warnings.push(`marcode.providerInstances[${index}] has no id; skipping it.`);
      continue;
    }
    if (typeof kind !== 'string' || !PROVIDER_INSTANCE_KINDS.includes(kind as ProviderInstanceKind)) {
      warnings.push(
        `marcode.providerInstances[${index}] ("${id}") has an unknown kind ${JSON.stringify(kind)}; skipping it.`,
      );
      continue;
    }
    if (displayName === '') {
      warnings.push(`marcode.providerInstances[${index}] ("${id}") has no displayName; skipping it.`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(
        `marcode.providerInstances[${index}]: id "${id}" collides with an existing provider id; skipping it.`,
      );
      continue;
    }
    const binPath = typeof record.binPath === 'string' && record.binPath.trim() !== ''
      ? record.binPath.trim() : undefined;
    const envMap = isStringRecord(record.envMap) ? record.envMap : undefined;
    seenIds.add(id);
    valid.push({
      id, kind: kind as ProviderInstanceKind, displayName,
      ...(binPath ? { binPath } : {}), ...(envMap ? { envMap } : {}),
    });
  }
  return { valid, warnings };
}

/**
 * Resolves an instance's `envMap` (subprocess var name -> OS var name to
 * read the value from) against the real OS environment into concrete
 * values. A referenced OS variable that is unset is simply omitted — not a
 * config-time error; it surfaces later as a normal auth failure.
 */
export function resolveEnvMap(
  envMap: Record<string, string> | undefined,
  osEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [subprocessVar, osVarName] of Object.entries(envMap ?? {})) {
    const value = osEnv[osVarName];
    if (value !== undefined) { resolved[subprocessVar] = value; }
  }
  return resolved;
}

export type LoginKind = 'oauth' | 'none';

/** Env vars whose presence means a claude instance is key/token-authenticated, not OAuth. */
const CLAUDE_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Whether an instance offers a terminal login flow at all.
 *
 * Claude: an API-key/auth-token instance has no login flow — a terminal
 * running `claude auth login` would write an OAuth session nobody reads and
 * would not fix the actual problem (a bad OS env var). Codex: always offers
 * one — even an `OPENAI_API_KEY` instance still has to persist that key into
 * its `CODEX_HOME/auth.json` via a login command, just a different one (see
 * `codexLoginCommand`). OpenCode: never offers one (matches today — no login
 * command exists for it). See the design doc's "Login and auth-failure UX"
 * section.
 */
export function computeLoginKind(
  kind: ProviderInstanceKind, resolvedEnv: Record<string, string>,
): LoginKind {
  if (kind === 'opencode') { return 'none'; }
  if (kind === 'claude' && CLAUDE_KEY_VARS.some((v) => resolvedEnv[v] !== undefined)) { return 'none'; }
  return 'oauth';
}

/** The terminal command that signs a claude instance in, given its resolved binPath. */
export function claudeLoginCommand(binPath: string | undefined): string {
  return `${binPath ?? 'claude'} auth login`;
}

/**
 * The terminal command that signs a codex instance in. When the instance's
 * resolved env carries `OPENAI_API_KEY`, the key is piped into
 * `codex login --with-api-key` so it lands in this instance's own
 * `CODEX_HOME/auth.json` — plain `codex login` would open a browser OAuth
 * flow instead and ignore the key entirely.
 */
export function codexLoginCommand(binPath: string | undefined, resolvedEnv: Record<string, string>): string {
  const bin = binPath ?? 'codex';
  return resolvedEnv.OPENAI_API_KEY !== undefined
    ? `printenv OPENAI_API_KEY | ${bin} login --with-api-key`
    : `${bin} login`;
}
