import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_COPIED_SUBDIRS = ['skills', 'plugins'] as const;

export interface CopySkillsAndPluginsResult {
  copied: string[];
}

/**
 * Copies each of `subdirs` (only) from `sourceDir` into `targetDir`,
 * recursively, skipping any subdirectory that doesn't exist at the source.
 * Never touches anything else under either directory — no
 * auth.json/credentials, config.toml/settings.json, sessions, or history —
 * the caller's `subdirs` list is the entire allow-list, not a starting
 * point. `targetDir` is expected to be a fresh/empty instance config dir,
 * so there is no merge case: whatever lands there is exactly what got
 * copied. Defaults to `DEFAULT_COPIED_SUBDIRS` (`skills/`+`plugins/`, the
 * two kinds share); a kind with more to carry over (e.g. claude's
 * `commands/`) passes its own list — see `CONFIG_COPY_SUBDIRS`.
 * See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export async function copySkillsAndPlugins(
  sourceDir: string, targetDir: string, subdirs: readonly string[] = DEFAULT_COPIED_SUBDIRS,
): Promise<CopySkillsAndPluginsResult> {
  const copied: string[] = [];
  for (const sub of subdirs) {
    const from = path.join(sourceDir, sub);
    let exists = true;
    try {
      await fs.access(from);
    } catch {
      exists = false;
    }
    if (!exists) { continue; }
    await fs.cp(from, path.join(targetDir, sub), { recursive: true });
    copied.push(sub);
  }
  return { copied };
}
