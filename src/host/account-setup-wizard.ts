import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  buildProviderInstanceConfig, CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, isDuplicateInstanceId,
  resolveSourceConfigDir, resolveUniqueConfigDirVarName, supportsSkillsCopy,
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

  // The config-dir key (CLAUDE_CONFIG_DIR/CODEX_HOME) is a plain directory
  // path, not a secret — unlike every other envMap key, it never needs the
  // user to invent an OS var name of their own. See docs/superpowers/specs/
  // 2026-09-01-account-setup-wizard-design.md.
  const configDirKey = supportsSkillsCopy(kind) ? CONFIG_DIR_ENV_KEY[kind] : undefined;
  // Every OS var name already claimed by an existing instance's envMap —
  // the config-dir key's derived name must never collide with one of
  // these, or two instances end up sharing a config dir at runtime.
  const usedVarNames = new Set(existing.flatMap((cfg) => Object.values(cfg.envMap ?? {})));
  const envMap: Record<string, string> = {};
  let configDirPath: string | undefined;
  let configDirVarName: string | undefined;
  for (const { label: key } of selectedKeys) {
    if (key === configDirKey) {
      const dirPath = await vscode.window.showInputBox({
        title: `Set up a provider account (5/5): ${key} directory`,
        prompt: `Absolute directory path for this instance's own ${key} — a plain path, not a secret`,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (trimmed === '') { return 'required'; }
          if (!path.isAbsolute(trimmed)) { return 'must be an absolute path'; }
          // This path is later interpolated into a `setx` command run in a
          // real terminal (Windows) — reject anything a shell would treat
          // specially, and a trailing slash/backslash, which would escape
          // the command's closing quote.
          if (/["`$&|^<>]/.test(trimmed)) { return 'must not contain " ` $ & | ^ < >'; }
          if (/[/\\]$/.test(trimmed)) { return 'must not end with a trailing slash'; }
          return undefined;
        },
      });
      if (dirPath === undefined) { return; }
      configDirPath = dirPath.trim();
      configDirVarName = resolveUniqueConfigDirVarName(key, id, usedVarNames);
      envMap[key] = configDirVarName;
      continue;
    }
    const osVarName = await vscode.window.showInputBox({
      title: `Set up a provider account (5/5): OS env var for ${key}`,
      prompt: `Name of the OS environment variable that holds ${key}'s value (not the value itself)`,
      validateInput: (value) => (value.trim() === '' ? 'required' : undefined),
    });
    if (osVarName === undefined) { return; }
    envMap[key] = osVarName.trim();
  }

  if (supportsSkillsCopy(kind)) {
    await maybeCopySkillsAndPlugins(kind, configDirPath);
  }

  const secretOsVarNames = [...new Set(
    Object.entries(envMap).filter(([key]) => key !== configDirKey).map(([, v]) => v),
  )];
  const manualSteps: string[] = [];
  if (configDirVarName !== undefined && configDirPath !== undefined) {
    if (process.platform === 'win32') {
      // setx persists across future shells/processes; unlike the manual
      // secret vars below, there's nothing sensitive here, so the wizard
      // can run it on the user's behalf instead of handing over a command
      // to retype.
      openSetxTerminal(configDirVarName, configDirPath);
      manualSteps.push(`${configDirVarName} is being set via the terminal that just opened`);
    } else {
      // A `terminal.sendText('export ...')` only affects that one terminal
      // session, not future shells — there's no POSIX equivalent of `setx`
      // this wizard can run unattended, so it stays a manual step here.
      manualSteps.push(`\`export ${configDirVarName}="${configDirPath}"\` (add it to your shell profile)`);
    }
  }
  for (const v of secretOsVarNames) {
    manualSteps.push(
      process.platform === 'win32' ? `\`setx ${v} "..."\`` : `\`export ${v}="..."\` (add it to your shell profile)`,
    );
  }
  if (manualSteps.length > 0) {
    const loginCmd = kind === 'claude' ? 'claude login' : kind === 'codex' ? 'codex login' : undefined;
    const allVarNames = [...new Set([
      ...(configDirVarName !== undefined ? [configDirVarName] : []), ...secretOsVarNames,
    ])];
    void vscode.window.showInformationMessage(
      `Next: ${manualSteps.join(', ')}, then restart VS Code`
      + (loginCmd ? `, then sign in once with \`${loginCmd}\` in a shell that has ${allVarNames.join(', ')} set.` : '.'),
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

/** True when `<targetDir>/skills` or `<targetDir>/plugins` already exists and has at least one entry. Missing directories read as empty. */
async function hasExistingContent(targetDir: string): Promise<boolean> {
  for (const sub of ['skills', 'plugins']) {
    try {
      const entries = await fs.readdir(path.join(targetDir, sub));
      if (entries.length > 0) { return true; }
    } catch {
      // ENOENT (or any other read failure) reads as "nothing here yet".
    }
  }
  return false;
}

/**
 * Opens a terminal that runs `setx VAR "value"` on the user's behalf.
 * Windows-only — `setx` persists to the registry for future
 * shells/processes; there is no POSIX equivalent this wizard can run
 * unattended (see the caller's comment).
 */
function openSetxTerminal(varName: string, value: string): void {
  const terminal = vscode.window.createTerminal({ name: `Set ${varName}` });
  terminal.show();
  terminal.sendText(`setx ${varName} "${value}"`);
}

/**
 * Offers and, if accepted, performs the skills/plugins copy. `targetDir` is
 * the literal directory path the user typed for this instance's config-dir
 * key — `undefined` means the kind supports the copy step but the user
 * never selected that envMap key, so there is nothing to copy into.
 * Warns (never throws) on any copy failure.
 */
async function maybeCopySkillsAndPlugins(
  kind: 'claude' | 'codex', targetDir: string | undefined,
): Promise<void> {
  if (targetDir === undefined) { return; }

  const sourceDir = resolveSourceConfigDir(kind, process.env, os.homedir());

  const choice = await vscode.window.showQuickPick(['Yes', 'No'], {
    title: 'Copy skills/plugins from your main account?',
    placeHolder: `Copies skills/ and plugins/ from ${sourceDir} to ${targetDir}`,
  });
  if (choice !== 'Yes') { return; }

  if (await hasExistingContent(targetDir)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDir}'s skills/ and/or plugins/ directory already has files. `
      + 'Copying now will overwrite anything with the same name.',
      { modal: true },
      'Overwrite', 'Skip',
    );
    if (overwrite !== 'Overwrite') { return; }
  }

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
