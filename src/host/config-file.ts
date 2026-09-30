import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic-file';
import { parseHostConfig, reloadSignature, type HostConfig } from './host-config';

export function configPath(home: string): string { return path.join(home, 'config.json'); }

async function readRaw(file: string): Promise<{ raw: Record<string, unknown> | undefined; warning?: string }> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { raw: undefined }; }
    return { raw: undefined, warning: `config.json could not be read (${(err as Error).message}); using the defaults.` };
  }
  if (text.trim() === '') { return { raw: undefined }; }
  try {
    const parsed: unknown = JSON.parse(text);
    return { raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { raw: undefined, warning: `config.json is not valid JSON (${(err as Error).message}); using the defaults.` };
  }
}

export async function loadConfig(file: string): Promise<{ config: HostConfig; warnings: string[]; raw: Record<string, unknown> }> {
  const { raw, warning } = await readRaw(file);
  const parsed = parseHostConfig(raw);
  return { config: parsed.config, warnings: warning ? [warning, ...parsed.warnings] : parsed.warnings, raw: raw ?? {} };
}

const LEGACY_TOP: Record<string, string> = {
  enabledProviders: 'enabledProviders', providerInstances: 'providerInstances', systemPrompts: 'systemPrompts',
  usageMirrors: 'usageMirrors', favoriteModels: 'favoriteModels', 'codex.path': 'codexPath', 'opencode.path': 'opencodePath',
};

export async function seedConfigFile(file: string, legacy: Record<string, unknown>): Promise<boolean> {
  try { await fs.access(file); return false; } catch { /* absent: seed it */ }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (value === undefined || value === '') { continue; }
    const top = LEGACY_TOP[key];
    if (top) { out[top] = value; continue; }
    const [group, leaf] = key.split('.');
    if (group === 'memory' || group === 'review') {
      const bucket = (out[group] ?? {}) as Record<string, unknown>;
      bucket[leaf] = value;
      out[group] = bucket;
    }
  }
  await writeFileAtomic(file, JSON.stringify(out, null, 2));
  return true;
}

export async function patchConfig(file: string, patch: Record<string, unknown>): Promise<void> {
  const { raw } = await readRaw(file);
  await writeFileAtomic(file, JSON.stringify({ ...(raw ?? {}), ...patch }, null, 2));
}

export function watchConfig(
  file: string, initial: HostConfig, onReloadNeeded: () => void, intervalMs = 1500,
): { dispose(): void } {
  const baseline = reloadSignature(initial);
  let fired = false;
  let busy = false;
  const timer = setInterval(() => {
    if (fired || busy) { return; }
    busy = true;
    void loadConfig(file).then(({ config }) => {
      if (reloadSignature(config) !== baseline) { fired = true; onReloadNeeded(); }
    }).catch(() => { /* a failed poll is retried */ }).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return { dispose: () => { clearInterval(timer); } };
}
