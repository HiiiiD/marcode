import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  buildProviderInstanceConfig, CONFIG_COPY_SUBDIRS, CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, SECRET_ENV_MAP_KEYS,
  isDuplicateInstanceId, resolveSourceConfigDir, supportsSkillsCopy,
} from '../shared/account-setup';
import {
  PROVIDER_INSTANCE_KINDS, validateProviderInstances,
  type EnvMapValue, type ProviderInstanceConfig, type ProviderInstanceKind,
} from '../shared/provider-instances';
import { PROVIDER_INSTANCES_SETTING } from '../shared/settings';
import { copySkillsAndPlugins } from './copy-skills-plugins';

/**
 * `Marcode: Set up a provider account` — a guided QuickPick/InputBox
 * sequence that appends one entry to `marcode.providerInstances` (user
 * settings) and, for claude/codex, offers to copy the main account's
 * skills/plugins into the new instance's own config dir. Any step the user
 * cancels (Esc) aborts the whole wizard with no write. See
 * docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export async function runAccountSetupWizard(baseIds: readonly string[]): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [...PROVIDER_INSTANCE_KINDS],
    { title: 'Set up a provider account (1/5): kind', placeHolder: 'Which backend is this instance?' },
  ) as ProviderInstanceKind | undefined;
  if (kind === undefined) { return; }

  const config = vscode.workspace.getConfiguration();
  const { valid: existing } = validateProviderInstances(
    config.get<unknown>(PROVIDER_INSTANCES_SETTING), baseIds,
  );

  const id = await vscode.window.showInputBox({
    title: 'Set up a provider account (2/5): id',
    prompt: 'Unique instance id, e.g. claude-personal',
    validateInput: (value) => {
      if (value.trim() === '') { return 'id is required'; }
      if (isDuplicateInstanceId(value, existing, baseIds)) { return `"${value.trim()}" is already in use`; }
      return undefined;
    },
  });
  if (id === undefined) { return; }

  const displayName = await vscode.window.showInputBox({
    title: 'Set up a provider account (3/5): display name',
    prompt: 'Shown in the roster and model picker in place of the base name',
    validateInput: (value) => (value.trim() === '' ? 'displayName is required' : undefined),
  });
  if (displayName === undefined) { return; }

  const selectedKeys = await vscode.window.showQuickPick(
    ENV_MAP_KEYS[kind].map((key) => ({ label: key })),
    {
      title: 'Set up a provider account (4/5): env vars',
      placeHolder: 'Which subprocess env vars does this instance set? (space to select, can be none)',
      canPickMany: true,
    },
  );
  if (selectedKeys === undefined) { return; }

  // The config-dir key (CLAUDE_CONFIG_DIR/CODEX_HOME) drives the optional
  // skills/plugins copy step below — it needs a literal target directory,
  // which only a `plain` answer (or an `env` answer whose OS var already
  // happens to be set in this VS Code process) can supply synchronously.
  // See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
  const configDirKey = supportsSkillsCopy(kind) ? CONFIG_DIR_ENV_KEY[kind] : undefined;
  const secretKeys = SECRET_ENV_MAP_KEYS[kind];
  const envMap: Record<string, EnvMapValue> = {};
  let configDirPath: string | undefined;
  for (const { label: key } of selectedKeys) {
    const entry = secretKeys.includes(key)
      ? await askEnvVarName(key)
      : await askPlainOrEnvValue(key, key === configDirKey);
    if (entry === undefined) { return; }
    envMap[key] = entry;
    if (key === configDirKey) {
      configDirPath = entry.type === 'plain' ? entry.value : process.env[entry.value];
    }
  }

  if (supportsSkillsCopy(kind)) {
    await maybeCopySkillsAndPlugins(kind, configDirPath, CONFIG_COPY_SUBDIRS[kind]);
  }

  // Only `env` entries need a manual OS-var-name reminder — a `plain`
  // entry's value is already written straight into settings.json below.
  const osVarNames = [...new Set(
    Object.values(envMap).filter((v) => v.type === 'env').map((v) => v.value),
  )];
  if (osVarNames.length > 0) {
    const loginCmd = kind === 'claude' ? 'claude login' : kind === 'codex' ? 'codex login' : undefined;
    const setSteps = osVarNames.map(
      (v) => (process.platform === 'win32' ? `\`setx ${v} "..."\`` : `\`export ${v}="..."\` (add it to your shell profile)`),
    );
    void vscode.window.showInformationMessage(
      `Next: ${setSteps.join(', ')}, then restart VS Code`
      + (loginCmd ? `, then sign in once with \`${loginCmd}\` in a shell that has ${osVarNames.join(', ')} set.` : '.'),
    );
  }

  const newEntry: ProviderInstanceConfig = buildProviderInstanceConfig(kind, id, displayName, envMap);
  try {
    // `existing` is the merged (workspace+user), *validated* array — correct
    // for the collision check above, but writing it back to Global would
    // (a) duplicate any workspace-scoped entries into user settings, where
    // an unmerged array is shadowed by the workspace value and never takes
    // effect, and (b) silently drop any malformed entry `existing` filtered
    // out. The write instead appends to the raw, unvalidated Global-scope
    // array, preserving anything already stored there as-is.
    const rawGlobal = config.inspect<ProviderInstanceConfig[]>(PROVIDER_INSTANCES_SETTING)?.globalValue ?? [];
    await config.update(
      PROVIDER_INSTANCES_SETTING, [...rawGlobal, newEntry], vscode.ConfigurationTarget.Global,
    );
    // extension.ts's existing onDidChangeConfiguration listener for
    // PROVIDER_INSTANCES_SETTING shows its own "Reload the window to apply
    // it." prompt in response to this update() — no second prompt here.
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not save the new provider instance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** True when any of `subdirs` under `targetDir` already exists and has at least one entry. Missing directories read as empty. */
async function hasExistingContent(targetDir: string, subdirs: readonly string[]): Promise<boolean> {
  for (const sub of subdirs) {
    try {
      const entries = await fs.readdir(path.join(targetDir, sub));
      if (entries.length > 0) { return true; }
    } catch {
      // ENOENT (or any other read failure) reads as "nothing here yet".
    }
  }
  return false;
}

/** Asks for the OS env var name that holds `key`'s secret value — never the value itself. `undefined` on cancel. */
async function askEnvVarName(key: string): Promise<EnvMapValue | undefined> {
  const osVarName = await vscode.window.showInputBox({
    title: `Set up a provider account (5/5): OS env var for ${key}`,
    prompt: `Name of the OS environment variable that holds ${key}'s value (not the value itself)`,
    validateInput: (value) => (value.trim() === '' ? 'required' : undefined),
  });
  return osVarName === undefined ? undefined : { type: 'env', value: osVarName.trim() };
}

/**
 * Asks whether `key` (non-secret) should be a literal value written into
 * settings.json, or sourced from an OS env var, then collects it.
 * `isConfigDirKey` swaps the plain-value prompt for the config-dir path
 * validation (absolute path, no shell metacharacters, no trailing
 * slash/backslash — this path may later be read back as a literal
 * directory by the skills/plugins copy step). `undefined` on cancel.
 */
async function askPlainOrEnvValue(key: string, isConfigDirKey: boolean): Promise<EnvMapValue | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Plain value', value: 'plain' as const },
      { label: 'OS env var name', value: 'env' as const },
    ],
    { title: `Set up a provider account (5/5): ${key}`, placeHolder: `Is ${key} a plain value, or read from an OS env var?` },
  );
  if (choice === undefined) { return undefined; }
  if (choice.value === 'env') { return askEnvVarName(key); }

  const value = await vscode.window.showInputBox({
    title: `Set up a provider account (5/5): ${key} value`,
    prompt: isConfigDirKey
      ? `Absolute directory path for this instance's own ${key} — a plain path, not a secret`
      : `Literal value for ${key} — not a secret, written into settings.json as-is`,
    validateInput: isConfigDirKey ? (value) => {
      const trimmed = value.trim();
      if (trimmed === '') { return 'required'; }
      if (!path.isAbsolute(trimmed)) { return 'must be an absolute path'; }
      if (/["`$&|^<>]/.test(trimmed)) { return 'must not contain " ` $ & | ^ < >'; }
      if (/[/\\]$/.test(trimmed)) { return 'must not end with a trailing slash'; }
      return undefined;
    } : (value) => (value.trim() === '' ? 'required' : undefined),
  });
  return value === undefined ? undefined : { type: 'plain', value: value.trim() };
}

/**
 * Offers and, if accepted, performs the skills/plugins copy. `targetDir` is
 * the literal directory path the user typed for this instance's config-dir
 * key — `undefined` means the kind supports the copy step but the user
 * never selected that envMap key, so there is nothing to copy into.
 * Warns (never throws) on any copy failure.
 */
async function maybeCopySkillsAndPlugins(
  kind: 'claude' | 'codex', targetDir: string | undefined, subdirs: readonly string[],
): Promise<void> {
  if (targetDir === undefined) { return; }

  const sourceDir = resolveSourceConfigDir(kind, process.env, os.homedir());
  const subdirsLabel = subdirs.join(', ');

  const choice = await vscode.window.showQuickPick(['Yes', 'No'], {
    title: `Copy ${subdirsLabel} from your main account?`,
    placeHolder: `Copies ${subdirsLabel} from ${sourceDir} to ${targetDir}`,
  });
  if (choice !== 'Yes') { return; }

  if (await hasExistingContent(targetDir, subdirs)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDir}'s ${subdirsLabel} directories already have files. `
      + 'Copying now will overwrite anything with the same name.',
      { modal: true },
      'Overwrite', 'Skip',
    );
    if (overwrite !== 'Overwrite') { return; }
  }

  try {
    const { copied } = await copySkillsAndPlugins(sourceDir, targetDir, subdirs);
    void vscode.window.showInformationMessage(
      copied.length > 0
        ? `Copied ${copied.join(', ')} from ${sourceDir} to ${targetDir}.`
        : `Nothing to copy: ${sourceDir} has none of ${subdirsLabel}.`,
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Could not copy ${subdirsLabel} from ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
