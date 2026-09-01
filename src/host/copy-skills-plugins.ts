import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const COPIED_SUBDIRS = ['skills', 'plugins'] as const;

export interface CopySkillsAndPluginsResult {
  copied: string[];
}

/**
 * Copies `skills/` and `plugins/` (only) from `sourceDir` into `targetDir`,
 * recursively, skipping either subdirectory when it doesn't exist at the
 * source. Never touches anything else under either directory — no
 * auth.json/credentials, config.toml/settings.json, sessions, or history.
 * `targetDir` is expected to be a fresh/empty instance config dir, so there
 * is no merge case: whatever lands there is exactly what got copied.
 * See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export async function copySkillsAndPlugins(
  sourceDir: string, targetDir: string,
): Promise<CopySkillsAndPluginsResult> {
  const copied: string[] = [];
  for (const sub of COPIED_SUBDIRS) {
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
