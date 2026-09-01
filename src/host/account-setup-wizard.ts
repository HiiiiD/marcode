import * as os from 'node:os';
import * as vscode from 'vscode';

import {
  CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, isDuplicateInstanceId, resolveSourceConfigDir,
  supportsSkillsCopy,
} from '../shared/account-setup';
import {
  PROVIDER_INSTANCE_KINDS, validateProviderInstances,
  type ProviderInstanceConfig, type ProviderInstanceKind,
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

  const envMap: Record<string, string> = {};
  for (const { label: key } of selectedKeys) {
    const osVarName = await vscode.window.showInputBox({
      title: `Set up a provider account (5/5): OS env var for ${key}`,
      prompt: `Name of the OS environment variable that holds ${key}'s value (not the value itself)`,
      validateInput: (value) => (value.trim() === '' ? 'required' : undefined),
    });
    if (osVarName === undefined) { return; }
    envMap[key] = osVarName.trim();
  }

  if (supportsSkillsCopy(kind)) {
    await maybeCopySkillsAndPlugins(kind, envMap);
  }

  const osVarNames = [...new Set(Object.values(envMap))];
  if (osVarNames.length > 0) {
    const loginCmd = kind === 'claude' ? 'claude login' : kind === 'codex' ? 'codex login' : undefined;
    void vscode.window.showInformationMessage(
      `Next: run ${osVarNames.map((v) => `\`setx ${v} "..."\``).join(' and ')} in a shell, restart VS Code`
      + (loginCmd ? `, then sign in once with \`${loginCmd}\` in a shell that has ${osVarNames.join(', ')} set.` : '.'),
    );
  }

  const newEntry: ProviderInstanceConfig = {
    id: id.trim(),
    kind,
    displayName: displayName.trim(),
    ...(Object.keys(envMap).length > 0 ? { envMap } : {}),
  };
  try {
    await config.update(
      PROVIDER_INSTANCES_SETTING, [...existing, newEntry], vscode.ConfigurationTarget.Global,
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

/**
 * Offers and, if accepted, performs the skills/plugins copy. Warns (never
 * throws) on any failure, including the common case where the OS env var
 * for this instance's config dir isn't set in this VS Code process yet —
 * `setx` only takes effect for shells/processes started after it runs, so a
 * brand new instance's config-dir var is normally still unset here.
 */
async function maybeCopySkillsAndPlugins(
  kind: 'claude' | 'codex', envMap: Record<string, string>,
): Promise<void> {
  const configDirOsVar = envMap[CONFIG_DIR_ENV_KEY[kind]];
  if (configDirOsVar === undefined) { return; }

  const choice = await vscode.window.showQuickPick(['Yes', 'No'], {
    title: 'Copy skills/plugins from your main account?',
    placeHolder: `Copies skills/ and plugins/ into this instance's ${CONFIG_DIR_ENV_KEY[kind]}`,
  });
  if (choice !== 'Yes') { return; }

  const targetDir = process.env[configDirOsVar];
  if (targetDir === undefined || targetDir.trim() === '') {
    void vscode.window.showWarningMessage(
      `Skipped copying skills/plugins: ${configDirOsVar} isn't set in this VS Code session yet. `
      + 'Set it, restart VS Code, then re-run this wizard or copy the files manually.',
    );
    return;
  }

  const sourceDir = resolveSourceConfigDir(kind, process.env, os.homedir());
  try {
    const { copied } = await copySkillsAndPlugins(sourceDir, targetDir);
    void vscode.window.showInformationMessage(
      copied.length > 0
        ? `Copied ${copied.join(', ')} from ${sourceDir} to ${targetDir}.`
        : `Nothing to copy: ${sourceDir} has no skills/ or plugins/ directory.`,
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Could not copy skills/plugins from ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
